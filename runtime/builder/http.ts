/**
 * HTTP transport of the build service (`tbi-lab.build/1`). Loopback-only; in the private preview
 * it is reached solely through the same-origin `/build/` route behind oauth2-proxy (the route
 * prefix is stripped by the proxy). See protocol.ts for the routes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { RequestError, validateBuildRequest } from './protocol.js';
import type { BuildService } from './service.js';

/** The Advanced prebuilt path accepts exactly the R2 artifact form: a merged 4 MiB flash image. */
export const PREBUILT_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;

export interface HttpOptions {
  /** How long a lease pins an artifact against eviction (covers session create → private copy). */
  leaseMs: number;
}

export function createBuildHttpServer(service: BuildService, opts: HttpOptions): Server {
  return createServer((req, res) => {
    void handle(service, opts, req, res).catch((e: unknown) => {
      if (e instanceof RequestError) send(res, e.status, { error: e.reason });
      else send(res, 500, { error: 'internal' });
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
    const out = service.submit(validateBuildRequest(body));
    if ('cached' in out) send(res, 200, { build: out.cached });
    else send(res, 202, out);
    return;
  }

  const status = /^\/v1\/builds\/(b_[0-9a-f]{24})$/.exec(path);
  if (method === 'GET' && status) {
    const auth = /^Bearer ([A-Za-z0-9_-]{16,64})$/.exec(req.headers.authorization ?? '');
    const s = auth ? service.status(status[1]!, auth[1]!) : null;
    if (!s) throw new RequestError(404, 'not_found');
    send(res, 200, s);
    return;
  }

  if (method === 'GET' && path === '/v1/lookup') {
    const key = url.searchParams.get('key') ?? '';
    if (!/^[0-9a-f]{64}$/.test(key)) throw new RequestError(400, 'bad_key');
    const build = service.lookup(key);
    if (!build) throw new RequestError(404, 'not_found');
    send(res, 200, { build });
    return;
  }

  if (method === 'POST' && path === '/v1/artifacts') {
    const bytes = await readBody(req, PREBUILT_IMAGE_BYTES);
    // Form check only (no analysis or patching): the size and the two ESP image headers of a
    // merged Classic ESP32 flash image (bootloader at 0x1000, app at 0x10000).
    if (bytes.length !== PREBUILT_IMAGE_BYTES || bytes[0x1000] !== 0xe9 || bytes[0x10000] !== 0xe9)
      throw new RequestError(422, 'not_a_merged_image');
    const artifact = await service.store.publish(bytes, { origin: 'prebuilt' });
    service.store.lease(artifact.sha256, opts.leaseMs);
    send(res, 200, { artifact });
    return;
  }

  const lease = /^\/v1\/artifacts\/([0-9a-f]{64})\/lease$/.exec(path);
  if (method === 'POST' && lease) {
    const until = service.store.lease(lease[1]!, opts.leaseMs);
    if (until === null) throw new RequestError(404, 'not_found');
    send(res, 200, { sha256: lease[1], leaseUntil: new Date(until).toISOString() });
    return;
  }

  throw new RequestError(404, 'not_found');
}
