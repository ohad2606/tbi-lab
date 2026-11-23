/**
 * Browser client for the R2 Session Host, protocol `tbi-lab.session/1` (Sprint 6).
 *
 * Owns every transport detail so no UI code builds HTTP or SSE by hand:
 *   - same-origin base path (default `/runtime`, behind the deployment's authentication proxy);
 *   - the session token travels only in the `Authorization` header, never in a URL (the event
 *     stream is read with `fetch`, not EventSource, precisely so it can carry the header);
 *   - ordered events, strictly increasing `seq`; any gap that is not an explicit `resync`
 *     marker is a protocol error, never silently accepted;
 *   - reconnect with `Last-Event-ID` after a transport drop, with bounded backoff; the MCU <->
 *     electrical loop keeps running on the server meanwhile, the WAN is never part of it;
 *   - typed errors (`RuntimeTransportError`) instead of raw HTTP details.
 *
 * The frozen protocol types come from runtime/host/protocol.ts: one definition for both sides.
 */
import type {
  CommandRejection,
  CreateSessionRequest,
  MirrorRevisions,
  SessionCommand,
  SessionEvent,
  SessionState,
} from '../../../runtime/host/protocol.js';
import { gateFetch } from '../gate.js';

export type TransportErrorCode =
  | 'unreachable' // network failure or 5xx from the proxy/host
  | 'busy' // 429/503: the host's capacity (or low host resources)
  | 'session_quota' // Sprint 8: this user's live sessions are at their limit
  | 'rate_limited' // Sprint 8: too many sessions started recently
  | 'shutting_down' // 503
  | 'refused' // 400/415/413: the host refused the request (protocol/validation)
  | 'not_found' // 404: unknown session (ended and forgotten, or never existed)
  | 'conflict' // 409 on run: the session is not in a runnable state
  | 'limit' // TBI-018 s3d-5: a metered refusal with a public limit body (`error.limit`)
  | 'cancelled' // the caller aborted create (Stop / unmount); the queue ticket is cancelled
  | 'protocol'; // malformed response or event stream

export class RuntimeTransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    readonly status?: number,
    detail?: string,
    /** TBI-018 s3d-5: the host's public limit (code + params), never server text. */
    readonly limit?: PublicLimit,
  ) {
    super(`${code}${status ? ` (${status})` : ''}${detail ? `: ${detail}` : ''}`);
    this.name = 'RuntimeTransportError';
  }
}

/** The host's `limit` body (runtime/host/simAdmission.ts PublicLimit); the app renders its own text. */
export interface PublicLimit {
  code: string;
  params: Record<string, string | number>;
}

/** Where a waiting create stands (design section 4); `null` = no longer queued. */
export interface QueueInfo {
  position: number;
  pollAfterS: number;
}

export interface CreateOptions {
  /** Abort = Stop / unmount: polling stops, the queue entry is cancelled (best effort). */
  signal?: AbortSignal;
  /** Called when the queue position is first known or changes; never on an unchanged poll. */
  onQueue?: (q: QueueInfo) => void;
}

/** Poll interval bounds (ms) around the host's `pollAfterS` (default 15 s). */
const POLL_DEFAULT_S = 15;
const POLL_MIN_MS = 1000;
const POLL_MAX_MS = 60_000;

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A well-formed `limit` body, or undefined (anything else is not a limit). */
export function parseLimit(body: unknown): PublicLimit | undefined {
  const l = record(body) ? body.limit : undefined;
  if (!record(l) || typeof l.code !== 'string') return undefined;
  const params: Record<string, string | number> = {};
  if (record(l.params))
    for (const [k, v] of Object.entries(l.params))
      if (typeof v === 'string' || typeof v === 'number') params[k] = v;
  return { code: l.code, params };
}

export interface SessionStatusBody {
  sessionId: string;
  state: SessionState;
  reason: string | null;
  detail?: unknown;
  simNs: string;
  lastEventSeq: number;
  revisions: MirrorRevisions;
  /**
   * The session's enforced maximum wall time once running (ms); null when unbounded. Absent from
   * hosts before Alpha Phase D: the app then shows no pre-expiry warning (it never guesses).
   */
  lifetimeMs?: number | null;
}

export interface CommandResult {
  accepted: boolean;
  reason?: CommandRejection;
  revisions?: MirrorRevisions;
}

export type StreamStatus =
  | { kind: 'connected' }
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'lost'; error: RuntimeTransportError };

export interface ClientOptions {
  /** Base path of the Session Host API. Default: `/runtime` (same origin). */
  base?: string;
  fetch?: typeof fetch;
  /** Give up reconnecting after this long without a stream (the host lease is 30 s). */
  reconnectForMs?: number;
  /**
   * A stream silent for this long is treated as dropped and reconnected. The host sends a
   * keepalive comment every 15 s, so a live stream is never silent that long; a proxy that
   * leaves a dropped upstream half-open (observed with a development proxy) is detected here.
   */
  idleTimeoutMs?: number;
}

const statusCode = (s: number): TransportErrorCode =>
  s === 429
    ? 'busy'
    : s === 503
      ? 'shutting_down'
      : s === 404
        ? 'not_found'
        : s === 409
          ? 'conflict'
          : s >= 500
            ? 'unreachable'
            : 'refused';

export class RuntimeClient {
  readonly base: string;
  /** @internal */
  readonly fetchFn: typeof fetch;
  readonly reconnectForMs: number;
  readonly idleTimeoutMs: number;

  constructor(opts: ClientOptions = {}) {
    this.base = (opts.base ?? '/runtime').replace(/\/$/, '');
    this.fetchFn = opts.fetch ?? ((input, init) => gateFetch(input, init));
    this.reconnectForMs = opts.reconnectForMs ?? 25_000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 20_000;
  }

  /** @internal */
  async request(
    method: string,
    path: string,
    token?: string,
    body?: unknown,
    keepalive = false,
    extra: { headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...extra.headers,
        },
        ...(extra.signal ? { signal: extra.signal } : {}),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(keepalive ? { keepalive: true } : {}),
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new RuntimeTransportError('cancelled');
      throw new RuntimeTransportError('unreachable', undefined, (e as Error).message);
    }
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // An authentication proxy answering with HTML (e.g. a login redirect) is not the host.
      if (res.status < 300) throw new RuntimeTransportError('protocol', res.status, 'not JSON');
    }
    return { status: res.status, body: parsed };
  }

  /**
   * Create a session from an execution snapshot.
   *
   * TBI-018 s3d-5: sends `Tbi-Queue: 1` (the client understands 202). A host without metering
   * ignores it and answers 201 or an error as before. On 202 the same request is repeated every
   * `pollAfterS` with `Tbi-Queue-Ticket` until 201 or a refusal; abort stops the polling timer and
   * cancels the entry (`DELETE /sessions/queue`). A 409/429/503 with a limit body becomes a
   * `limit` error carrying the public limit (409 `queue_replaced` included: polling stops).
   */
  async create(req: CreateSessionRequest, opts: CreateOptions = {}): Promise<RuntimeSession> {
    const { signal } = opts;
    let ticket: string | undefined;
    let last = -1;
    const cancel = () => {
      if (ticket) void this.cancelQueue(ticket);
    };
    for (;;) {
      if (signal?.aborted) {
        cancel();
        throw new RuntimeTransportError('cancelled');
      }
      let r: { status: number; body: unknown };
      try {
        r = await this.request('POST', '/sessions', undefined, req, false, {
          headers: { 'tbi-queue': '1', ...(ticket ? { 'tbi-queue-ticket': ticket } : {}) },
          ...(signal ? { signal } : {}),
        });
      } catch (e) {
        if (e instanceof RuntimeTransportError && e.code === 'cancelled') cancel();
        throw e;
      }
      if (r.status === 202) {
        const q = record(r.body) && record(r.body.queued) ? r.body.queued : null;
        const position = q?.position;
        if (!q || !Number.isInteger(position) || (position as number) < 1)
          throw new RuntimeTransportError('protocol', 202, 'queue ticket');
        if (typeof q.ticket === 'string' && q.ticket) ticket = q.ticket;
        else if (!ticket) throw new RuntimeTransportError('protocol', 202, 'queue ticket');
        const pollS =
          typeof q.pollAfterS === 'number' && q.pollAfterS > 0 ? q.pollAfterS : POLL_DEFAULT_S;
        if (position !== last) {
          last = position as number;
          opts.onQueue?.({ position: last, pollAfterS: pollS });
        }
        await sleep(Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, pollS * 1000)), signal);
        continue;
      }
      if (r.status !== 201) {
        const error = (r.body as { error?: string } | null)?.error;
        const limit =
          r.status === 409 || r.status === 429 || r.status === 503 ? parseLimit(r.body) : undefined;
        if (limit) throw new RuntimeTransportError('limit', r.status, limit.code, limit);
        const code: TransportErrorCode =
          error === 'session_quota'
            ? 'session_quota'
            : error === 'rate_limited'
              ? 'rate_limited'
              : error === 'runtime_capacity' ||
                  error === 'memory_pressure' ||
                  error === 'storage_pressure'
                ? 'busy'
                : statusCode(r.status);
        throw new RuntimeTransportError(code, r.status, error);
      }
      const b = r.body as { sessionId?: unknown; token?: unknown; status?: unknown };
      if (typeof b?.sessionId !== 'string' || typeof b.token !== 'string' || !b.status)
        throw new RuntimeTransportError('protocol', r.status, 'create response');
      return new RuntimeSession(this, b.sessionId, b.token, b.status as SessionStatusBody);
    }
  }

  /** Best effort: the host answers 204 for every ticket; the vanish timeout covers a failure. */
  private async cancelQueue(ticket: string): Promise<void> {
    try {
      await this.request('DELETE', '/sessions/queue', undefined, undefined, true, {
        headers: { 'tbi-queue-ticket': ticket },
      });
    } catch {
      // nothing to do
    }
  }
}

/** A timer that an abort clears at once (no timer outlives a stopped or unmounted run). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export class RuntimeSession {
  private nextSeq = 1;
  private lastEventSeq = 0;
  private closed = false;
  private abort: AbortController | null = null;

  constructor(
    private readonly client: RuntimeClient,
    readonly id: string,
    private readonly token: string,
    readonly created: SessionStatusBody,
  ) {}

  private path(rest = '') {
    return `/sessions/${this.id}${rest}`;
  }

  async status(): Promise<SessionStatusBody> {
    const r = await this.client.request('GET', this.path(), this.token);
    if (r.status !== 200) throw new RuntimeTransportError(statusCode(r.status), r.status);
    return r.body as SessionStatusBody;
  }

  async run(): Promise<void> {
    const r = await this.client.request('POST', this.path('/run'), this.token);
    if (r.status !== 202) throw new RuntimeTransportError(statusCode(r.status), r.status);
  }

  /** Graceful stop (idempotent on the host). */
  async stop(): Promise<void> {
    const r = await this.client.request('POST', this.path('/stop'), this.token);
    if (r.status !== 202 && r.status !== 404)
      throw new RuntimeTransportError(statusCode(r.status), r.status);
  }

  /** Terminate and release (idempotent). `keepalive` lets it outlive a closing page. */
  async terminate(keepalive = false): Promise<void> {
    this.close();
    const r = await this.client.request('DELETE', this.path(), this.token, undefined, keepalive);
    if (r.status !== 200 && r.status !== 404)
      throw new RuntimeTransportError(statusCode(r.status), r.status);
  }

  /**
   * Submit one command. `seq` is assigned here, strictly increasing per session. A rejection
   * is a normal result (`accepted: false` with the host's reason), not an exception.
   */
  async command(cmd: DistributiveOmit<SessionCommand, 'seq'>): Promise<CommandResult> {
    const body = { ...cmd, seq: this.nextSeq++ };
    const r = await this.client.request('POST', this.path('/commands'), this.token, body);
    if (r.status !== 202 && r.status !== 409)
      throw new RuntimeTransportError(statusCode(r.status), r.status);
    return r.body as CommandResult;
  }

  /** The highest event seq received so far (the stream's resume point). */
  get resumeFrom(): number {
    return this.lastEventSeq;
  }

  /**
   * Stream the session's ordered events until the session is terminal, the stream is closed
   * with `close()`, or reconnecting fails for longer than `reconnectForMs`. Reconnects resume
   * from the last event seen (`Last-Event-ID`); the host then replays retained events, or
   * starts with an explicit `resync` marker if some were already evicted.
   */
  stream(onEvent: (e: SessionEvent) => void, onStatus: (s: StreamStatus) => void): void {
    void this.pump(onEvent, onStatus);
  }

  close(): void {
    this.closed = true;
    this.abort?.abort();
  }

  private async pump(
    onEvent: (e: SessionEvent) => void,
    onStatus: (s: StreamStatus) => void,
  ): Promise<void> {
    let lostSince: number | null = null;
    let attempt = 0;
    while (!this.closed) {
      this.abort = new AbortController();
      let terminal: boolean;
      try {
        const res = await fetch_(this.client, this.path('/events'), {
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(this.lastEventSeq ? { 'last-event-id': String(this.lastEventSeq) } : {}),
          },
          signal: this.abort.signal,
        });
        if (res.status !== 200) {
          const err = new RuntimeTransportError(statusCode(res.status), res.status, 'events');
          if (res.status === 404 || res.status === 400 || res.status === 409) {
            onStatus({ kind: 'lost', error: err });
            return;
          }
          throw err;
        }
        if (!(res.headers.get('content-type') ?? '').startsWith('text/event-stream'))
          throw new RuntimeTransportError('protocol', res.status, 'not an event stream');
        lostSince = null;
        attempt = 0;
        onStatus({ kind: 'connected' });
        // Liveness: any bytes (events or keepalives) re-arm the watchdog; silence aborts.
        const abort = this.abort;
        let idle = setTimeout(() => abort.abort(), this.client.idleTimeoutMs);
        const alive = () => {
          clearTimeout(idle);
          idle = setTimeout(() => abort.abort(), this.client.idleTimeoutMs);
        };
        try {
          terminal = await readEvents(
            res.body!,
            (e) => {
              this.accept(e);
              onEvent(e);
            },
            alive,
          );
        } finally {
          clearTimeout(idle);
        }
        if (terminal) return; // the host closes the stream after the terminal state
      } catch (e) {
        if (this.closed) return;
        if (e instanceof RuntimeTransportError && e.code === 'protocol') {
          onStatus({ kind: 'lost', error: e });
          return;
        }
      }
      if (this.closed) return;
      // Transport dropped: reconnect with backoff, within the lease window.
      lostSince ??= Date.now();
      if (Date.now() - lostSince > this.client.reconnectForMs) {
        onStatus({ kind: 'lost', error: new RuntimeTransportError('unreachable') });
        return;
      }
      attempt++;
      onStatus({ kind: 'reconnecting', attempt });
      await delay(Math.min(2000, 150 * 2 ** Math.min(attempt, 4)));
    }
  }

  /** Ordering invariant: strictly increasing seq; only a leading `resync` may skip. */
  private accept(e: SessionEvent): void {
    if (e.type === 'resync') {
      if (!(e.seq > this.lastEventSeq && e.missed === e.seq - this.lastEventSeq))
        throw new RuntimeTransportError('protocol', undefined, 'resync marker');
    } else if (e.seq !== this.lastEventSeq + 1) {
      throw new RuntimeTransportError(
        'protocol',
        undefined,
        `event ${e.seq} after ${this.lastEventSeq}`,
      );
    }
    this.lastEventSeq = e.seq;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetch_(client: RuntimeClient, path: string, init: RequestInit): Promise<Response> {
  try {
    return await client.fetchFn(`${client.base}${path}`, {
      ...init,
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new RuntimeTransportError('unreachable', undefined, (e as Error).message);
  }
}

/**
 * Parse a `text/event-stream` body. Returns true if the stream ended after a terminal state
 * event (the host closes it then), false if it ended otherwise (a transport drop).
 */
export async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: SessionEvent) => void,
  onBytes: () => void = () => undefined,
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let terminal = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return terminal;
    onBytes();
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split('\n').find((l) => l.startsWith('data: '));
      if (!data) continue; // keepalive comment
      let e: SessionEvent;
      try {
        e = JSON.parse(data.slice(6)) as SessionEvent;
      } catch {
        throw new RuntimeTransportError('protocol', undefined, 'event JSON');
      }
      const idLine = block.split('\n').find((l) => l.startsWith('id: '));
      if (idLine && Number(idLine.slice(4)) !== e.seq)
        throw new RuntimeTransportError('protocol', undefined, 'event id');
      onEvent(e);
      if (e.type === 'state' && (e.state === 'ended' || e.state === 'failed')) terminal = true;
    }
  }
}
