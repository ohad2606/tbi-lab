/**
 * HTTP adapter of the Session Host (runtime R2), `node:http` only.
 *
 *   GET    /health                          host liveness and session counts (no identifiers)
 *   POST   /sessions                        create (body: CreateSessionRequest)
 *                                           -> 201 { sessionId, token, status }
 *   GET    /sessions/:id                    status
 *   POST   /sessions/:id/run                ready -> running
 *   POST   /sessions/:id/stop               orderly stop (idempotent)
 *   DELETE /sessions/:id                    terminate; responds once resources are released
 *   POST   /sessions/:id/commands           one SessionCommand (mirror | transient)
 *   GET    /sessions/:id/events             Server-Sent Events, ordered; resume with
 *                                           Last-Event-ID (or ?after=): 400 if malformed,
 *                                           409 if ahead of the stream, `resync` first if
 *                                           older than the retained window
 *
 * Every session route needs the gate-asserted identity of the session's owner and the session's
 * token in `Authorization: Bearer <token>` (never in the URL). Unknown sessions, wrong tokens and
 * other principals' sessions are the same 404. Creating a session needs a run ticket (protocol
 * `/2`, Sprint 8).
 *
 * Untrusted input: bodies are size-bounded and parsed as JSON only, validated strictly
 * (protocol.ts), and no request field ever reaches a shell, a file path or an executable name.
 * A failing request never takes the host down.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { principalOf, type IdentityConfig } from '../identity/principal.js';
import type { SessionHost } from './host.js';
import { PROTOCOL, type SessionEvent } from './protocol.js';
import type { HostSession } from './session.js';
import { isTerminal } from './stateMachine.js';

/** Largest amount of unsent SSE data kept for a slow client before its stream is closed. */
const STREAM_BACKLOG_BYTES = 1024 * 1024;
const KEEPALIVE_MS = 15_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'] ?? '';
    if (!/^application\/json\b/.test(type))
      return reject(new HttpError(415, 'application/json required'));
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) return reject(new HttpError(413, 'body too large'));
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(new HttpError(413, 'body too large'));
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'malformed JSON'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'request error')));
  });
}

/**
 * The session token, from the Authorization header only. Sprint 8 (D-S8-5): tokens are never
 * accepted in the URL, where proxies and logs would record them; the client reads the event
 * stream with `fetch`, which carries the header.
 */
function tokenOf(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  return auth?.startsWith('Bearer ') ? auth.slice(7) : null;
}

function sseEvent(e: SessionEvent): string {
  return `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}

function stream(req: IncomingMessage, res: ServerResponse, s: HostSession, url: URL): void {
  // Resume point: Last-Event-ID (EventSource reconnect) or ?after=. Absent/empty = from the
  // start. It must name an event this stream has actually sent: a malformed id is 400, an id
  // beyond the last event is 409 (never silently reinterpreted as another point in the stream).
  // An id older than the retained window is valid: the replay starts with a `resync` marker.
  const header = req.headers['last-event-id'];
  const raw = (Array.isArray(header) ? header[0] : header) || url.searchParams.get('after') || '0';
  if (!/^\d{1,15}$/.test(raw)) throw new HttpError(400, 'malformed Last-Event-ID');
  const after = Number(raw);
  if (after > s.log.lastSeq) throw new HttpError(409, 'Last-Event-ID is ahead of the stream');
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  s.streams++;
  let closed = false;
  // Declared before anything can close the stream (a replay may end with the terminal state).
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    s.streams--;
    s.lastActivity = performance.now(); // the lease counts from the moment the client left
    unsubscribe();
    clearInterval(keepalive);
    res.end();
  };
  const write = (e: SessionEvent) => {
    if (closed) return;
    // A client that cannot keep up is disconnected; it resumes from its Last-Event-ID
    // (or receives a resync marker). Memory stays bounded either way.
    if (res.writableLength > STREAM_BACKLOG_BYTES) return close();
    res.write(sseEvent(e));
    if (e.type === 'state' && isTerminal(e.state)) close();
  };
  const unsubscribe = s.log.subscribe(write);
  for (const e of s.log.since(after)) write(e);
  if (isTerminal(s.state) && !closed) close();
  if (!closed) keepalive = setInterval(() => !closed && res.write(': keepalive\n\n'), KEEPALIVE_MS);
  req.on('close', close);
}

/**
 * `identity`: the gate-asserted identity (Sprint 8, D-S8-1). Every route but `/health` requires
 * it; without one the answer is 401.
 */
export function createHttpServer(host: SessionHost, identity: IdentityConfig): Server {
  return createServer((req, res) => {
    void handle(host, identity, req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.headersSent)
        send(res, status, { error: e instanceof HttpError ? e.message : 'internal error' });
      else res.destroy();
    });
  });
}

async function handle(
  host: SessionHost,
  identity: IdentityConfig,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://host.invalid');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { protocol: PROTOCOL, sessions: host.health() });
  }
  const principal = principalOf(req, identity);
  if (!principal) throw new HttpError(401, 'identity required');
  if (parts[0] !== 'sessions') throw new HttpError(404, 'not found');

  if (parts.length === 1 && method === 'POST') {
    const body = await readBody(req, host.config.maxRequestBytes);
    const r = host.create(body, principal);
    if (!r.ok) throw new HttpError(r.status, r.error);
    const s = r.value.session;
    return send(res, 201, { sessionId: s.id, token: s.token, status: s.status() });
  }

  const found = host.get(parts[1] ?? '', tokenOf(req), principal);
  if (!found.ok) throw new HttpError(found.status, found.error);
  const s = found.value;
  const action = parts[2];

  if (parts.length === 2 && method === 'GET') return send(res, 200, s.status());
  if (parts.length === 2 && method === 'DELETE') {
    await host.terminate(s);
    return send(res, 200, s.status());
  }
  if (action === 'run' && method === 'POST' && parts.length === 3) {
    const r = s.run();
    if (!r.ok) throw new HttpError(409, r.error);
    return send(res, 202, s.status());
  }
  if (action === 'stop' && method === 'POST' && parts.length === 3) {
    s.stop();
    return send(res, 202, s.status());
  }
  if (action === 'commands' && method === 'POST' && parts.length === 3) {
    const body = await readBody(req, 64 * 1024);
    const r = host.command(s, body);
    if (!r.ok) throw new HttpError(r.status, r.error);
    return send(res, r.value.accepted ? 202 : 409, r.value);
  }
  if (action === 'events' && method === 'GET' && parts.length === 3)
    return stream(req, res, s, url);
  throw new HttpError(404, 'not found');
}
