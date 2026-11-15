// graphql.ts — the GitHub GraphQL v4 endpoint. A small hand-written parser and executor
// cover exactly the document shapes the suite sends (the ones gh and github-mcp-server
// send): queries and mutations with variables, aliases, inline fragments, batched
// operations, connections with cursors, and introspection of the types the checks name.
// Everything resolves against the same store REST and git use.

import {
  diffFlatTrees,
  flattenTree,
  globalId,
  parseGlobalId,
  mergeBase,
  nowIso,
  peelToCommit,
  store,
  treeOfCommit,
  VIEWER,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { forgeCreateIssue, forgeCreatePull, forgeMergePull, pullMergeable } from './rest.ts';

// ---------------------------------------------------------------- tokenizer

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'spread' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      at += 1;
      continue;
    }
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (source.startsWith('...', at)) {
      tokens.push({ kind: 'spread', value: '...' });
      at += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      at += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        const text = end < 0 ? source.slice(at + 3) : source.slice(at + 3, end);
        tokens.push({ kind: 'string', value: text });
        at = end < 0 ? source.length : end + 3;
        continue;
      }
      let text = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\' && at + 1 < source.length) {
          const escaped = source[at + 1] as string;
          const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' };
          if (escaped === 'u') {
            text += String.fromCharCode(parseInt(source.slice(at + 2, at + 6), 16));
            at += 6;
          } else {
            text += simple[escaped] ?? escaped;
            at += 2;
          }
        } else {
          text += source[at];
          at += 1;
        }
      }
      at += 1;
      tokens.push({ kind: 'string', value: text });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let end = at;
      while (end < source.length && /[0-9.eE+-]/.test(source[end] as string)) end += 1;
      tokens.push({ kind: 'number', value: source.slice(at, end) });
      at = end;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let end = at;
      while (end < source.length && /[_0-9A-Za-z]/.test(source[end] as string)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(at, end) });
      at = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Map<string, ValueNode>;
  directives: Map<string, Map<string, ValueNode>>;
  selectionSet?: SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition?: string; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private at = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.at] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.at] as Token;
    this.at += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${value}, found ${token.value}`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`unexpected token ${token.value} in document`);
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.atPunct('(')) this.parseVariableDefinitions();
        this.parseDirectives();
        operations.push({
          type: token.value === 'mutation' ? 'mutation' : 'query',
          name,
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        this.expectName('on');
        const typeCondition = this.next().value;
        this.parseDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      // Schema/type-system definitions are not part of the suite's documents; skip a
      // definition's braces if one ever appears rather than failing the whole document.
      this.skipDefinition();
    }
    return { operations, fragments };
  }

  private expectName(value: string): void {
    const token = this.next();
    if (token.kind !== 'name' || token.value !== value) throw new Error(`expected ${value}, found ${token.value}`);
  }

  private skipDefinition(): void {
    let depth = 0;
    while (this.peek().kind !== 'eof') {
      const token = this.next();
      if (token.value === '{') depth += 1;
      if (token.value === '}') {
        depth -= 1;
        if (depth <= 0) return;
      }
      if (depth === 0 && (this.peek().kind === 'name' || this.atPunct('{'))) return;
    }
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (!this.atPunct(')')) {
      this.expect('$');
      this.next(); // variable name
      this.expect(':');
      this.parseType();
      if (this.atPunct('=')) {
        this.next();
        this.parseValue();
      }
      this.parseDirectives();
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next(); // type name
    }
    if (this.atPunct('!')) this.next();
  }

  private parseDirectives(): Map<string, Map<string, ValueNode>> {
    const directives = new Map<string, Map<string, ValueNode>>();
    while (this.atPunct('@')) {
      this.next();
      const name = this.next().value;
      const args = this.atPunct('(') ? this.parseArguments() : new Map<string, ValueNode>();
      directives.set(name, args);
    }
    return directives;
  }

  private parseArguments(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    this.expect('(');
    while (!this.atPunct(')')) {
      const name = this.next().value;
      this.expect(':');
      args.set(name, this.parseValue());
    }
    this.expect(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$') {
      this.next();
      return { kind: 'variable', name: this.next().value };
    }
    if (token.kind === 'string') {
      this.next();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'number') {
      this.next();
      return { kind: 'number', value: Number(token.value) };
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.next();
      const fields = new Map<string, ValueNode>();
      while (!this.atPunct('}')) {
        const name = this.next().value;
        this.expect(':');
        fields.set(name, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      const token = this.peek();
      if (token.kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.next().value;
          const directives = this.parseDirectives();
          void directives;
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.next().value;
          this.parseDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      let name = this.next().value;
      let alias: string | undefined;
      if (this.atPunct(':')) {
        this.next();
        alias = name;
        name = this.next().value;
      }
      const args = this.atPunct('(') ? this.parseArguments() : new Map<string, ValueNode>();
      const directives = this.parseDirectives();
      const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : undefined;
      selections.push({ kind: 'field', alias, name, args, directives, selectionSet });
    }
    this.expect('}');
    return selections;
  }
}

// ---------------------------------------------------------------- values

type Variables = Record<string, unknown>;

function evalValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = evalValue(value, variables);
      return out;
    }
  }
}

function evalArgs(args: Map<string, ValueNode>, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of args) out[key] = evalValue(value, variables);
  return out;
}

// ---------------------------------------------------------------- object wrappers

interface Wrapped {
  __typename: string;
  [key: string]: unknown;
}

const wrap = (typename: string, data: Record<string, unknown>): Wrapped => ({ __typename: typename, ...data });

function userWrapped(): Wrapped {
  return wrap('User', {});
}

function repoWrapped(repo: RepoRec): Wrapped {
  return wrap('Repository', { repo });
}

function issueWrapped(repo: RepoRec, issue: IssueRec): Wrapped {
  return wrap('Issue', { repo, issue });
}

function pullWrapped(repo: RepoRec, pull: PullRec): Wrapped {
  return wrap('PullRequest', { repo, pull });
}

function commentWrapped(repo: RepoRec, number: number, comment: { id: number; body: string }): Wrapped {
  return wrap('IssueComment', { repo, number, comment });
}

function repoById(id: number): RepoRec | null {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return null;
}

/** Decode one of our global ids into the object it names, or null. */
function nodeFor(id: string): Wrapped | null {
  const typed = parseGlobalId(id);
  if (typed === null) return null;
  const [kind, ...rest] = typed.split(':');
  if (kind === 'repo') {
    const repo = repoById(Number(rest[0]));
    return repo === null ? null : repoWrapped(repo);
  }
  if (kind === 'user') return userWrapped();
  if (kind === 'issue' || kind === 'pr') {
    const repo = repoById(Number(rest[0]));
    if (repo === null) return null;
    const item = repo.items.get(Number(rest[1]));
    if (item === undefined) return null;
    if (kind === 'issue' && item.kind === 'issue') return issueWrapped(repo, item);
    if (kind === 'pr' && item.kind === 'pull') return pullWrapped(repo, item);
    return null;
  }
  if (kind === 'comment') {
    const repo = repoById(Number(rest[0]));
    if (repo === null) return null;
    const commentId = Number(rest[1]);
    for (const [number, comments] of repo.comments) {
      const found = comments.find((comment) => comment.id === commentId);
      if (found !== undefined) return commentWrapped(repo, number, found);
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- connections

interface Page<T> {
  items: T[];
  total: number;
  hasNext: boolean;
  endCursor: string | null;
}

/** Cursor-paginate an ordered list; a cursor names the seq of the last item served. */
function paginateBySeq<T extends { seq: number }>(ordered: T[], args: Record<string, unknown>): Page<T> {
  const first = typeof args.first === 'number' && args.first > 0 ? Math.floor(args.first) : 30;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    try {
      const decoded = Buffer.from(args.after, 'base64url').toString('utf8');
      const seq = Number(decoded.replace(/^cursor:/, ''));
      const index = ordered.findIndex((item) => item.seq === seq);
      if (index >= 0) start = index + 1;
    } catch {
      start = 0;
    }
  }
  const items = ordered.slice(start, start + first);
  const last = items[items.length - 1];
  return {
    items,
    total: ordered.length,
    hasNext: start + items.length < ordered.length,
    endCursor: last === undefined ? null : Buffer.from(`cursor:${last.seq}`, 'utf8').toString('base64url'),
  };
}

function pageInfoWrapped(page: { hasNext: boolean; endCursor: string | null }): Wrapped {
  return wrap('PageInfo', {
    hasNextPage: page.hasNext,
    hasPreviousPage: false,
    startCursor: page.endCursor,
    endCursor: page.endCursor,
  });
}

function issuesConnection(repo: RepoRec, args: Record<string, unknown>): Wrapped {
  let issues = [...repo.items.values()].filter((item): item is IssueRec => item.kind === 'issue');
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const ascending = typeof orderBy.direction === 'string' && orderBy.direction.toUpperCase() === 'ASC';
  issues.sort((a, b) => (ascending ? a.seq - b.seq : b.seq - a.seq));
  const page = paginateBySeq(issues, args);
  return wrap('IssueConnection', {
    nodes: page.items.map((issue) => issueWrapped(repo, issue)),
    pageInfo: pageInfoWrapped(page),
    totalCount: page.total,
  });
}

function pullsConnection(repo: RepoRec, args: Record<string, unknown>): Wrapped {
  let pulls = [...repo.items.values()].filter((item): item is PullRec => item.kind === 'pull');
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    pulls = pulls.filter((pull) => {
      const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      return wanted.has(state);
    });
  }
  pulls.sort((a, b) => b.seq - a.seq);
  const page = paginateBySeq(pulls, args);
  return wrap('PullRequestConnection', {
    nodes: page.items.map((pull) => pullWrapped(repo, pull)),
    pageInfo: pageInfoWrapped(page),
    totalCount: page.total,
  });
}

/** The merge-base diff file list for a pull request (paths only matter over GraphQL). */
function pullFiles(repo: RepoRec, pull: PullRec): Array<{ path: string }> {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return [];
  const headCommit = peelToCommit(headTip);
  const baseCommit = peelToCommit(baseTip);
  if (headCommit === null || baseCommit === null) return [];
  const ancestor = mergeBase(baseCommit, headCommit);
  const ancestorTree = ancestor === null ? null : treeOfCommit(ancestor);
  const headTree = treeOfCommit(headCommit);
  if (headTree === null) return [];
  const before = ancestorTree === null ? new Map<string, string>() : flattenTree(ancestorTree);
  const after = flattenTree(headTree);
  return diffFlatTrees(before, after).map((change) => ({ path: change.filename }));
}

function filesConnection(repo: RepoRec, pull: PullRec, args: Record<string, unknown>): Wrapped {
  const all = pullFiles(repo, pull).map((file, index) => ({ ...file, seq: index + 1 }));
  const page = paginateBySeq(all, args);
  return wrap('PullRequestFileConnection', {
    nodes: page.items.map((file) => wrap('PullRequestFile', { path: file.path })),
    pageInfo: pageInfoWrapped(page),
    totalCount: page.total,
  });
}

// ---------------------------------------------------------------- introspection data

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'url', 'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'url', 'createdAt', 'updatedAt', 'labels', 'comments'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'url', 'createdAt', 'updatedAt', 'mergeCommit',
  ],
  User: ['id', 'login', 'name', 'email', 'url'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['oid', 'message', 'messageHeadline', 'committedDate'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Label: ['id', 'name', 'color'],
});

const TYPE_ENUMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
});

// ---------------------------------------------------------------- resolvers

type Resolver = (source: Wrapped, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

interface ExecCtx {
  variables: Variables;
  fragments: DocumentNode['fragments'];
  errors: Array<{ message: string }>;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userWrapped(),
    repository: (_source, args) => {
      if (args.owner !== VIEWER.login || typeof args.name !== 'string') return null;
      const repo = store.repos.get(args.name);
      return repo === undefined ? null : repoWrapped(repo);
    },
    node: (_source, args) => (typeof args.id === 'string' ? nodeFor(args.id) : null),
    __type: (_source, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      if (TYPE_FIELDS[name] !== undefined || TYPE_ENUMS[name] !== undefined || name === 'String' || name === 'Int' || name === 'Boolean' || name === 'ID') {
        return wrap('__Type', { typeName: name });
      }
      return null;
    },
    __schema: () => wrap('__Schema', {}),
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? repoFromGlobalId(input.repositoryId) : null;
      if (repo === null) throw new Error('createIssue: repository not found');
      const created = forgeCreateIssue(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        labels: [],
      });
      if (!created.ok) throw new Error(created.message);
      void ctx;
      return wrap('CreateIssuePayload', { issue: issueWrapped(repo, created.issue), clientMutationId: input.clientMutationId ?? null });
    },
    closeIssue: (_source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.issueId === 'string' ? issueFromGlobalId(input.issueId) : null;
      if (found === null) throw new Error('closeIssue: issue not found');
      found.issue.state = 'closed';
      return wrap('CloseIssuePayload', { issue: issueWrapped(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null });
    },
    createPullRequest: (_source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? repoFromGlobalId(input.repositoryId) : null;
      if (repo === null) throw new Error('createPullRequest: repository not found');
      const created = forgeCreatePull(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head: typeof input.headRefName === 'string' ? input.headRefName : '',
        base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
      });
      if (!created.ok) throw new Error(created.message);
      return wrap('CreatePullRequestPayload', { pullRequest: pullWrapped(repo, created.pull), clientMutationId: input.clientMutationId ?? null });
    },
    mergePullRequest: (_source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.pullRequestId === 'string' ? pullFromGlobalId(input.pullRequestId) : null;
      if (found === null) throw new Error('mergePullRequest: pull request not found');
      const merged = forgeMergePull(found.repo, found.pull);
      if (!merged.ok) throw new Error(merged.message);
      return wrap('MergePullRequestPayload', { pullRequest: pullWrapped(found.repo, found.pull), clientMutationId: input.clientMutationId ?? null });
    },
    addComment: (_source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.subjectId === 'string' ? issueFromGlobalId(input.subjectId) : null;
      if (found === null) throw new Error('addComment: subject not found');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = { id: store.nextCommentId(), body };
      const list = found.repo.comments.get(found.issue.number) ?? [];
      list.push(comment);
      found.repo.comments.set(found.issue.number, list);
      const node = commentWrapped(found.repo, found.issue.number, comment);
      return wrap('AddCommentPayload', {
        commentEdge: wrap('IssueCommentEdge', { node, cursor: '' }),
        clientMutationId: input.clientMutationId ?? null,
      });
    },
  },
  Repository: {
    id: (source) => globalId(`repo:${(source.repo as RepoRec).id}`),
    databaseId: (source) => (source.repo as RepoRec).id,
    name: (source) => (source.repo as RepoRec).name,
    nameWithOwner: (source) => `${VIEWER.login}/${(source.repo as RepoRec).name}`,
    owner: () => userWrapped(),
    description: (source) => (source.repo as RepoRec).description,
    isPrivate: (source) => (source.repo as RepoRec).isPrivate,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    url: (source) => `https://forge.invalid/${VIEWER.login}/${(source.repo as RepoRec).name}`,
    createdAt: () => nowIso(),
    updatedAt: () => nowIso(),
    defaultBranchRef: (source) => {
      const repo = source.repo as RepoRec;
      if (!repo.refs.has(`refs/heads/${repo.defaultBranch}`)) return null;
      return wrap('Ref', { name: repo.defaultBranch, prefix: 'refs/heads/', repo });
    },
    issue: (source, args) => {
      const repo = source.repo as RepoRec;
      const item = repo.items.get(Number(args.number));
      return item !== undefined && item.kind === 'issue' ? issueWrapped(repo, item) : null;
    },
    issues: (source, args) => issuesConnection(source.repo as RepoRec, args),
    pullRequest: (source, args) => {
      const repo = source.repo as RepoRec;
      const item = repo.items.get(Number(args.number));
      return item !== undefined && item.kind === 'pull' ? pullWrapped(repo, item) : null;
    },
    pullRequests: (source, args) => pullsConnection(source.repo as RepoRec, args),
  },
  Issue: {
    id: (source) => globalId(`issue:${(source.repo as RepoRec).id}:${(source.issue as IssueRec).number}`),
    databaseId: (source) => (source.issue as IssueRec).id,
    number: (source) => (source.issue as IssueRec).number,
    title: (source) => (source.issue as IssueRec).title,
    body: (source) => (source.issue as IssueRec).body,
    state: (source) => ((source.issue as IssueRec).state === 'open' ? 'OPEN' : 'CLOSED'),
    author: () => userWrapped(),
    url: (source) => `https://forge.invalid/${VIEWER.login}/${(source.repo as RepoRec).name}/issues/${(source.issue as IssueRec).number}`,
    createdAt: () => nowIso(),
    updatedAt: () => nowIso(),
    labels: (source) => {
      const repo = source.repo as RepoRec;
      const issue = source.issue as IssueRec;
      return wrap('LabelConnection', {
        nodes: issue.labels.map((name) => wrap('Label', { name, color: repo.labels.get(name)?.color ?? 'ededed' })),
      });
    },
    comments: (source) => {
      const repo = source.repo as RepoRec;
      const issue = source.issue as IssueRec;
      const comments = (repo.comments.get(issue.number) ?? []).map((comment) => commentWrapped(repo, issue.number, comment));
      return wrap('IssueCommentConnection', { nodes: comments, totalCount: comments.length });
    },
  },
  PullRequest: {
    id: (source) => globalId(`pr:${(source.repo as RepoRec).id}:${(source.pull as PullRec).number}`),
    databaseId: (source) => (source.pull as PullRec).id,
    number: (source) => (source.pull as PullRec).number,
    title: (source) => (source.pull as PullRec).title,
    body: (source) => (source.pull as PullRec).body,
    state: (source) => {
      const pull = source.pull as PullRec;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (source) => (source.pull as PullRec).merged,
    mergeable: (source) => pullMergeable(source.repo as RepoRec, source.pull as PullRec),
    headRefName: (source) => (source.pull as PullRec).headRef,
    baseRefName: (source) => (source.pull as PullRec).baseRef,
    headRefOid: (source) => {
      const repo = source.repo as RepoRec;
      const pull = source.pull as PullRec;
      return repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
    },
    baseRefOid: (source) => {
      const repo = source.repo as RepoRec;
      const pull = source.pull as PullRec;
      return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
    },
    author: () => userWrapped(),
    url: (source) => `https://forge.invalid/${VIEWER.login}/${(source.repo as RepoRec).name}/pull/${(source.pull as PullRec).number}`,
    createdAt: () => nowIso(),
    updatedAt: () => nowIso(),
    mergeCommit: (source) => {
      const pull = source.pull as PullRec;
      return pull.mergeCommitSha === null ? null : wrap('Commit', { oid: pull.mergeCommitSha });
    },
    files: (source, args) => filesConnection(source.repo as RepoRec, source.pull as PullRec, args),
  },
  User: {
    id: () => globalId(`user:${VIEWER.id}`),
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    url: () => `https://forge.invalid/${VIEWER.login}`,
  },
  IssueComment: {
    id: (source) => globalId(`comment:${(source.repo as RepoRec).id}:${(source.comment as { id: number }).id}`),
    body: (source) => (source.comment as { body: string }).body,
    author: () => userWrapped(),
    createdAt: () => nowIso(),
    updatedAt: () => nowIso(),
  },
  Ref: {
    name: (source) => source.name as string,
    prefix: (source) => source.prefix as string,
    target: (source) => {
      const repo = source.repo as RepoRec;
      const oid = repo.refs.get(`refs/heads/${source.name as string}`);
      return oid === undefined ? null : wrap('Commit', { oid });
    },
  },
  Commit: {
    oid: (source) => source.oid as string,
    message: () => '',
    messageHeadline: () => '',
    committedDate: () => nowIso(),
  },
  PageInfo: {
    hasNextPage: (source) => source.hasNextPage as boolean,
    hasPreviousPage: (source) => source.hasPreviousPage as boolean,
    startCursor: (source) => source.startCursor as string | null,
    endCursor: (source) => source.endCursor as string | null,
  },
  Label: {
    id: (source) => globalId(`label:${source.name as string}`),
    name: (source) => source.name as string,
    color: (source) => source.color as string,
  },
  PullRequestFile: {
    path: (source) => source.path as string,
  },
  __Type: {
    name: (source) => source.typeName as string,
    kind: (source) => {
      const name = source.typeName as string;
      if (TYPE_ENUMS[name] !== undefined) return 'ENUM';
      if (name === 'String' || name === 'Int' || name === 'Boolean' || name === 'ID') return 'SCALAR';
      return 'OBJECT';
    },
    description: () => null,
    fields: (source) => {
      const fields = TYPE_FIELDS[source.typeName as string];
      if (fields === undefined) return null;
      return fields.map((name) => wrap('__Field', { fieldName: name }));
    },
    enumValues: (source) => {
      const values = TYPE_ENUMS[source.typeName as string];
      if (values === undefined) return null;
      return values.map((name) => wrap('__EnumValue', { enumName: name }));
    },
  },
  __Field: {
    name: (source) => source.fieldName as string,
    description: () => null,
  },
  __EnumValue: {
    name: (source) => source.enumName as string,
    description: () => null,
  },
  __Schema: {
    queryType: () => wrap('__Type', { typeName: 'Query' }),
    mutationType: () => wrap('__Type', { typeName: 'Mutation' }),
    subscriptionType: () => null,
  },
};

// Payload and connection types resolve their members straight off the wrapper.
for (const payloadType of ['CreateIssuePayload', 'CloseIssuePayload', 'CreatePullRequestPayload', 'MergePullRequestPayload', 'AddCommentPayload']) {
  RESOLVERS[payloadType] = {
    issue: (source) => source.issue as Wrapped,
    pullRequest: (source) => source.pullRequest as Wrapped,
    commentEdge: (source) => source.commentEdge as Wrapped,
    clientMutationId: (source) => (source.clientMutationId as string | null) ?? null,
  };
}
for (const connectionType of ['IssueConnection', 'PullRequestConnection', 'PullRequestFileConnection', 'IssueCommentConnection', 'LabelConnection']) {
  RESOLVERS[connectionType] = {
    nodes: (source) => source.nodes as Wrapped[],
    edges: (source) =>
      (source.nodes as Wrapped[]).map((node) => wrap('Edge', { node, cursor: '' })),
    pageInfo: (source) => source.pageInfo as Wrapped,
    totalCount: (source) => source.totalCount as number,
  };
}
RESOLVERS['IssueCommentEdge'] = {
  node: (source) => source.node as Wrapped,
  cursor: (source) => source.cursor as string,
};
RESOLVERS['Edge'] = {
  node: (source) => source.node as Wrapped,
  cursor: (source) => source.cursor as string,
};

function repoFromGlobalId(id: string): RepoRec | null {
  const typed = parseGlobalId(id);
  if (typed === null || !typed.startsWith('repo:')) return null;
  return repoById(Number(typed.slice('repo:'.length)));
}

function issueFromGlobalId(id: string): { repo: RepoRec; issue: IssueRec } | null {
  const typed = parseGlobalId(id);
  if (typed === null || !typed.startsWith('issue:')) return null;
  const [, repoId, number] = typed.split(':');
  const repo = repoById(Number(repoId));
  if (repo === null) return null;
  const item = repo.items.get(Number(number));
  return item !== undefined && item.kind === 'issue' ? { repo, issue: item } : null;
}

function pullFromGlobalId(id: string): { repo: RepoRec; pull: PullRec } | null {
  const typed = parseGlobalId(id);
  if (typed === null || !typed.startsWith('pr:')) return null;
  const [, repoId, number] = typed.split(':');
  const repo = repoById(Number(repoId));
  if (repo === null) return null;
  const item = repo.items.get(Number(number));
  return item !== undefined && item.kind === 'pull' ? { repo, pull: item } : null;
}

// ---------------------------------------------------------------- executor

function isWrapped(value: unknown): value is Wrapped {
  return typeof value === 'object' && value !== null && typeof (value as Wrapped).__typename === 'string';
}

function directiveAllows(directives: Map<string, Map<string, ValueNode>>, ctx: ExecCtx): boolean {
  for (const [name, args] of directives) {
    if (name === 'skip' || name === 'include') {
      const flag = evalValue(args.get('if') ?? { kind: 'boolean', value: false } as ValueNode, ctx.variables);
      if (name === 'skip' && flag === true) return false;
      if (name === 'include' && flag !== true) return false;
    }
  }
  return true;
}

function executeSelectionSet(typeName: string, source: Wrapped, selections: SelectionNode[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline' || selection.kind === 'spread') {
      const fragment = selection.kind === 'inline' ? selection : (() => {
        const found = ctx.fragments.get(selection.name);
        return found === undefined ? null : { typeCondition: found.typeCondition, selectionSet: found.selectionSet };
      })();
      if (fragment === null) continue;
      if (fragment.typeCondition !== source.__typename && fragment.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelectionSet(source.__typename, source, fragment.selectionSet, ctx));
      continue;
    }
    if (!directiveAllows(selection.directives, ctx)) continue;
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = source.__typename;
      continue;
    }
    const resolver = RESOLVERS[source.__typename]?.[selection.name] ?? RESOLVERS[typeName]?.[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${source.__typename}'` });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(source, evalArgs(selection.args, ctx.variables), ctx);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, selection, ctx);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (field.selectionSet === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => (isWrapped(entry) ? executeSelectionSet(entry.__typename, entry, field.selectionSet as SelectionNode[], ctx) : entry));
  }
  if (isWrapped(value)) return executeSelectionSet(value.__typename, value, field.selectionSet, ctx);
  return value;
}

/** Execute one GraphQL operation body ({query, variables, operationName}) to its result body. */
export function executeGraphql(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { errors: [{ message: 'GraphQL request body must be an object' }] };
  }
  const request = body as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof request.query !== 'string') {
    return { errors: [{ message: 'GraphQL query is required' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(request.query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const variables = (typeof request.variables === 'object' && request.variables !== null ? request.variables : {}) as Variables;
  const operation =
    document.operations.find((candidate) => candidate.name === request.operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const ctx: ExecCtx = { variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, wrap(rootType, {}), operation.selectionSet, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Execute a possibly-batched GraphQL request body (an array answers an array, in order). */
export function executeGraphqlBatch(body: unknown): unknown {
  if (Array.isArray(body)) return body.map((entry) => executeGraphql(entry));
  return executeGraphql(body);
}
