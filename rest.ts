// rest.ts — the GitHub REST v3 surface. Every handler returns a Reply (status, JSON body,
// headers) and app.ts writes it out; the domain operations the other surfaces share
// (creating issues and pull requests, merging) live here too, so REST, GraphQL and MCP
// can never disagree about what a create or a merge does.

import {
  commitOf,
  diffFlatTrees,
  flattenTree,
  isAncestor,
  makeCommit,
  mergeBase,
  mergeFlatTrees,
  nowIso,
  peelToCommit,
  resolveRef,
  store,
  treeOfCommit,
  VIEWER,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { parseTree, ZERO_OID } from './gitobj.ts';

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const notFound = (): Reply => ({ status: 404, body: { message: 'Not Found' } });
const unprocessable = (message: string): Reply => ({ status: 422, body: { message } });

// ---------------------------------------------------------------- serializers

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    owner: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.mergeCommitSha ?? ZERO_OID;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? ZERO_OID;
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${VIEWER.login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${VIEWER.login}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

export function itemJson(repo: RepoRec, number: number): Record<string, unknown> | null {
  const item = repo.items.get(number);
  if (item === undefined) return null;
  return item.kind === 'issue' ? issueJson(repo, item) : pullJson(repo, item);
}

// ---------------------------------------------------------------- shared domain operations

export type CreateIssueResult = { ok: true; issue: IssueRec } | { ok: false; message: string };

/** Create an issue: labels must already exist on the repo, as GitHub requires. */
export function forgeCreateIssue(
  repo: RepoRec,
  input: { title: string; body: string; labels: string[] },
): CreateIssueResult {
  for (const name of input.labels) {
    if (!repo.labels.has(name)) return { ok: false, message: `Validation Failed: label "${name}" does not exist` };
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: IssueRec = {
    kind: 'issue',
    id: store.nextItemId(),
    number,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: [...input.labels],
    seq: number,
  };
  repo.items.set(number, issue);
  return { ok: true, issue };
}

export type CreatePullResult = { ok: true; pull: PullRec } | { ok: false; message: string };

/** Normalize a head/base ref the way the API accepts it: strip refs/heads/ and owner: prefixes. */
export function normalizeBranch(ref: string): string {
  let out = ref.trim();
  if (out.startsWith('refs/heads/')) out = out.slice('refs/heads/'.length);
  const colon = out.indexOf(':');
  if (colon > 0 && !out.slice(0, colon).includes('/')) out = out.slice(colon + 1);
  return out;
}

/** Open a pull request between two existing branches of the repo. */
export function forgeCreatePull(
  repo: RepoRec,
  input: { title: string; body: string; head: string; base: string },
): CreatePullResult {
  const head = normalizeBranch(input.head);
  const base = normalizeBranch(input.base);
  if (!repo.refs.has(`refs/heads/${head}`)) return { ok: false, message: `Head ref "refs/heads/${head}" does not exist` };
  if (!repo.refs.has(`refs/heads/${base}`)) return { ok: false, message: `Base ref "refs/heads/${base}" does not exist` };
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: PullRec = {
    kind: 'pull',
    id: store.nextItemId(),
    number,
    title: input.title,
    body: input.body,
    state: 'open',
    headRef: head,
    baseRef: base,
    merged: false,
    mergeCommitSha: null,
    mergedAt: null,
    seq: number,
  };
  repo.items.set(number, pull);
  return { ok: true, pull };
}

export type MergeResult = { ok: true; sha: string } | { ok: false; conflict: boolean; message: string };

/**
 * Squash-merge an open pull request: one new commit on the base branch whose tree is the
 * three-way merge (merge base, base tip, head tip) at file granularity. A path both sides
 * changed differently conflicts and the whole merge is refused, as GitHub refuses it.
 */
export function forgeMergePull(repo: RepoRec, pull: PullRec): MergeResult {
  if (pull.state !== 'open') return { ok: false, conflict: false, message: 'Pull Request is not mergeable' };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) {
    return { ok: false, conflict: false, message: 'Pull Request is not mergeable' };
  }
  const baseCommit = peelToCommit(baseTip);
  const headCommit = peelToCommit(headTip);
  if (baseCommit === null || headCommit === null) {
    return { ok: false, conflict: false, message: 'Pull Request is not mergeable' };
  }
  const ancestor = mergeBase(baseCommit, headCommit);
  const baseTree = treeOfCommit(baseCommit);
  const headTree = treeOfCommit(headCommit);
  if (baseTree === null || headTree === null) {
    return { ok: false, conflict: false, message: 'Pull Request is not mergeable' };
  }
  const ancestorFlat = ancestor === null ? new Map<string, string>() : flattenTree(treeOfCommit(ancestor) ?? '');
  const merged = mergeFlatTrees(ancestorFlat, flattenTree(baseTree), flattenTree(headTree));
  if (!merged.ok) return { ok: false, conflict: true, message: 'Pull Request is not mergeable' };
  const message = pull.body.trim() === '' ? `${pull.title} (#${pull.number})` : `${pull.title} (#${pull.number})\n\n${pull.body}`;
  const sha = makeCommit(merged.merged, [baseCommit], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = nowIso();
  return { ok: true, sha };
}

/** Whether an open pull request's three-way merge is clean (GraphQL's mergeable). */
export function pullMergeable(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  const baseCommit = peelToCommit(baseTip);
  const headCommit = peelToCommit(headTip);
  if (baseCommit === null || headCommit === null) return 'UNKNOWN';
  const ancestor = mergeBase(baseCommit, headCommit);
  const baseTree = treeOfCommit(baseCommit);
  const headTree = treeOfCommit(headCommit);
  if (baseTree === null || headTree === null) return 'UNKNOWN';
  const ancestorFlat = ancestor === null ? new Map<string, string>() : flattenTree(treeOfCommit(ancestor) ?? '');
  const merged = mergeFlatTrees(ancestorFlat, flattenTree(baseTree), flattenTree(headTree));
  return merged.ok ? 'MERGEABLE' : 'CONFLICTING';
}

// ---------------------------------------------------------------- request context

export interface RestRequest {
  method: string;
  /** Decoded path segments after /api/v3 (empty for the API root). */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body, or undefined when there was none. */
  body: Record<string, unknown> | undefined;
  /** True when a body was present but did not parse as JSON. */
  malformed: boolean;
  /** This server's own origin, for absolute pagination links. */
  origin: string;
}

function bodyString(body: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = body?.[key];
  return typeof value === 'string' ? value : undefined;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

/** Slice a list by page/per_page and build the Link header value, when a next page exists. */
function paginate<T>(items: T[], query: URLSearchParams, urlForPage: (page: number) => string): { page: T[]; link?: string } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  if (page >= lastPage) return { page: slice };
  const link = `<${urlForPage(page + 1)}>; rel="next", <${urlForPage(lastPage)}>; rel="last"`;
  return { page: slice, link };
}

// ---------------------------------------------------------------- the router

export function routeRest(request: RestRequest): Reply {
  const { method, segments, query } = request;
  if (request.malformed && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
    return { status: 400, body: { message: 'Malformed JSON in request body' } };
  }

  // The API root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        current_user_url: `${request.origin}/api/v3/user`,
        rate_limit_url: `${request.origin}/api/v3/rate_limit`,
        repository_url: `${request.origin}/api/v3/repos/${VIEWER.login}/{name}`,
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return notFound();
    return { status: 200, body: { installed_version: '1.0.0', github_hostname: 'forge.invalid' } };
  }

  // The token's own user.
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return notFound();
    return { status: 200, body: { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' } };
  }
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const all = [...store.repos.values()].sort((a, b) => a.id - b.id);
      const { page, link } = paginate(all, query, (p) => {
        const { perPage } = pageParams(query);
        return `${request.origin}/api/v3/user/repos?page=${p}&per_page=${perPage}`;
      });
      return { status: 200, body: page.map(repoJson), headers: link === undefined ? {} : { link } };
    }
    if (method === 'POST') return createRepo(request);
    return notFound();
  }

  // Everything under /repos/{owner}/{repo}.
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    if (owner !== VIEWER.login) return notFound();
    const repo = store.repos.get(name);
    if (repo === undefined) return notFound();
    return routeRepo(request, repo, segments.slice(3));
  }

  return notFound();
}

function createRepo(request: RestRequest): Reply {
  const body = request.body ?? {};
  const name = bodyString(body, 'name');
  if (name === undefined || name === '') return unprocessable('Validation Failed: name is required');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return unprocessable('Validation Failed: name is invalid');
  const description = bodyString(body, 'description') ?? '';
  const isPrivate = body.private === true;
  const repo = store.createRepo(name, description, isPrivate);
  if (repo === null) return unprocessable('Repository creation failed: name already exists on this account');
  if (body.auto_init === true) {
    const readme = store.putObject('blob', Buffer.from(`# ${name}\n`, 'utf8'));
    const flat = new Map<string, string>([['README.md', readme]]);
    const commit = makeCommit(flat, [], 'Initial commit');
    repo.refs.set(`refs/heads/${repo.defaultBranch}`, commit);
  }
  return { status: 201, body: repoJson(repo) };
}

function routeRepo(request: RestRequest, repo: RepoRec, rest: string[]): Reply {
  const { method, query } = request;

  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      const description = bodyString(request.body, 'description');
      if (description !== undefined) repo.description = description;
      const name = bodyString(request.body, 'name');
      if (name !== undefined && name !== repo.name && !store.repos.has(name)) {
        store.repos.delete(repo.name);
        repo.name = name;
        store.repos.set(name, repo);
      }
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      store.repos.delete(repo.name);
      return { status: 204 };
    }
    return notFound();
  }

  const head = rest[0] as string;

  if (head === 'contents') return routeContents(request, repo, rest.slice(1).join('/'));
  if (head === 'git' && rest[1] === 'refs') return routeGitRefs(request, repo, rest.slice(2));
  if (head === 'branches') return routeBranches(request, repo, rest.slice(1).join('/'));
  if (head === 'commits' && rest.length === 1) {
    if (method !== 'GET') return notFound();
    return listCommits(request, repo);
  }
  if (head === 'labels' && rest.length === 1) return routeLabels(request, repo);
  if (head === 'issues') return routeIssues(request, repo, rest.slice(1));
  if (head === 'pulls') return routePulls(request, repo, rest.slice(1));

  return notFound();
}

// ---------------------------------------------------------------- contents

/** Walk a tree to the entry at `path`: a blob, a subtree, or null. */
function treeEntryAt(treeOid: string, path: string): { kind: 'file' | 'dir'; oid: string; size: number } | null {
  if (path === '') {
    const object = store.getObject(treeOid);
    return object === undefined ? null : { kind: 'dir', oid: treeOid, size: 0 };
  }
  const segments = path.split('/');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = store.getObject(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    const last = i === segments.length - 1;
    if (entry.mode === '40000') {
      if (last) return { kind: 'dir', oid: entry.oid, size: 0 };
      current = entry.oid;
    } else {
      if (!last) return null;
      const blob = store.getObject(entry.oid);
      return { kind: 'file', oid: entry.oid, size: blob?.data.length ?? 0 };
    }
  }
  return null;
}

function routeContents(request: RestRequest, repo: RepoRec, path: string): Reply {
  const { method } = request;
  const body = request.body ?? {};

  if (method === 'GET') {
    const ref = request.query.get('ref') ?? repo.defaultBranch;
    const commit = resolveRef(repo, ref);
    if (commit === null) return notFound();
    const tree = treeOfCommit(commit);
    if (tree === null) return notFound();
    const entry = treeEntryAt(tree, path);
    if (entry === null) return notFound();
    if (entry.kind === 'file') {
      const blob = store.getObject(entry.oid);
      if (blob === undefined) return notFound();
      const name = path.split('/').pop() ?? path;
      return {
        status: 200,
        body: {
          type: 'file',
          name,
          path,
          sha: entry.oid,
          size: blob.data.length,
          encoding: 'base64',
          content: blob.data.toString('base64'),
        },
      };
    }
    const subtree = store.getObject(entry.oid);
    if (subtree === undefined || subtree.type !== 'tree') return notFound();
    const entries = parseTree(subtree.data).map((child) => {
      const childPath = path === '' ? child.name : `${path}/${child.name}`;
      const isDir = child.mode === '40000';
      const blob = isDir ? undefined : store.getObject(child.oid);
      return {
        type: isDir ? 'dir' : 'file',
        name: child.name,
        path: childPath,
        sha: child.oid,
        size: isDir ? 0 : (blob?.data.length ?? 0),
      };
    });
    return { status: 200, body: entries };
  }

  if (method === 'PUT' || method === 'DELETE') {
    const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    const message = bodyString(body, 'message') ?? (method === 'PUT' ? 'Update file' : 'Delete file');
    let flat: Map<string, string>;
    let parents: string[];
    if (tip === undefined) {
      // An unborn default branch accepts the first commit; any other missing branch is a 404.
      if (method !== 'PUT' || branch !== repo.defaultBranch || repo.refs.size > 0) return notFound();
      flat = new Map();
      parents = [];
    } else {
      const tipCommit = peelToCommit(tip);
      const tipTree = tipCommit === null ? null : treeOfCommit(tipCommit);
      if (tipTree === null) return notFound();
      flat = flattenTree(tipTree);
      parents = [tipCommit as string];
    }
    const existing = flat.get(path);
    const givenSha = bodyString(body, 'sha');

    if (method === 'PUT') {
      const content = bodyString(body, 'content');
      if (content === undefined) return unprocessable('Validation Failed: content is required');
      if (givenSha !== undefined && givenSha !== existing) {
        return { status: 409, body: { message: 'sha does not match the current content' } };
      }
      const blobOid = store.putObject('blob', Buffer.from(content, 'base64'));
      flat.set(path, blobOid);
      const commit = makeCommit(flat, parents, message);
      repo.refs.set(refName, commit);
      const name = path.split('/').pop() ?? path;
      return {
        status: existing === undefined ? 201 : 200,
        body: {
          content: { name, path, sha: blobOid, size: Buffer.from(content, 'base64').length, type: 'file', encoding: 'base64' },
          commit: { sha: commit },
        },
      };
    }

    // DELETE
    if (existing === undefined) return notFound();
    if (givenSha !== undefined && givenSha !== existing) {
      return { status: 409, body: { message: 'sha does not match the current content' } };
    }
    flat.delete(path);
    const commit = makeCommit(flat, parents, message);
    repo.refs.set(refName, commit);
    return { status: 200, body: { content: null, commit: { sha: commit } } };
  }

  return notFound();
}

// ---------------------------------------------------------------- git refs and branches

function routeGitRefs(request: RestRequest, repo: RepoRec, rest: string[]): Reply {
  const { method } = request;
  if (method === 'POST' && rest.length === 0) {
    const body = request.body ?? {};
    const ref = bodyString(body, 'ref');
    const sha = bodyString(body, 'sha');
    if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
      return unprocessable('Validation Failed: ref and sha are required');
    }
    const object = store.getObject(sha.toLowerCase());
    if (object === undefined) return unprocessable('Validation Failed: sha does not exist');
    if (repo.refs.has(ref)) return unprocessable('Validation Failed: reference already exists');
    repo.refs.set(ref, sha.toLowerCase());
    return { status: 201, body: { ref, object: { sha: sha.toLowerCase(), type: object.type } } };
  }
  if (method === 'GET' && rest.length > 0) {
    const joined = rest.join('/');
    const full = joined.startsWith('refs/') ? joined : `refs/${joined}`;
    const oid = repo.refs.get(full);
    if (oid === undefined) return notFound();
    const object = store.getObject(oid);
    return { status: 200, body: { ref: full, object: { sha: oid, type: object?.type ?? 'commit' } } };
  }
  return notFound();
}

function routeBranches(request: RestRequest, repo: RepoRec, branchPath: string): Reply {
  if (request.method !== 'GET') return notFound();
  if (branchPath === '') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { status: 200, body: branches };
  }
  const oid = repo.refs.get(`refs/heads/${branchPath}`);
  if (oid === undefined) return notFound();
  return { status: 200, body: { name: branchPath, commit: { sha: oid }, protected: false } };
}

function listCommits(request: RestRequest, repo: RepoRec): Reply {
  const ref = request.query.get('sha') ?? repo.defaultBranch;
  const tip = resolveRef(repo, ref);
  if (tip === null) return { status: 200, body: [] };
  const { perPage } = pageParams(request.query);
  const out: Array<Record<string, unknown>> = [];
  let current: string | null = tip;
  const seen = new Set<string>();
  while (current !== null && out.length < perPage && !seen.has(current)) {
    seen.add(current);
    const commit = commitOf(current);
    if (commit === null) break;
    const author = parseIdentSafe(commit.author);
    const committer = parseIdentSafe(commit.committer);
    out.push({
      sha: current,
      commit: {
        message: commit.message,
        author: { name: author.name, email: author.email, date: new Date(author.epochSec * 1000).toISOString() },
        committer: { name: committer.name, email: committer.email, date: new Date(committer.epochSec * 1000).toISOString() },
        tree: { sha: commit.tree },
      },
      parents: commit.parents.map((parent) => ({ sha: parent })),
    });
    current = commit.parents[0] ?? null;
  }
  return { status: 200, body: out };
}

function parseIdentSafe(ident: string): { name: string; email: string; epochSec: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(ident.trim());
  if (match === null) return { name: ident.trim(), email: '', epochSec: 0 };
  return { name: match[1] ?? '', email: match[2] ?? '', epochSec: Number(match[3]) };
}

// ---------------------------------------------------------------- labels

function routeLabels(request: RestRequest, repo: RepoRec): Reply {
  if (request.method === 'GET') {
    const labels = [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color }));
    return { status: 200, body: labels };
  }
  if (request.method === 'POST') {
    const body = request.body ?? {};
    const name = bodyString(body, 'name');
    if (name === undefined || name === '') return unprocessable('Validation Failed: name is required');
    if (repo.labels.has(name)) return unprocessable('Validation Failed: label already exists');
    const color = (bodyString(body, 'color') ?? 'ededed').replace(/^#/, '');
    repo.labels.set(name, { name, color });
    return { status: 201, body: { name, color } };
  }
  return notFound();
}

// ---------------------------------------------------------------- issues

function labelNamesOf(body: Record<string, unknown> | undefined): string[] {
  const raw = body?.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

function routeIssues(request: RestRequest, repo: RepoRec, rest: string[]): Reply {
  const { method, query } = request;

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = request.body ?? {};
      const title = bodyString(body, 'title');
      if (title === undefined || title === '') return unprocessable('Validation Failed: title is required');
      const created = forgeCreateIssue(repo, {
        title,
        body: bodyString(body, 'body') ?? '',
        labels: labelNamesOf(body),
      });
      if (!created.ok) return unprocessable(created.message);
      return { status: 201, body: issueJson(repo, created.issue) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.items.values()].filter((item): item is IssueRec => item.kind === 'issue');
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { page } = paginate(issues, query, () => '');
      return { status: 200, body: page.map((issue) => issueJson(repo, issue)) };
    }
    return notFound();
  }

  const number = Number(rest[0]);
  if (!Number.isSafeInteger(number) || number < 1) return notFound();
  const item = repo.items.get(number);

  if (rest.length === 1) {
    if (item === undefined) return notFound();
    if (method === 'GET') {
      const json = itemJson(repo, number);
      return json === null ? notFound() : { status: 200, body: json };
    }
    if (method === 'PATCH') {
      if (item.kind !== 'issue') return notFound();
      const body = request.body ?? {};
      const state = bodyString(body, 'state');
      if (state === 'open' || state === 'closed') item.state = state;
      const title = bodyString(body, 'title');
      if (title !== undefined) item.title = title;
      const text = bodyString(body, 'body');
      if (text !== undefined) item.body = text;
      return { status: 200, body: issueJson(repo, item) };
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (item === undefined) return notFound();
    if (method === 'GET') {
      const comments = (repo.comments.get(number) ?? []).map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
        created_at: nowIso(),
        updated_at: nowIso(),
      }));
      return { status: 200, body: comments };
    }
    if (method === 'POST') {
      const text = bodyString(request.body, 'body');
      if (text === undefined) return unprocessable('Validation Failed: body is required');
      const comment = { id: store.nextCommentId(), body: text };
      const list = repo.comments.get(number) ?? [];
      list.push(comment);
      repo.comments.set(number, list);
      return {
        status: 201,
        body: { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, created_at: nowIso(), updated_at: nowIso() },
      };
    }
    return notFound();
  }

  return notFound();
}

// ---------------------------------------------------------------- pull requests

function routePulls(request: RestRequest, repo: RepoRec, rest: string[]): Reply {
  const { method, query } = request;

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = request.body ?? {};
      const title = bodyString(body, 'title');
      const head = bodyString(body, 'head');
      const base = bodyString(body, 'base');
      if (title === undefined || head === undefined || base === undefined) {
        return unprocessable('Validation Failed: title, head and base are required');
      }
      const created = forgeCreatePull(repo, { title, body: bodyString(body, 'body') ?? '', head, base });
      if (!created.ok) return unprocessable(created.message);
      return { status: 201, body: pullJson(repo, created.pull) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.items.values()].filter((item): item is PullRec => item.kind === 'pull');
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.seq - a.seq);
      const { page } = paginate(pulls, query, () => '');
      return { status: 200, body: page.map((pull) => pullJson(repo, pull)) };
    }
    return notFound();
  }

  const number = Number(rest[0]);
  if (!Number.isSafeInteger(number) || number < 1) return notFound();
  const item = repo.items.get(number);
  if (item === undefined || item.kind !== 'pull') return notFound();
  const pull = item;

  if (rest.length === 1) {
    if (method === 'GET') return { status: 200, body: pullJson(repo, pull) };
    if (method === 'PATCH') {
      const body = request.body ?? {};
      const state = bodyString(body, 'state');
      if (state === 'closed' && pull.state === 'open') pull.state = 'closed';
      if (state === 'open' && pull.state === 'closed' && !pull.merged) pull.state = 'open';
      const title = bodyString(body, 'title');
      if (title !== undefined) pull.title = title;
      const text = bodyString(body, 'body');
      if (text !== undefined) pull.body = text;
      return { status: 200, body: pullJson(repo, pull) };
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return { status: 200, body: [] };
    const headCommit = peelToCommit(headTip);
    const baseCommit = peelToCommit(baseTip);
    if (headCommit === null || baseCommit === null) return { status: 200, body: [] };
    const ancestor = mergeBase(baseCommit, headCommit);
    const ancestorTree = ancestor === null ? null : treeOfCommit(ancestor);
    const headTree = treeOfCommit(headCommit);
    if (headTree === null) return { status: 200, body: [] };
    const before = ancestorTree === null ? new Map<string, string>() : flattenTree(ancestorTree);
    const after = flattenTree(headTree);
    const files = diffFlatTrees(before, after).map((change) => ({
      filename: change.filename,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
      sha: after.get(change.filename) ?? before.get(change.filename) ?? ZERO_OID,
    }));
    const { page } = paginate(files, query, () => '');
    return { status: 200, body: page };
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const merged = forgeMergePull(repo, pull);
    if (!merged.ok) {
      return { status: 405, body: { message: merged.message, merged: false } };
    }
    return { status: 200, body: { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' } };
  }

  return notFound();
}
