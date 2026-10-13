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
  | 'protocol'; // malformed response or event stream

export class RuntimeTransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    readonly status?: number,
    detail?: string,
  ) {
    super(`${code}${status ? ` (${status})` : ''}${detail ? `: ${detail}` : ''}`);
    this.name = 'RuntimeTransportError';
  }
}

export interface SessionStatusBody {
  sessionId: string;
  state: SessionState;
  reason: string | null;
  detail?: unknown;
  simNs: string;
  lastEventSeq: number;
  revisions: MirrorRevisions;
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
  ): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(keepalive ? { keepalive: true } : {}),
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch (e) {
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

  /** Create a session from an execution snapshot. */
  async create(req: CreateSessionRequest): Promise<RuntimeSession> {
    const r = await this.request('POST', '/sessions', undefined, req);
    if (r.status !== 201) {
      const error = (r.body as { error?: string } | null)?.error;
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
