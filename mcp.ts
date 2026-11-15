// mcp.ts — the Model Context Protocol endpoint: JSON-RPC 2.0 over streamable HTTP,
// speaking the modern revision (server/discover) with the legacy initialize handshake
// answered too. The six tools act on the same store as REST, through the same domain
// operations, so an object made over MCP reads back over /api/v3 unchanged.

import { store, VIEWER, type RepoRec } from './store.ts';
import { forgeCreateIssue, forgeCreatePull, forgeMergePull, issueJson, pullJson, repoJson } from './rest.ts';

export interface McpReply {
  status: number;
  /** The JSON-RPC response body; undefined answers with an empty body (notifications). */
  body?: unknown;
}

const SERVER_INFO = Object.freeze({ name: 'makefun-forge', version: '1.0.0' });
const REVISION = '2026-07-28';

// ---------------------------------------------------------------- the tool list
// Built once and never mutated: two tools/list calls must answer byte for byte the same.

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

// ---------------------------------------------------------------- JSON-RPC plumbing

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: JsonRpcId, code: number, message: string): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolOk(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------- tool calls

function lookupRepo(args: Record<string, unknown>): RepoRec | null {
  if (args.owner !== VIEWER.login || typeof args.repo !== 'string') return null;
  return store.repos.get(args.repo) ?? null;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

/** Validate the required arguments of a tool against its schema; a complaint or null. */
function missingArgument(tool: ToolDef, args: Record<string, unknown>): string | null {
  for (const key of tool.inputSchema.required) {
    const value = args[key];
    if (value === undefined || value === null || value === '') return key;
    const schema = tool.inputSchema.properties[key];
    if (schema !== undefined) {
      if (schema.type === 'string' && typeof value !== 'string') return key;
      if (schema.type === 'number' && typeof value !== 'number') return key;
      if (schema.type === 'boolean' && typeof value !== 'boolean') return key;
    }
  }
  return null;
}

function callTool(id: JsonRpcId, params: Record<string, unknown>): McpReply {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return rpcError(id, -32601, `Unknown tool: ${name}`);
  const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
  const missing = missingArgument(tool, args);
  if (missing !== null) return rpcError(id, -32602, `Missing or invalid required argument: ${missing}`);

  switch (tool.name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name') as string;
      const created = store.createRepo(repoName, stringArg(args, 'description') ?? '', args.private === true);
      if (created === null) return rpcResult(id, toolError(`Repository ${VIEWER.login}/${repoName} already exists`));
      return rpcResult(id, toolOk(repoJson(created)));
    }
    case 'get_repo': {
      const repo = lookupRepo(args);
      if (repo === null) return rpcResult(id, toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`));
      return rpcResult(id, toolOk(repoJson(repo)));
    }
    case 'create_issue': {
      const repo = lookupRepo(args);
      if (repo === null) return rpcResult(id, toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`));
      const created = forgeCreateIssue(repo, {
        title: stringArg(args, 'title') as string,
        body: stringArg(args, 'body') ?? '',
        labels: [],
      });
      if (!created.ok) return rpcResult(id, toolError(created.message));
      return rpcResult(id, toolOk(issueJson(repo, created.issue)));
    }
    case 'list_issues': {
      const repo = lookupRepo(args);
      if (repo === null) return rpcResult(id, toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`));
      const state = stringArg(args, 'state') ?? 'open';
      const issues = [...repo.items.values()]
        .filter((item) => item.kind === 'issue')
        .filter((item) => state === 'all' || item.state === state)
        .sort((a, b) => a.number - b.number)
        .map((item) => issueJson(repo, item));
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(issues) }],
        structuredContent: { issues },
        isError: false,
      });
    }
    case 'create_pull_request': {
      const repo = lookupRepo(args);
      if (repo === null) return rpcResult(id, toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`));
      const created = forgeCreatePull(repo, {
        title: stringArg(args, 'title') as string,
        body: stringArg(args, 'body') ?? '',
        head: stringArg(args, 'head') as string,
        base: stringArg(args, 'base') as string,
      });
      if (!created.ok) return rpcResult(id, toolError(created.message));
      return rpcResult(id, toolOk(pullJson(repo, created.pull)));
    }
    case 'merge_pull_request': {
      const repo = lookupRepo(args);
      if (repo === null) return rpcResult(id, toolError(`Repository ${String(args.owner)}/${String(args.repo)} not found`));
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const item = repo.items.get(number);
      if (item === undefined || item.kind !== 'pull') {
        return rpcResult(id, toolError(`Pull request #${String(args.pull_number)} not found`));
      }
      const merged = forgeMergePull(repo, item);
      if (!merged.ok) return rpcResult(id, toolError(merged.message));
      return rpcResult(id, toolOk({ ...pullJson(repo, item), sha: merged.sha }));
    }
    default:
      return rpcError(id, -32601, `Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- the endpoint

function discoverResult(): Record<string, unknown> {
  return {
    supportedVersions: [REVISION],
    protocolVersion: REVISION,
    capabilities: { tools: {} },
    serverInfo: { ...SERVER_INFO },
    instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over MCP.',
    _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
  };
}

/** Handle one parsed JSON-RPC request object. */
function handleOne(request: Record<string, unknown>): McpReply {
  const hasId = 'id' in request;
  const id = (hasId ? (request.id as JsonRpcId) : null) ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  if (!hasId) {
    // A notification: accepted, never answered.
    return { status: 202 };
  }
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, discoverResult());
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call':
      return callTool(id, params);
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * Route one /mcp request body. Authentication is the caller's job (a missing token is a
 * 401 before this runs). A body that is not JSON is the protocol's parse error: HTTP 400
 * with a -32700 body, in the modern era's form.
 */
export function routeMcp(rawBody: Buffer): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const replies = parsed
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map((entry) => handleOne(entry))
      .filter((reply) => reply.body !== undefined)
      .map((reply) => reply.body);
    return replies.length === 0 ? { status: 202 } : { status: 200, body: replies };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  return handleOne(parsed as Record<string, unknown>);
}
