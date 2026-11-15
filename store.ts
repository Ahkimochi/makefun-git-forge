// store.ts — the forge's single store and the domain operations every surface shares.
// One process, one in-memory world: git objects (content-addressed, shared across repos),
// repositories with their refs, labels, issues and pull requests. REST, GraphQL, MCP and
// the git protocol all read and write through here, so an object made on one surface is
// the same object on every other.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type ObjectType,
  type PackObjectInput,
  ZERO_OID,
} from './gitobj.ts';

/** The one user the trial's token names (the suite's fixed viewer). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The branch every repository is born expecting. */
export const DEFAULT_BRANCH = 'main';

/**
 * The trial's clock: MAKEFUN_TRIAL_NOW is the only "now" the forge may read, so two runs
 * of the same trial see the same timestamps. Accepts epoch seconds, epoch milliseconds or
 * an ISO string; falls back to a fixed epoch when unset or unparsable. Never Date.now().
 */
export function trialNowSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw.trim() !== '') {
    const text = raw.trim();
    if (/^\d+$/.test(text)) {
      const value = Number(text);
      return value > 1_000_000_000_000 ? Math.floor(value / 1000) : value;
    }
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return 1_700_000_000;
}

export function nowIso(): string {
  return new Date(trialNowSec() * 1000).toISOString();
}

/** The author/committer line forge-made commits carry. */
export function viewerIdent(): string {
  return `${VIEWER.login} <${VIEWER.email}> ${trialNowSec()} +0000`;
}

// ---------------------------------------------------------------- records

export interface LabelRec {
  name: string;
  color: string;
}

export interface IssueRec {
  kind: 'issue';
  /** Global numeric id (REST `id`), unique across repos. */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  /** Creation order inside the repo (the shared issue/PR sequence is `number`). */
  seq: number;
}

export interface PullRec {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  seq: number;
}

export type ItemRec = IssueRec | PullRec;

export interface CommentRec {
  id: number;
  body: string;
}

export interface RepoRec {
  /** Global numeric id, from 1 in creation order. */
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  /** Full ref name ("refs/heads/main") to the oid it points at. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  /** Issues and pull requests share one numbering sequence, as on GitHub. */
  items: Map<number, ItemRec>;
  nextNumber: number;
  comments: Map<number, CommentRec[]>;
}

// ---------------------------------------------------------------- the store

export class Store {
  /** Every git object the forge knows, by id. Content-addressed: shared across repos. */
  readonly objects = new Map<string, PackObjectInput>();
  /** Repositories by name (the token's owner is the only owner there is). */
  readonly repos = new Map<string, RepoRec>();
  private repoSeq = 0;
  private itemSeq = 0;
  private commentSeq = 0;

  /** Store an object and return its id (idempotent: the same bytes give the same id). */
  putObject(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): PackObjectInput | undefined {
    return this.objects.get(oid);
  }

  /** Create a repository record; null when the name is taken. */
  createRepo(name: string, description: string, isPrivate: boolean): RepoRec | null {
    if (this.repos.has(name)) return null;
    this.repoSeq += 1;
    const repo: RepoRec = {
      id: this.repoSeq,
      name,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      labels: new Map(),
      items: new Map(),
      nextNumber: 1,
      comments: new Map(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  nextItemId(): number {
    this.itemSeq += 1;
    return this.itemSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }
}

/** The one store the whole process serves. */
export const store = new Store();

// ---------------------------------------------------------------- refs and history

/** Resolve a ref-ish (branch name, full ref, HEAD, or oid) to a commit oid, or null. */
export function resolveRef(repo: RepoRec, ref: string): string | null {
  if (ref === 'HEAD') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  if (ref.startsWith('refs/')) {
    const oid = repo.refs.get(ref);
    return oid === undefined ? null : peelToCommit(oid);
  }
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return peelToCommit(branch);
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return peelToCommit(tag);
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const object = store.getObject(ref.toLowerCase());
    if (object !== undefined && object.type === 'commit') return ref.toLowerCase();
    if (object !== undefined && object.type === 'tag') return peelToCommit(ref.toLowerCase());
  }
  return null;
}

/** Follow tag objects until a commit (or something else) is reached. */
export function peelToCommit(oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.getObject(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** The commit record for an oid, or null when it is not a known commit. */
export function commitOf(oid: string) {
  const object = store.getObject(oid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

/** True when `ancestor` is `descendant` itself or reachable from it through parents. */
export function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const commit = commitOf(current);
    if (commit === null) continue;
    for (const parent of commit.parents) stack.push(parent);
  }
  return false;
}

/** Every commit reachable from `tip` (inclusive), as a set. */
export function reachableCommits(tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    const commit = commitOf(current);
    if (commit === null) continue;
    seen.add(current);
    for (const parent of commit.parents) stack.push(parent);
  }
  return seen;
}

/** Distances (in parent steps) from `tip` to every reachable commit; tip itself is 0. */
function commitDistances(tip: string): Map<string, number> {
  const distances = new Map<string, number>([[tip, 0]]);
  const queue = [tip];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const commit = commitOf(current);
    if (commit === null) continue;
    const depth = distances.get(current) ?? 0;
    for (const parent of commit.parents) {
      if (!distances.has(parent)) {
        distances.set(parent, depth + 1);
        queue.push(parent);
      }
    }
  }
  return distances;
}

/** The best common ancestor of two commits (the merge base), or null when unrelated. */
export function mergeBase(a: string, b: string): string | null {
  if (a === b) return a;
  const fromA = commitDistances(a);
  const fromB = commitDistances(b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, depthA] of fromA) {
    const depthB = fromB.get(oid);
    if (depthB === undefined) continue;
    const score = depthA + depthB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

// ---------------------------------------------------------------- trees as flat path maps

/** Flatten a tree object into path -> blob oid, recursing into subtrees. */
export function flattenTree(treeOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const object = store.getObject(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, entry.oid);
    }
  };
  walk(treeOid, '');
  return out;
}

/** The tree oid of a commit, or null. */
export function treeOfCommit(commitOid: string): string | null {
  const commit = commitOf(commitOid);
  return commit === null ? null : commit.tree;
}

/** Write a flat path -> blob oid map back into nested tree objects; returns the root tree oid. */
export function writeTreeFromFlat(flat: ReadonlyMap<string, string>): string {
  interface DirNode {
    files: Map<string, string>;
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let next = node.dirs.get(segment);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.set(segments[segments.length - 1] as string, oid);
  }
  const writeNode = (node: DirNode): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: writeNode(child) });
    return store.putObject('tree', buildTree(entries));
  };
  return writeNode(root);
}

/** The empty tree's oid (a tree with no entries), created on demand. */
export function emptyTreeOid(): string {
  return store.putObject('tree', buildTree([]));
}

/**
 * Make a commit on top of `parents` with the given flat file map and message, authored by
 * the viewer at the trial's "now". Returns the new commit oid.
 */
export function makeCommit(flat: ReadonlyMap<string, string>, parents: string[], message: string): string {
  const tree = writeTreeFromFlat(flat);
  const ident = viewerIdent();
  const data = buildCommit({ tree, parents, author: ident, committer: ident, message });
  return store.putObject('commit', data);
}

// ---------------------------------------------------------------- three-way file merge

export interface TreeMerge {
  ok: boolean;
  /** The merged flat map when ok; the first conflicting path otherwise. */
  merged: Map<string, string>;
  conflictPath: string | null;
}

/**
 * Merge two flat trees against their common base, file by file: a path changed on only
 * one side takes that side, a path changed identically on both takes either, anything
 * else (both changed differently, or changed versus deleted) conflicts.
 */
export function mergeFlatTrees(
  base: ReadonlyMap<string, string>,
  ours: ReadonlyMap<string, string>,
  theirs: ReadonlyMap<string, string>,
): TreeMerge {
  const merged = new Map<string, string>();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const o = base.get(path);
    const b = ours.get(path);
    const t = theirs.get(path);
    if (b === t) {
      if (b !== undefined) merged.set(path, b);
    } else if (o === b) {
      if (t !== undefined) merged.set(path, t);
    } else if (o === t) {
      if (b !== undefined) merged.set(path, b);
    } else {
      return { ok: false, merged: new Map(), conflictPath: path };
    }
  }
  return { ok: true, merged, conflictPath: null };
}

// ---------------------------------------------------------------- pull request diff and merge

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line counts of a blob (0 when the blob is missing); lines split on \n. */
function blobLines(oid: string | undefined): string[] {
  if (oid === undefined) return [];
  const object = store.getObject(oid);
  if (object === undefined || object.type !== 'blob') return [];
  const text = object.data.toString('utf8');
  if (text === '') return [];
  return text.split('\n');
}

/** Additions/deletions between two line arrays, by longest common subsequence. */
export function lineDiffCounts(before: readonly string[], after: readonly string[]): { additions: number; deletions: number } {
  const n = before.length;
  const m = after.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // LCS over rows, kept one-dimensional: files in this forge are small.
  const dp = new Array<number>(m + 1).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let diagonal = 0;
    for (let j = m - 1; j >= 0; j -= 1) {
      const saved = dp[j] ?? 0;
      if (before[i] === after[j]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j] ?? 0, dp[j + 1] ?? 0);
      diagonal = saved;
    }
  }
  const lcs = dp[0] ?? 0;
  return { additions: m - lcs, deletions: n - lcs };
}

/** The file-level diff between two flat trees (base side vs head side). */
export function diffFlatTrees(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const b = before.get(path);
    const a = after.get(path);
    if (b === a) continue;
    const counts = lineDiffCounts(blobLines(b), blobLines(a));
    changes.push({
      filename: path,
      status: b === undefined ? 'added' : a === undefined ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return changes;
}

// ---------------------------------------------------------------- GraphQL global ids

/** An opaque, stable global id: base64url of a typed string like "repo:5". */
export function globalId(typed: string): string {
  return Buffer.from(typed, 'utf8').toString('base64url');
}

/** Decode a global id back to its typed string, or null when it is not one of ours. */
export function parseGlobalId(id: string): string | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    return /^[a-z]+:/.test(text) ? text : null;
  } catch {
    return null;
  }
}

export { ZERO_OID };
