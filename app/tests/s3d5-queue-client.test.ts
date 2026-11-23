/**
 * TBI-018 s3d-5: RuntimeClient queue + limit handling against a stub host (fetch stub, fake timers),
 * the controller's mapping (queue view, limit failure, new end reasons) and locale parity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateSessionRequest } from '../../runtime/host/protocol.js';
import { RuntimeClient, RuntimeTransportError } from '../src/runtime/client.js';
import { McuSimulation } from '../src/runtime/controller.js';
import { simLimitKeys, simLimitText } from '../src/runtime/limits.js';
import { EXAMPLES_WITH_DOCUMENTS as EXAMPLES } from '../src/examples/documents.js';
import { LOCALES, translate } from '../src/i18n/i18n.js';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import type { ProjectDocument } from '@tbi-lab/domain';
import type { SimState } from '../src/sim/controller.js';
import { simFailureMessage } from '../src/sim/format.js';

const REQ = {} as CreateSessionRequest;

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  aborted: () => boolean;
}
type Answer = { status: number; body?: unknown };

/** A stub host: answers the scripted responses in order and records every request. */
function stub(script: Answer[]) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string, init: RequestInit) => {
    const sig = init.signal as AbortSignal | undefined;
    calls.push({
      method: String(init.method),
      path: String(input),
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      aborted: () => !!sig?.aborted,
    });
    if (String(init.method) === 'DELETE') return new Response(null, { status: 204 });
    const a = script.shift();
    if (!a) throw new Error('script exhausted');
    return new Response(JSON.stringify(a.body ?? null), {
      status: a.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, client: new RuntimeClient({ base: '/runtime', fetch: fetchFn }) };
}

const queued = (position: number, ticket = 'tk-1', pollAfterS = 2): Answer => ({
  status: 202,
  body: {
    queued: { ticket, position, pollAfterS },
    limit: { code: 'queue', messageKey: 'limit.sim.queue', params: { n: position } },
  },
});
const created: Answer = {
  status: 201,
  body: { sessionId: 'a'.repeat(32), token: 't', status: { state: 'ready' } },
};
const limitBody = (status: number, code: string, params = {}): Answer => ({
  status,
  body: { error: code, limit: { code, messageKey: `limit.sim.${code}`, params } },
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('RuntimeClient.create against a queue-capable stub host', () => {
  it('sends Tbi-Queue: 1; against a host that answers 201 at once nothing else changes', async () => {
    const { client, calls } = stub([created]);
    const s = await client.create(REQ);
    expect(s.id).toBe('a'.repeat(32));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['tbi-queue']).toBe('1');
    expect(calls[0]!.headers['tbi-queue-ticket']).toBeUndefined();
  });

  it('202 -> polls every pollAfterS with the ticket in a header (never the URL), reports changes only', async () => {
    const { client, calls } = stub([queued(3), queued(3), queued(2), created]);
    const seen: number[] = [];
    const p = client.create(REQ, { onQueue: (q) => seen.push(q.position) });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(1); // not before pollAfterS
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    const s = await p;
    expect(s.id).toHaveLength(32);
    expect(seen).toEqual([3, 2]); // the unchanged poll is not a change
    expect(calls.slice(1).every((c) => c.headers['tbi-queue-ticket'] === 'tk-1')).toBe(true);
    expect(calls.every((c) => !c.path.includes('tk-1'))).toBe(true);
    expect(calls.every((c) => c.method === 'POST')).toBe(true);
  });

  it('the poll interval is bounded (a 0 or huge pollAfterS cannot hammer or stall)', async () => {
    const { client, calls } = stub([queued(1, 'tk-1', 0.001), queued(1, 'tk-1', 9999), created]);
    const p = client.create(REQ);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await p;
  });

  it('abort stops the polling timer at once and cancels the queue entry (DELETE with the ticket)', async () => {
    const { client, calls } = stub([queued(2)]);
    const ac = new AbortController();
    const p = client.create(REQ, { signal: ac.signal });
    const assertion = expect(p).rejects.toMatchObject({ code: 'cancelled' });
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1); // no further poll
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.path).toBe('/runtime/sessions/queue');
    expect(del.headers['tbi-queue-ticket']).toBe('tk-1');
  });

  it('abort before any ticket exists sends no DELETE and no request', async () => {
    const { client, calls } = stub([created]);
    const ac = new AbortController();
    ac.abort();
    await expect(client.create(REQ, { signal: ac.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(calls).toHaveLength(0);
  });

  it("409 queue_replaced stops polling and carries the public limit (no cancel: the entry is the other tab's)", async () => {
    const { client, calls } = stub([queued(2), limitBody(409, 'queue_replaced')]);
    const p = client.create(REQ);
    const assertion = expect(p).rejects.toMatchObject({
      code: 'limit',
      status: 409,
      limit: { code: 'queue_replaced' },
    });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [429, 'minutes_out', { date: '01.12.2026' }],
    [429, 'queue_timeout', {}],
    [429, 'queue_full', {}],
    [429, 'sim_cooldown', { n: 30 }],
    [429, 'sim_concurrent', {}],
    [429, 'sim_daily', {}],
    [503, 'system_unavailable', {}],
  ])('%i %s limit body -> limit error with code and params', async (status, code, params) => {
    const { client } = stub([limitBody(status, code, params)]);
    const e = (await client.create(REQ).catch((x) => x)) as RuntimeTransportError;
    expect(e).toBeInstanceOf(RuntimeTransportError);
    expect(e.code).toBe('limit');
    expect(e.limit).toEqual({ code, params });
  });

  it("legacy bodies (no limit) keep today's mapping: 503 runtime_capacity is busy, 429 quota stays", async () => {
    let r = stub([{ status: 503, body: { error: 'runtime_capacity' } }]);
    await expect(r.client.create(REQ)).rejects.toMatchObject({ code: 'busy' });
    r = stub([{ status: 429, body: { error: 'session_quota' } }]);
    await expect(r.client.create(REQ)).rejects.toMatchObject({ code: 'session_quota' });
    r = stub([{ status: 500 }]);
    await expect(r.client.create(REQ)).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('a malformed 202 is a protocol error, never an endless poll', async () => {
    const { client } = stub([{ status: 202, body: { queued: { position: 0 } } }]);
    await expect(client.create(REQ)).rejects.toMatchObject({ code: 'protocol' });
  });
});

// ---- controller mapping ------------------------------------------------------------------------

const doc = () => {
  const d = structuredClone(
    EXAMPLES.find((e) => e.id === 'esp32-blink')!.document,
  ) as ProjectDocument;
  d.components.find((c) => c.type === 'board.esp32_devkitc_wroom32')!.params.firmware =
    '5f177cbe95f490dce1f6efe7dda501e03762d523b79771968f967b297d3a44af';
  return d;
};

function queueingClient(
  script: (opts: {
    signal?: AbortSignal;
    onQueue?: (q: { position: number; pollAfterS: number }) => void;
  }) => Promise<never>,
) {
  const aborts: AbortSignal[] = [];
  const client = {
    async create(_req: unknown, opts: { signal?: AbortSignal; onQueue?: never }) {
      aborts.push(opts.signal!);
      return script(opts as never);
    },
  } as unknown as RuntimeClient;
  return { client, aborts };
}

describe('McuSimulation with queue and limits', () => {
  it('while queued: starting with the place in the view; Stop aborts the wait, no failure, no session', async () => {
    const { client, aborts } = queueingClient(
      (opts) =>
        new Promise((_res, rej) => {
          opts.onQueue!({ position: 4, pollAfterS: 15 });
          opts.signal!.addEventListener('abort', () => rej(new RuntimeTransportError('cancelled')));
        }),
    );
    const sim = new McuSimulation({ client });
    const p = sim.run(doc());
    await vi.advanceTimersByTimeAsync(0);
    const st = sim.state as Extract<SimState, { status: 'starting' }>;
    expect(st.status).toBe('starting');
    expect(st.runtime!.queue).toEqual({ position: 4 });
    sim.stop();
    expect(aborts[0]!.aborted).toBe(true);
    await p;
    expect(sim.state.status).toBe('stopped');
  });

  it('dispose (unmount / pagehide) aborts a waiting create', async () => {
    const { client, aborts } = queueingClient(
      (opts) =>
        new Promise((_r, rej) =>
          opts.signal!.addEventListener('abort', () => rej(new RuntimeTransportError('cancelled'))),
        ),
    );
    const sim = new McuSimulation({ client });
    const p = sim.run(doc());
    await vi.advanceTimersByTimeAsync(0);
    sim.dispose();
    expect(aborts[0]!.aborted).toBe(true);
    await p;
    expect(sim.state.status).toBe('stopped');
  });

  it.each(['queue_replaced', 'queue_timeout', 'sim_concurrent', 'minutes_out'])(
    'a %s refusal fails the run with the limit; the text is the app message',
    async (code) => {
      const client = {
        async create() {
          throw new RuntimeTransportError('limit', 409, code, {
            code,
            params: { date: '01.12.2026' },
          });
        },
      } as unknown as RuntimeClient;
      const sim = new McuSimulation({ client });
      await sim.run(doc());
      const st = sim.state as Extract<SimState, { status: 'failed' }>;
      expect(st.status).toBe('failed');
      expect(st.failure).toMatchObject({ kind: 'runtime', code: 'sim_limit' });
      for (const locale of LOCALES) {
        const text = simFailureMessage(locale, st.failure, doc());
        expect(text.length).toBeGreaterThan(10);
        expect(text).not.toMatch(/\{|limit\.sim/);
      }
    },
  );

  it('an unknown limit code is the generic failure, never raw', async () => {
    const client = {
      async create() {
        throw new RuntimeTransportError('limit', 429, 'brand_new', {
          code: 'brand_new',
          params: {},
        });
      },
    } as unknown as RuntimeClient;
    const sim = new McuSimulation({ client });
    await sim.run(doc());
    expect((sim.state as { failure: { code: string } }).failure.code).toBe('session_create_failed');
  });
});

// ---- locale parity ----------------------------------------------------------------------------

describe('s3d-5 message keys', () => {
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const keys = [
    ...simLimitKeys(),
    'sim.queue.cancel',
    'sim.queue.waiting_label',
    'sim.error.runtime.sim_limit',
    'sim.error.runtime.sim_minutes',
    'sim.error.runtime.sim_unavailable',
  ] as const;

  it('exist in EN and HE with the same placeholders', () => {
    for (const k of keys) {
      const e = (en as Record<string, string>)[k];
      const h = (he as Record<string, string>)[k];
      expect(e, k).toBeTruthy();
      expect(h, k).toBeTruthy();
      expect(placeholders(h!), k).toEqual(placeholders(e!));
    }
  });

  it('every limit renders in both locales with numbers isolated LTR', () => {
    for (const locale of LOCALES) {
      const q = simLimitText(locale, { code: 'queue', params: { n: 7 } })!;
      expect(q).toContain('⁦7⁩');
      expect(simLimitText(locale, { code: 'queue', params: {} })).toBe(
        translate(locale, 'sim.limit.queue.nopos'),
      );
      expect(simLimitText(locale, { code: 'minutes_out', params: { date: 'x' } })).toBe(
        translate(locale, 'sim.limit.minutes_out.nodate'),
      );
      expect(simLimitText(locale, { code: 'nope', params: {} })).toBeNull();
    }
  });
});

describe('new host end reasons (s3d-4) in the app', () => {
  it.each([
    [
      'sim_minutes',
      { code: 'sim_daily', messageKey: 'limit.sim.daily', params: {} },
      'sim_minutes',
    ],
    ['sim_minutes', null, 'sim_minutes'],
    ['sim_unavailable', { code: 'system_unavailable', params: {} }, 'sim_unavailable'],
  ])('ended %s -> %s failure with a localized message', async (reason, detail, code) => {
    const sessions: { emit: (e: unknown) => void }[] = [];
    let onEvent!: (e: unknown) => void;
    const session = {
      id: 's',
      created: { state: 'ready' },
      stream(cb: (e: unknown) => void) {
        onEvent = cb;
      },
      async run() {},
      close() {},
      async terminate() {},
    };
    sessions.push({ emit: onEvent });
    const client = { create: async () => session } as unknown as RuntimeClient;
    const sim = new McuSimulation({ client });
    await sim.run(doc());
    onEvent({ type: 'state', simNs: null, seq: 1, state: 'ended', reason, detail });
    const st = sim.state as Extract<SimState, { status: 'failed' }>;
    expect(st.status).toBe('failed');
    expect(st.failure).toMatchObject({ kind: 'runtime', code });
    for (const locale of LOCALES) {
      const text = simFailureMessage(locale, st.failure, doc());
      expect(text).not.toMatch(/\{|sim\.(error|limit)/);
    }
  });
});
