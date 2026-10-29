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
 *   POST   /reports                         Sprint 14 problem report (reportProtocol.ts)
 *                                           -> 201 { id } once durably stored; 503 when the
 *                                           deployment has not enabled reports
 *   /admin/...                              Sprint 23B/23C owner routes (admin.ts), per
 *                                           TBI_ADMIN_MODE: off (404), reports, full
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
import { decideAccess, emailOf, type AccessView } from '../identity/access.js';
import type { IdentityConfig, Principal } from '../identity/principal.js';
import {
  handleAdmin,
  type AdminLimits,
  type AdminMode,
  type AdminSpool,
  type IdentityObserver,
} from './admin.js';
import type { OwnerReference } from './owner.js';
import { MemoryRate } from '../policy/rate.js';
import { Refusal, admissionEvent, sendRefusal } from '../policy/refusal.js';
import type { SessionHost } from './host.js';
import { PROTOCOL, type SessionEvent } from './protocol.js';
import type { HostSession } from './session.js';
import { isTerminal } from './stateMachine.js';
import { runtimeIdentity } from './identity.js';
import { MAX_REPORT_BYTES } from './reportProtocol.js';
import type { ReportStore } from './reports.js';

/** Largest amount of unsent SSE data kept for a slow client before its stream is closed. */
const STREAM_BACKLOG_BYTES = 1024 * 1024;
/**
 * Concurrent event streams per session (Sprint 13 security audit): the app holds one; a few more
 * cover a reconnect racing the old connection's close. Without a cap, one user could open
 * hundreds of non-reading streams, each buffering up to STREAM_BACKLOG_BYTES, and exhaust the
 * shared Session Host's memory for every user. Bound: sessions x MAX_STREAMS x 1 MiB.
 */
export const MAX_STREAMS_PER_SESSION = 4;
/** Upper bound of one command request body (Sprint 11; commands are a few hundred bytes). */
export const MAX_COMMAND_BYTES = 8 * 1024;
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
  if (s.streams >= MAX_STREAMS_PER_SESSION) throw new HttpError(429, 'too many event streams');
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
    s.streamClosers.delete(closer);
    unsubscribe();
    clearInterval(keepalive);
    res.end();
  };
  const closer = () => close();
  s.streamClosers.add(closer);
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

function healthBody(host: SessionHost) {
  // Sprint 10: the runtime's build identity when the bundle was stamped (additive, read-only).
  const runtime = runtimeIdentity();
  return { protocol: PROTOCOL, sessions: host.health(), ...(runtime ? { runtime } : {}) };
}

/**
 * Sprint 23B (review H1): a server that answers `GET /health` only (the same body as the API's),
 * for the build service's admission check on its own socket. Every other request is 404: no
 * identity is read, no session or admin route exists here.
 */
export function createHealthServer(host: SessionHost): Server {
  return createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://host.invalid').pathname;
    if (req.method === 'GET' && path === '/health') return send(res, 200, healthBody(host));
    send(res, 404, { error: 'not found' });
  });
}

/** Sprint 23B options; all absent: exactly the RC4 behaviour. */
export interface HttpOptions {
  /** Access enforcement (TBI_ACCESS_VIEW): every route but /health needs an authorized account. */
  access?: AccessView | null;
  /** The owner's administration (TBI_ADMIN_DIR; needs `access`): `/admin/...`. */
  admin?: AdminSpool | null;
  /** Identity observations for the helper (TBI_ADMIN_DIR/observations). */
  observer?: IdentityObserver | null;
  /** Admin rate limits (tests; default ADMIN_RATE / ADMIN_WRITE_RATE). */
  adminLimits?: AdminLimits;
  /**
   * Sprint 23C (TBI_ADMIN_MODE): what `/admin` serves. Default: `full` with an access view, `off`
   * without one (the Sprint 23B rule). `reports` uses `owner`, and never the spool or observer.
   */
  adminMode?: AdminMode;
  /** `reports` mode: the owner reference (TBI_OWNER_PRINCIPAL_FILE). */
  owner?: OwnerReference | null;
}

/**
 * `identity`: the gate-asserted identity (Sprint 8, D-S8-1). Every route but `/health` requires
 * it; without one the answer is 401. `reports`: the problem-report store, null when the
 * deployment has not enabled reports (Sprint 14). `opts`: Sprint 23B access enforcement and
 * administration (off when absent).
 */
export function createHttpServer(
  host: SessionHost,
  identity: IdentityConfig,
  reports: ReportStore | null = null,
  opts: HttpOptions = {},
): Server {
  const requests = new MemoryRate();
  const adminRate = new MemoryRate();
  const adminMode: AdminMode = opts.adminMode ?? (opts.access ? 'full' : 'off');
  // Sprint 23C: the feedback-only mode writes nothing outside the report store, whatever it is
  // handed: no spool, no identity observations.
  if (adminMode !== 'full') opts = { ...opts, admin: null, observer: null };
  opts = { ...opts, adminMode };
  return createServer((req, res) => {
    void handle(host, identity, requests, adminRate, reports, opts, req, res).catch(
      (e: unknown) => {
        const status = e instanceof HttpError ? e.status : 500;
        // Operator log for the unexpected: the error only (no request data, identities or bodies).
        if (status === 500)
          process.stderr.write(
            `session host http: internal error: ${(e as Error)?.message ?? e}\n`,
          );
        if (!res.headersSent)
          send(res, status, { error: e instanceof HttpError ? e.message : 'internal error' });
        else res.destroy();
      },
    );
  });
}

async function handle(
  host: SessionHost,
  identity: IdentityConfig,
  requests: MemoryRate,
  adminRate: MemoryRate,
  reports: ReportStore | null,
  opts: HttpOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://host.invalid');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/health') return send(res, 200, healthBody(host));
  const access = opts.access ?? null;
  const decision = decideAccess(req, identity, access);
  // Sprint 23B: the helper learns which Google account signs in with which address (best
  // effort, detached: never fails or delays this request).
  if (opts.observer && decision.ok && decision.principal) {
    const subject = req.headers[identity.subjectHeader];
    const email = emailOf(req);
    if (typeof subject === 'string' && email) {
      try {
        void opts.observer.observe(decision.principal, subject, email);
      } catch {
        // never the request's problem
      }
    }
  }
  if (!decision.ok) {
    if (decision.status === 401) throw new HttpError(401, 'identity required');
    return send(res, decision.status, { error: decision.error });
  }
  // Anti-hammering backstop over every route of this caller (Phase 4), the admin routes included
  // (Sprint 23B review I5: before the owner check, so a non-owner hammering /admin is limited too).
  // Keyed by principal; an address-only caller (no subject) by its email tag.
  const caller = (decision.principal ?? decision.emailTag) as Principal | null;
  if (host.config.policy && caller) {
    const plan = host.config.policy.plan(caller);
    const r = requests.take(caller, 'request', plan.requests);
    if (!r.ok) {
      if (decision.principal)
        admissionEvent('runtime', 'request', 'rate_limited', decision.principal);
      return sendRefusal(res, new Refusal('rate_limited', r.retryAfterMs));
    }
  }
  const adminMode = opts.adminMode ?? 'off';
  if (adminMode !== 'off' && parts[0] === 'admin')
    return handleAdmin(
      req,
      res,
      url,
      parts.slice(1),
      { principal: decision.principal, emailTag: decision.emailTag },
      {
        mode: adminMode,
        access,
        owner: opts.owner ?? null,
        spool: opts.admin ?? null,
        reports,
        capacity: () => host.capacity(),
        rate: adminRate,
        ...(opts.adminLimits ? { limits: opts.adminLimits } : {}),
      },
    );
  const principal = decision.principal;
  if (!principal) throw new HttpError(401, 'identity required');
  if (parts[0] === 'reports' && parts.length === 1 && method === 'POST') {
    if (!reports) throw new HttpError(503, 'reports_disabled');
    const body = await readBody(req, MAX_REPORT_BYTES);
    const r = await reports.submit(body, principal, req.headers['user-agent'], host);
    return 'refusal' in r ? sendRefusal(res, r.refusal) : send(res, r.status, r.body);
  }
  if (parts[0] !== 'sessions') throw new HttpError(404, 'not found');

  if (parts.length === 1 && method === 'POST') {
    const body = await readBody(req, host.config.maxRequestBytes);
    const r = host.create(body, principal, decision.emailTag);
    if (!r.ok && r.refusal) {
      admissionEvent('runtime', 'session-create', r.refusal.code, principal);
      return sendRefusal(res, r.refusal);
    }
    if (!r.ok) throw new HttpError(r.status, r.error);
    if (host.config.policy) admissionEvent('runtime', 'session-create', 'admitted', principal);
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
    // A command is a few hundred bytes (Sprint 11: bounded at 8 KiB, was 64 KiB).
    const body = await readBody(req, MAX_COMMAND_BYTES);
    const r = host.command(s, body);
    if (!r.ok) throw new HttpError(r.status, r.error);
    return send(res, r.value.accepted ? 202 : 409, r.value);
  }
  if (action === 'events' && method === 'GET' && parts.length === 3)
    return stream(req, res, s, url);
  throw new HttpError(404, 'not found');
}
