// app.ts — the forge's HTTP server: one listener, four surfaces over one store.
//   GET  /healthz                 the env's boot probe (no token)
//   *    /api/v3/...              GitHub REST v3            (rest.ts)
//   POST /api/graphql             GitHub GraphQL v4         (graphql.ts)
//   POST /mcp                     Model Context Protocol    (mcp.ts)
//   *    /{owner}/{repo}.git/...  git smart HTTP            (githttp.ts)
// Everything else is a JSON 404. The lifecycle in main.ts binds the ephemeral port,
// registers it with the env and waits for done; this file is only the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { routeRest, type Reply } from './rest.ts';
import { routeGit } from './githttp.ts';
import { executeGraphqlBatch } from './graphql.ts';
import { routeMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The largest request body the forge will read (a push of many files stays well under). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestSeq = 0;

/** A non-empty, unique-per-process request id, as the protocol checks require. */
function nextRequestId(): string {
  requestSeq += 1;
  return `FORGE-${requestSeq.toString(36).toUpperCase()}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status, { 'x-github-request-id': requestId });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
  });
  res.end(text);
}

function sendReply(res: ServerResponse, reply: Reply, requestId: string): void {
  if (reply.status === 204 || reply.body === undefined) {
    res.writeHead(reply.status, { 'x-github-request-id': requestId, ...(reply.headers ?? {}) });
    res.end();
    return;
  }
  const text = JSON.stringify(reply.body);
  res.writeHead(reply.status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...(reply.headers ?? {}),
  });
  res.end(text);
}

/** Read a request's whole body, capped; resolves null when the cap is exceeded. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overflow = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        overflow = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(overflow ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Whether the request carries the trial's bearer token (an unset token means local dev). */
function isAuthed(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${token}` || header === `token ${token}`;
}

/** The Git-Protocol header's version (2 when the client asks for protocol v2). */
function gitProtocolVersion(req: IncomingMessage): number | null {
  const header = req.headers['git-protocol'];
  if (typeof header !== 'string') return null;
  const match = /version=(\d+)/.exec(header);
  return match ? Number(match[1]) : null;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = nextRequestId();
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 400, { message: 'Bad Request' }, requestId);
    return;
  }
  const path = url.pathname;
  const origin = `http://${req.headers.host ?? 'localhost'}`;
  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const body = hasBody ? await readBody(req) : Buffer.alloc(0);
  if (hasBody && body === null) {
    sendJson(res, 413, { message: 'Request body too large' }, requestId);
    return;
  }
  const bodyBuffer = body ?? Buffer.alloc(0);

  // The env's boot probe: 200 {"ok":true}, called twice, no token.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true }, requestId);
    return;
  }

  // MCP: JSON-RPC over streamable HTTP. Auth is a flat 401 before any parsing.
  if (path === '/mcp') {
    if (!isAuthed(req)) {
      sendJson(res, 401, { message: 'Unauthorized' }, requestId);
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
      return;
    }
    const reply = routeMcp(bodyBuffer);
    if (reply.body === undefined) {
      res.writeHead(reply.status);
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.body, requestId);
    return;
  }

  // GraphQL: an unauthenticated request is exactly 401; the rest is 200 with data/errors.
  if (path === '/api/graphql') {
    if (!isAuthed(req)) {
      sendJson(res, 401, { message: 'Unauthorized' }, requestId);
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyBuffer.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] }, requestId);
      return;
    }
    sendJson(res, 200, executeGraphqlBatch(parsed), requestId);
    return;
  }

  // REST v3. The API root answers without a token (as the starter does); all else needs it.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map(decodeSegment);
    const isRoot = segments.length === 0;
    if (!isRoot && !isAuthed(req)) {
      sendJson(res, 401, { message: 'Bad credentials' }, requestId);
      return;
    }
    let jsonBody: Record<string, unknown> | undefined;
    let malformed = false;
    if (hasBody && bodyBuffer.length > 0) {
      try {
        const parsed: unknown = JSON.parse(bodyBuffer.toString('utf8'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          jsonBody = parsed as Record<string, unknown>;
        } else {
          jsonBody = {};
        }
      } catch {
        malformed = true;
      }
    }
    const reply = routeRest({ method, segments, query: url.searchParams, body: jsonBody, malformed, origin });
    sendReply(res, reply, requestId);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}.
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
  if (gitMatch !== null) {
    if (!isAuthed(req)) {
      sendJson(res, 401, { message: 'Unauthorized' }, requestId);
      return;
    }
    const tail = gitMatch[3] ?? '';
    const reply = routeGit({
      method,
      owner: decodeSegment(gitMatch[1] as string),
      repoName: decodeSegment(gitMatch[2] as string),
      tail,
      query: url.searchParams,
      protocolVersion: gitProtocolVersion(req),
      body: bodyBuffer,
    });
    res.writeHead(reply.status, { 'content-type': reply.contentType, 'content-length': reply.body.length });
    res.end(reply.body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' }, requestId);
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch(() => {
      // A handler fault must never take the process down mid-trial.
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, nextRequestId());
        else res.end();
      } catch {
        // The socket is already gone; nothing more to do.
      }
    });
  });
  return server;
}
