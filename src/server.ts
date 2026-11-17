// HTTP plumbing: body reading, routing, auth, request ids, JSON errors.
// The four surfaces live in their own modules (git-http, rest, graphql, mcp)
// and share one Store. This file only routes; it holds no business logic.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { VIEWER } from './scenario.ts';
import { handleGit } from './git-http.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

export interface HandlerRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
}

export interface HandlerResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const JSON_TYPE = 'application/json; charset=utf-8';

/** Per-process request counter. X-GitHub-Request-Id must be non-empty on every reply. */
let requestSeq = 0;

function requestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, headers: Record<string, string>): void {
  res.writeHead(status, {
    'content-length': body.length,
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function headersOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Build the HTTP server. `token` is the bearer token the suite presents
 * (MAKEFUN_SHOP_TOKEN). /healthz takes no auth; every other route requires
 * `Authorization: Bearer <token>` and answers 401 without it. Unknown routes
 * answer 404 JSON, never HTML.
 */
export function createHttpServer(store: Store, token: string): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const pathname = pathOf(req);
      const method = req.method ?? 'GET';
      const headers = headersOf(req);
      const query = queryOf(req);

      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Route first: unknown routes are 404 JSON even without a token.
      const isGit = /\.git\//.test(pathname) || pathname.endsWith('.git/info/refs') || /\.git\/info\/refs$/.test(pathname);
      const isRest = pathname === '/api/v3' || pathname.startsWith('/api/v3/');
      const isGraphql = pathname === '/api/graphql';
      const isMcp = pathname === '/mcp';
      if (!isGit && !isRest && !isGraphql && !isMcp) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // Auth: every non-healthz route needs the bearer token.
      const auth = headers['authorization'] ?? '';
      if (token !== '' && auth !== `Bearer ${token}`) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
      if (token === '' && !auth.startsWith('Bearer ')) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }

      const body = await readBody(req);
      const hreq: HandlerRequest = { method, pathname, query, headers, body };

      try {
        let out: HandlerResponse | null = null;
        if (isGit) out = await handleGit(hreq, store, VIEWER.login);
        else if (isRest) out = await handleRest(hreq, store, VIEWER.login);
        else if (isGraphql) out = await handleGraphQL(hreq, store, VIEWER.login);
        else if (isMcp) out = await handleMcp(hreq, store, VIEWER.login);

        if (out === null) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const contentType = out.headers['content-type'] ?? JSON_TYPE;
        if (contentType.startsWith('application/json')) {
          sendRaw(res, out.status, out.body, { 'content-type': contentType, ...out.headers });
        } else {
          sendRaw(res, out.status, out.body, out.headers);
        }
      } catch (err) {
        // A handler must never crash the server: answer 500 JSON and stay up.
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      }
    })();
  });
}
