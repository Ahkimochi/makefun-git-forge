// githttp.ts — git smart HTTP: the advertisement, ls-refs, fetch (protocol v2 with a v0
// fallback) and receive-pack (v0). The forge speaks the wire protocol itself, in process:
// pkt-lines, sideband framing and packfiles, all over the one store REST writes to.

import {
  commitOf,
  isAncestor,
  peelToCommit,
  reachableCommits,
  store,
  VIEWER,
  type RepoRec,
} from './store.ts';
import {
  parseTag,
  parseTree,
  pktFlush,
  pktLine,
  readPack,
  readPktLines,
  writePack,
  ZERO_OID,
  type PackObjectInput,
} from './gitobj.ts';

export interface GitRequest {
  method: string;
  owner: string;
  repoName: string;
  /** 'info/refs', 'git-upload-pack' or 'git-receive-pack'. */
  tail: string;
  query: URLSearchParams;
  /** The Git-Protocol header's version parameter, when the client sent one. */
  protocolVersion: number | null;
  body: Buffer;
}

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge/1.0.0';

function gitNotFound(): GitReply {
  return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('not found\n') };
}

/** Refs in wire order: lexicographic by ref name, as git lists them. */
function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Follow a tag chain to the first non-tag object (what a peeled line names). */
function peelFully(oid: string): string {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.getObject(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

export function routeGit(request: GitRequest): GitReply {
  if (request.owner !== VIEWER.login) return gitNotFound();
  const repo = store.repos.get(request.repoName);
  if (repo === undefined) return gitNotFound();

  if (request.tail === 'info/refs' && request.method === 'GET') {
    const service = request.query.get('service');
    if (service === 'git-upload-pack') {
      if (request.protocolVersion === 2) {
        return {
          status: 200,
          contentType: 'application/x-git-upload-pack-advertisement',
          body: advertiseV2(),
        };
      }
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-advertisement',
        body: advertiseV0(repo, 'git-upload-pack'),
      };
    }
    if (service === 'git-receive-pack') {
      return {
        status: 200,
        contentType: 'application/x-git-receive-pack-advertisement',
        body: advertiseV0(repo, 'git-receive-pack'),
      };
    }
    return gitNotFound();
  }

  if (request.tail === 'git-upload-pack' && request.method === 'POST') {
    return uploadPack(repo, request);
  }
  if (request.tail === 'git-receive-pack' && request.method === 'POST') {
    return receivePack(repo, request);
  }
  return gitNotFound();
}

// ---------------------------------------------------------------- advertisements

function advertiseV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2'),
    pktLine(`agent=${AGENT}`),
    pktLine('ls-refs=unborn'),
    pktLine('fetch=shallow'),
    pktLine('object-format=sha1'),
    pktFlush(),
  ]);
}

function advertiseV0(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const defaultOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    parts.push(pktLine(`${defaultOid ?? ZERO_OID} HEAD\0${caps}`));
    for (const [ref, oid] of refs) {
      parts.push(pktLine(`${oid} ${ref}`));
      const object = store.getObject(oid);
      if (object !== undefined && object.type === 'tag') {
        parts.push(pktLine(`${peelFully(oid)} ${ref}^{}`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs (v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefs(repo: RepoRec, args: LsRefsArgs): Buffer {
  const lines: Buffer[] = [];
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultOid = repo.refs.get(defaultRef);

  if (matches('HEAD')) {
    if (defaultOid !== undefined) {
      let line = `${defaultOid} HEAD`;
      if (args.symrefs) line += ` symref-target:${defaultRef}`;
      lines.push(pktLine(line));
    } else if (args.unborn) {
      let line = 'unborn HEAD';
      if (args.symrefs) line += ` symref-target:${defaultRef}`;
      lines.push(pktLine(line));
    } else {
      let line = `${ZERO_OID} HEAD`;
      if (args.symrefs) line += ` symref-target:${defaultRef}`;
      lines.push(pktLine(line));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (args.peel) {
      const object = store.getObject(oid);
      if (object !== undefined && object.type === 'tag') line += ` peeled:${peelFully(oid)}`;
    }
    lines.push(pktLine(line));
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------- fetch: object selection

interface FetchPlan {
  /** Commits to send (the include set). */
  include: Set<string>;
  /** Tag objects to send alongside. */
  tagObjects: string[];
  /**
   * Objects the client already holds (its commits and their whole tree closures):
   * a fetch must not re-send any of them, not even an unchanged blob in a new tree.
   */
  exclude: Set<string>;
  /** The new shallow boundary to report. */
  boundary: Set<string>;
  /** Client shallow commits that stop being boundary. */
  unshallow: Set<string>;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen?: number;
  deepenSince?: number;
  wantRefs: string[];
  done: boolean;
}

/**
 * Work out what a fetch sends. The client-has set is everything reachable from its haves,
 * minus what lies strictly below the shallow boundary it declares. The include set walks
 * from the wants: without a depth it stops at what the client has; with `deepen N` it
 * counts commit distance from the wants (want = 1) and walks through client-held commits
 * without resending them. The boundary is every commit in has∪include with a parent
 * outside it — the shallow line the client must record.
 */
function planFetch(repo: RepoRec, args: FetchArgs): FetchPlan {
  const shallowSet = new Set(args.shallow.map((oid) => oid.toLowerCase()));
  const clientHas = new Set<string>();
  for (const have of args.haves) {
    const commit = peelToCommit(have.toLowerCase());
    if (commit !== null) for (const oid of reachableCommits(commit)) clientHas.add(oid);
  }
  for (const boundary of shallowSet) {
    const commit = commitOf(boundary);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      for (const oid of reachableCommits(parent)) clientHas.delete(oid);
    }
  }

  const include = new Set<string>();
  const tagObjects: string[] = [];
  const starts: string[] = [];
  for (const want of args.wants) {
    const oid = want.toLowerCase();
    const object = store.getObject(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagObjects.push(oid);
      const target = peelToCommit(oid);
      if (target !== null) starts.push(target);
    } else if (object.type === 'commit') {
      starts.push(oid);
    }
  }
  for (const ref of args.wantRefs) {
    const oid = repo.refs.get(ref);
    if (oid !== undefined) {
      const target = peelToCommit(oid);
      if (target !== null) starts.push(target);
      const object = store.getObject(oid);
      if (object !== undefined && object.type === 'tag') tagObjects.push(oid);
    }
  }

  const deepen = args.deepen;
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const start of starts) {
    if (!distance.has(start)) {
      distance.set(start, 1);
      queue.push(start);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const dist = distance.get(current) ?? 1;
    const held = clientHas.has(current) || shallowSet.has(current);
    if (args.deepenSince !== undefined) {
      // Depth by time: include what is new enough, walk everything to find the edge.
      const commit = commitOf(current);
      if (commit !== null) {
        if (!clientHas.has(current)) {
          const stamp = / (\d+) [+-]\d{4}/.exec(commit.committer);
          const when = stamp ? Number(stamp[1]) : 0;
          if (when >= args.deepenSince) include.add(current);
        }
        for (const parent of commit.parents) {
          if (!distance.has(parent)) {
            distance.set(parent, dist + 1);
            queue.push(parent);
          }
        }
      }
    } else if (deepen === undefined) {
      if (!held) {
        include.add(current);
        const commit = commitOf(current);
        if (commit !== null) {
          for (const parent of commit.parents) {
            if (!distance.has(parent)) {
              distance.set(parent, dist + 1);
              queue.push(parent);
            }
          }
        }
      }
    } else {
      if (!clientHas.has(current) && dist <= deepen) include.add(current);
      if (dist < deepen) {
        const commit = commitOf(current);
        if (commit !== null) {
          for (const parent of commit.parents) {
            if (!distance.has(parent)) {
              distance.set(parent, dist + 1);
              queue.push(parent);
            }
          }
        }
      }
    }
  }
  if (args.deepenSince !== undefined) {
    // With a time depth the walk above visited everything reachable; inclusion is by stamp.
  }

  const union = new Set<string>([...clientHas, ...include]);
  const boundary = new Set<string>();
  for (const oid of union) {
    const commit = commitOf(oid);
    if (commit === null) continue;
    if (commit.parents.some((parent) => !union.has(parent))) boundary.add(oid);
  }
  const unshallow = new Set<string>();
  for (const oid of shallowSet) {
    if (!boundary.has(oid) && union.has(oid)) unshallow.add(oid);
  }

  // Everything the client holds, at object granularity: its commits plus every tree and
  // blob in their closures (trees shared between commits are walked once).
  const exclude = new Set<string>();
  const excludeTree = (treeOid: string): void => {
    if (exclude.has(treeOid)) return;
    const tree = store.getObject(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    exclude.add(treeOid);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') excludeTree(entry.oid);
      else exclude.add(entry.oid);
    }
  };
  for (const oid of clientHas) {
    exclude.add(oid);
    const commit = commitOf(oid);
    if (commit !== null) excludeTree(commit.tree);
  }
  return { include, tagObjects, exclude, boundary, unshallow };
}

/** Collect the pack objects for a plan: the included commits and their trees, minus held objects. */
function packObjectsFor(plan: FetchPlan): PackObjectInput[] {
  const commits: PackObjectInput[] = [];
  const rest = new Map<string, PackObjectInput>();
  const addTree = (treeOid: string): void => {
    if (rest.has(treeOid) || plan.exclude.has(treeOid)) return;
    const tree = store.getObject(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    rest.set(treeOid, tree);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') addTree(entry.oid);
      else if (!rest.has(entry.oid) && !plan.exclude.has(entry.oid)) {
        const blob = store.getObject(entry.oid);
        if (blob !== undefined) rest.set(entry.oid, blob);
      }
    }
  };
  for (const oid of plan.include) {
    const commit = store.getObject(oid);
    if (commit === undefined) continue;
    commits.push(commit);
    const info = commitOf(oid);
    if (info !== null) addTree(info.tree);
  }
  const tags: PackObjectInput[] = [];
  for (const oid of plan.tagObjects) {
    const tag = store.getObject(oid);
    if (tag !== undefined && !commits.includes(tag) && !rest.has(oid)) tags.push(tag);
  }
  const others = [...rest.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, object]) => object);
  return [...tags, ...commits, ...others];
}

/** Frame pack bytes as sideband band-1 packets (with the odd progress note suppressed). */
function sidebandPack(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const maxChunk = 65_000;
  for (let at = 0; at < pack.length; at += maxChunk) {
    const chunk = pack.subarray(at, at + maxChunk);
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

// ---------------------------------------------------------------- upload-pack

function uploadPack(repo: RepoRec, request: GitRequest): GitReply {
  const body = request.body;
  const first = readPktLines(body, 0);
  const firstLine = first.lines[0]?.toString('utf8') ?? '';

  if (firstLine.startsWith('command=ls-refs')) {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    // Arguments follow the delimiter packet (or the command line, in a delim-less request).
    const argLines = first.delimited ? readPktLines(body, first.consumed).lines : first.lines.slice(1);
    for (const raw of argLines) {
      const line = raw.toString('utf8').trimEnd();
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, args) };
  }

  if (firstLine.startsWith('command=fetch')) {
    const args: FetchArgs = { wants: [], haves: [], shallow: [], wantRefs: [], done: false };
    const argLines = first.delimited ? readPktLines(body, first.consumed).lines : first.lines.slice(1);
    for (const raw of argLines) parseFetchArg(args, raw.toString('utf8').trimEnd());
    return fetchV2(repo, args);
  }

  // Protocol v0: wants and shallow/deepen lines, flush, haves and done, flush.
  return fetchV0(repo, body);
}

function parseFetchArg(args: FetchArgs, line: string): void {
  // A v0 first want line carries its capabilities after the oid, space-separated.
  if (line.startsWith('want ')) args.wants.push((line.slice(5).trim().split(' ')[0] as string));
  else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
  else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
  else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim()) || undefined;
  else if (line.startsWith('deepen-since ')) args.deepenSince = Number(line.slice(13).trim()) || undefined;
  else if (line.startsWith('want-ref ')) args.wantRefs.push(line.slice(9).trim());
  else if (line === 'done') args.done = true;
}

function fetchV2(repo: RepoRec, args: FetchArgs): GitReply {
  const parts: Buffer[] = [];
  if (!args.done) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK'), pktFlush());
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  const plan = planFetch(repo, args);
  const shallowLines: Buffer[] = [];
  for (const oid of [...plan.boundary].sort()) shallowLines.push(pktLine(`shallow ${oid}`));
  for (const oid of [...plan.unshallow].sort()) shallowLines.push(pktLine(`unshallow ${oid}`));
  if (shallowLines.length > 0 || args.shallow.length > 0 || args.deepen !== undefined || args.deepenSince !== undefined) {
    parts.push(pktLine('shallow-info\n'), ...shallowLines, pktFlush());
  }
  if (args.wantRefs.length > 0) {
    const refLines: Buffer[] = [];
    for (const ref of args.wantRefs) {
      const oid = repo.refs.get(ref);
      if (oid !== undefined) refLines.push(pktLine(`${oid} ${ref}`));
    }
    if (refLines.length > 0) parts.push(pktLine('wanted-refs\n'), ...refLines, pktFlush());
  }
  const pack = writePack(packObjectsFor(plan));
  parts.push(pktLine('packfile\n'), ...sidebandPack(pack), pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function fetchV0(repo: RepoRec, body: Buffer): GitReply {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], wantRefs: [], done: false };
  let caps = '';
  const first = readPktLines(body, 0);
  for (const raw of first.lines) {
    const line = raw.toString('utf8');
    const nul = line.indexOf('\0');
    const clean = (nul >= 0 ? line.slice(0, nul) : line).trimEnd();
    if (nul >= 0) caps = line.slice(nul + 1);
    // v0 puts the negotiated capabilities after the first want's oid, space-separated.
    if (clean.startsWith('want ')) {
      const tokens = clean.split(' ');
      if (tokens.length > 2) caps = tokens.slice(2).join(' ');
    }
    parseFetchArg(args, clean);
  }
  const second = readPktLines(body, first.consumed);
  for (const raw of second.lines) parseFetchArg(args, raw.toString('utf8').trimEnd());

  const plan = planFetch(repo, args);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of [...plan.boundary].sort()) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of [...plan.unshallow].sort()) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = writePack(packObjectsFor(plan));
  if (caps.includes('side-band-64k') || caps.includes('side-band')) {
    parts.push(...sidebandPack(pack), pktFlush());
  } else {
    parts.push(pktFlush(), pack);
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: RepoRec, request: GitRequest): GitReply {
  const body = request.body;
  const first = readPktLines(body, 0);
  const commands: PushCommand[] = [];
  let caps = '';
  for (const raw of first.lines) {
    const line = raw.toString('utf8');
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    if (nul >= 0) caps = line.slice(nul + 1);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(clean.trim());
    if (match !== null) {
      commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
    }
  }
  const rest = body.subarray(first.consumed);

  // No well-formed command list: a garbled push. Answer plainly and stay up.
  if (commands.length === 0) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  }

  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const pack = readPack(rest, 0, (oid) => store.getObject(oid));
      for (const [oid, object] of pack.objects) {
        if (!store.objects.has(oid)) store.objects.set(oid, object);
      }
    } catch (error) {
      unpackDetail = `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const reportLines: string[] = [`unpack ${unpackDetail}`];
  for (const command of commands) {
    reportLines.push(applyPushCommand(repo, command, unpackDetail === 'ok'));
  }

  if (!caps.includes('report-status')) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  }
  const reportStream = Buffer.concat([
    ...reportLines.map((line) => pktLine(`${line}\n`)),
    pktFlush(),
  ]);
  if (caps.includes('side-band-64k') || caps.includes('side-band')) {
    const packets: Buffer[] = [];
    const maxChunk = 65_000;
    for (let at = 0; at < reportStream.length; at += maxChunk) {
      packets.push(pktLine(Buffer.concat([Buffer.from([1]), reportStream.subarray(at, at + maxChunk)])));
    }
    packets.push(pktFlush());
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(packets) };
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: reportStream };
}

/** Apply one ref update; returns its report-status line. */
function applyPushCommand(repo: RepoRec, command: PushCommand, unpackOk: boolean): string {
  const { oldOid, newOid, ref } = command;
  if (!unpackOk) return `ng ${ref} unpack failed`;
  if (!ref.startsWith('refs/') || ref.includes('..') || ref.includes(' ')) return `ng ${ref} invalid refname`;
  const current = repo.refs.get(ref);

  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return `ng ${ref} reference does not exist`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  const object = store.getObject(newOid);
  if (object === undefined) return `ng ${ref} missing object`;
  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return `ng ${ref} reference already exists`;
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  // Update: the ref must sit where the pusher thinks it sits, and move forward only.
  if (current !== oldOid) return `ng ${ref} reference was at ${current ?? ZERO_OID} but expected ${oldOid}`;
  if (current === newOid) return `ok ${ref}`;
  const oldCommit = peelToCommit(oldOid);
  const newCommit = peelToCommit(newOid);
  if (oldCommit === null || newCommit === null || !isAncestor(oldCommit, newCommit)) {
    return `ng ${ref} non-fast-forward`;
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}
