/**
 * HTTP transport of the build service (`tbi-lab.build/1`). Loopback-only; in the private preview
 * it is reached solely through the same-origin `/build/` route behind oauth2-proxy (the route
 * prefix is stripped by the proxy). See protocol.ts for the routes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { decideAccess, type AccessView } from '../identity/access.js';
import type { IdentityConfig, Principal } from '../identity/principal.js';
import { MemoryRate } from '../policy/rate.js';
import { Refusal, admissionEvent, sendRefusal } from '../policy/refusal.js';
import { RequestError, validateBuildRequest } from './protocol.js';
import type { BuildService } from './service.js';

/** The Advanced prebuilt path accepts exactly the R2 artifact form: a merged 4 MiB flash image. */
export const PREBUILT_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;

export interface HttpOptions {
  /** How long a lease pins an artifact against eviction (covers session create → private copy). */
  leaseMs: number;
  /** Identity asserted by the gate (Sprint 8, D-S8-1): every route but health requires it. */
  identity: IdentityConfig;
  /**
   * Sprint 23B access enforcement (TBI_ACCESS_VIEW, the same view as the Session Host): every
   * route but health needs an authorized account (403 `account_disabled`; 503 on a bad view).
   * Absent: RC4.
   */
  access?: AccessView | null;
}

export function createBuildHttpServer(service: BuildService, opts: HttpOptions): Server {
  const requests = new MemoryRate();
  return createServer((req, res) => {
    void handle(service, opts, requests, req, res).catch((e: unknown) => {
      if (e instanceof Refusal) sendRefusal(res, e);
      else if (e instanceof RequestError) send(res, e.status, { error: e.reason });
      else {
        // Operator log: the error only (no request data, identities or bodies).
        process.stderr.write(`build http: internal error: ${(e as Error)?.message ?? e}\n`);
        send(res, 500, { error: 'internal' });
      }
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (Number.isFinite(declared) && declared > max) {
      reject(new RequestError(413, 'too_large'));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new RequestError(413, 'too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handle(
  service: BuildService,
  opts: HttpOptions,
  requests: MemoryRate,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/v1/health') {
    send(res, 200, { ok: true, profiles: service.profiles() });
    return;
  }

  // Who is asking: only the gate asserts it; without an identity nothing else is answered.
  const decision = decideAccess(req, opts.identity, opts.access ?? null);
  if (!decision.ok && decision.status !== 401)
    return send(res, decision.status, { error: decision.error });
  const principal = decision.ok ? decision.principal : null;
  if (!principal) throw new RequestError(401, 'identity_required');
  const emailTag = decision.ok ? decision.emailTag : null;
  // Anti-hammering backstop over every route of this principal (Phase 4).
  const plan = service.access.policy.plan(principal);
  const r = requests.take(principal, 'request', plan.requests);
  if (!r.ok) return refuse(new Refusal('rate_limited', r.retryAfterMs), principal, 'request');
  try {
    await route(service, opts, req, res, url, principal, emailTag);
  } catch (e) {
    if (e instanceof Refusal) return refuse(e, principal, url.pathname.split('/')[2] ?? 'request');
    throw e;
  }

  function refuse(e: Refusal, who: Principal, action: string): void {
    admissionEvent('build', action, e.code, who);
    sendRefusal(res, e);
  }
}

async function route(
  service: BuildService,
  opts: HttpOptions,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  principal: Principal,
  emailTag: string | null,
): Promise<void> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'POST' && path === '/v1/builds') {
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? ''))
      throw new RequestError(415, 'json_required');
    let body: unknown;
    try {
      body = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8'));
    } catch (e) {
      if (e instanceof RequestError) throw e;
      throw new RequestError(400, 'bad_json');
    }
    const out = service.submit(validateBuildRequest(body), principal, emailTag);
    if ('cached' in out) send(res, 200, { build: out.cached });
    else send(res, 202, out);
    return;
  }

  const status = /^\/v1\/builds\/(b_[0-9a-f]{24})$/.exec(path);
  if (method === 'GET' && status) {
    const auth = /^Bearer ([A-Za-z0-9_-]{16,64})$/.exec(req.headers.authorization ?? '');
    const s = auth ? service.status(status[1]!, auth[1]!, principal) : null;
    if (!s) throw new RequestError(404, 'not_found');
    send(res, 200, s);
    return;
  }

  if (method === 'GET' && path === '/v1/lookup') {
    const key = url.searchParams.get('key') ?? '';
    if (!/^[0-9a-f]{64}$/.test(key)) throw new RequestError(400, 'bad_key');
    const build = service.lookup(key, principal);
    if (!build) throw new RequestError(404, 'not_found');
    send(res, 200, { build });
    return;
  }

  if (method === 'POST' && path === '/v1/artifacts') {
    // A policy capability (Sprint 8, owner decision Q2), never a weaker path when enabled:
    // refused before the 4 MiB body is read.
    if (!service.access.policy.plan(principal).capabilities.allowPrebuiltBinary)
      throw new Refusal('capability_disabled');
    const bytes = await readBody(req, PREBUILT_IMAGE_BYTES);
    // Form check only (no analysis or patching): the size and the two ESP image headers of a
    // merged Classic ESP32 flash image (bootloader at 0x1000, app at 0x10000).
    if (bytes.length !== PREBUILT_IMAGE_BYTES || bytes[0x1000] !== 0xe9 || bytes[0x10000] !== 0xe9)
      throw new RequestError(422, 'not_a_merged_image');
    // Stored once, granted to the uploader only; run through the same lease/ticket path.
    const artifact = await service.publishPrebuilt(principal, bytes);
    send(res, 200, { artifact });
    return;
  }

  const lease = /^\/v1\/artifacts\/([0-9a-f]{64})\/lease$/.exec(path);
  if (method === 'POST' && lease) {
    // Not yours and not present are the same answer.
    const granted = service.lease(principal, lease[1]!, opts.leaseMs);
    if (!granted) throw new RequestError(404, 'not_found');
    send(res, 200, {
      sha256: lease[1],
      leaseUntil: new Date(granted.until).toISOString(),
      // For the Session Host: this principal may run this artifact now (D-S8-4).
      ticket: granted.ticket,
    });
    return;
  }

  throw new RequestError(404, 'not_found');
}
