/**
 * K3-2: client presence and the idle warning (host side: K3-1, `idleMs` + POST /presence).
 * Fake clock, scripted session and a fake input target (so `isTrusted` and listener counts are
 * observable); the transport tests use the real Session Host code with the fake runtime (no QEMU).
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDocument } from '@tbi-lab/domain';
import { TEST_IDENTITY, startTestGate } from '../../runtime/identity/test-gate.js';
import { createHttpServer } from '../../runtime/host/http.js';
import { createRequest, fakeHost } from '../../runtime/host/tests/support.js';
import type { SessionEvent } from '../../runtime/host/protocol.js';
import { LOCALES } from '../src/i18n/i18n.js';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import { EXAMPLES_WITH_DOCUMENTS as EXAMPLES } from '../src/examples/documents.js';
import { RuntimeClient, RuntimeSession, RuntimeTransportError } from '../src/runtime/client.js';
import {
  IDLE_WARNING_MS,
  McuSimulation,
  PRESENCE_ANSWER_MS,
  PRESENCE_THROTTLE_MS,
} from '../src/runtime/controller.js';
import { simLimitText, simLimitUi } from '../src/runtime/limits.js';
import type { SimulationHost } from '../src/sim/controller.js';
import { SimulationDispatcher } from '../src/sim/dispatch.js';
import type { RuntimeView } from '../src/runtime/view.js';
import { simFailureMessage } from '../src/sim/format.js';

const MIN = 60_000;
const IDLE = 5 * MIN;
/** Time without interaction after which the warning shows. */
const QUIET = IDLE - MIN;
const INPUT_TYPES = ['keydown', 'pointerdown', 'pointermove', 'wheel'];

const doc = () => {
  const d = structuredClone(
    EXAMPLES.find((e) => e.id === 'esp32-blink')!.document,
  ) as ProjectDocument;
  d.components.find((c) => c.id === 'U1')!.params.firmware =
    '5f177cbe95f490dce1f6efe7dda501e03762d523b79771968f967b297d3a44af';
  return d;
};

class FakeInput {
  listeners = new Map<string, Set<(e: Event) => void>>();
  hidden = false;
  addEventListener(type: string, l: unknown) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(l as (e: Event) => void);
  }
  removeEventListener(type: string, l: unknown) {
    this.listeners.get(type)?.delete(l as (e: Event) => void);
  }
  get count() {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
  fire(type = 'keydown', extra: Record<string, unknown> = {}) {
    for (const l of this.listeners.get(type) ?? [])
      l({ type, isTrusted: true, ...extra } as unknown as Event);
  }
}

class FakeSession {
  readonly id = 's1';
  presences = 0;
  /** What the host answers to the next presence POSTs. */
  answer: () => Promise<void> = async () => undefined;
  accept = true;
  runGate: Promise<void> = Promise.resolve();
  private seq = 0;
  private onEvent!: (e: SessionEvent) => void;
  onStatus!: (s: unknown) => void;
  constructor(readonly created: { state: 'ready'; idleMs?: number }) {}
  presence() {
    this.presences++;
    return this.answer();
  }
  stream(onEvent: (e: SessionEvent) => void, onStatus: (s: unknown) => void) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
  }
  emit(e: Record<string, unknown>) {
    this.onEvent({ ...e, seq: ++this.seq } as unknown as SessionEvent);
  }
  run() {
    return this.runGate;
  }
  async stop() {}
  async terminate() {}
  close() {}
  async command() {
    return this.accept ? { accepted: true } : { accepted: false, reason: 'not_running' };
  }
}

const outcome = { ok: true, components: {}, netVoltages: {}, pins: [], notConnected: [] };

async function start(...args: [idleMs?: number, runGate?: Promise<void>]) {
  const idleMs = args.length ? args[0] : IDLE;
  const runGate = args[1];
  const input = new FakeInput();
  const sessions: FakeSession[] = [];
  const client = {
    async create() {
      const s = new FakeSession({
        state: 'ready',
        ...(idleMs === undefined ? {} : { idleMs }),
      });
      if (runGate) s.runGate = runGate;
      sessions.push(s);
      return s;
    },
  } as unknown as RuntimeClient;
  const sim = new McuSimulation({
    client,
    input: { target: input, hidden: () => input.hidden },
  });
  const done = sim.run(doc());
  await vi.advanceTimersByTimeAsync(0);
  const s = sessions[0]!;
  if (!runGate) await done;
  s.emit({ type: 'state', simNs: null, state: 'running' });
  s.emit({ type: 'electrical', simNs: '10000000', outcome });
  expect(sim.state.status).toBe('running');
  return { sim, s, input, done };
}

const warning = (sim: McuSimulation) => (sim.state as { runtime?: RuntimeView }).runtime?.idleSoon;
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('K3-2 idle warning and presence', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('warns exactly 60 s before the idle end and never posts by itself', async () => {
    expect([IDLE_WARNING_MS, PRESENCE_THROTTLE_MS]).toEqual([MIN, 30_000]);
    const { sim, s } = await start();
    await advance(QUIET - 1);
    expect(warning(sim)).toBeNull();
    await advance(1);
    expect(warning(sim)).toEqual({ idleMs: IDLE });
    await advance(10 * MIN);
    expect(s.presences).toBe(0);
  });

  it.each([undefined, 0, -1, Number.NaN])(
    'idleMs %s: no listener, no POST, no warning, no timer',
    async (idleMs) => {
      const { sim, s, input } = await start(idleMs);
      expect(input.count).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      input.fire();
      sim.stillHere();
      await advance(60 * MIN);
      expect(warning(sim)).toBeNull();
      expect(s.presences).toBe(0);
    },
  );

  it('real input before the warning posts and restarts the countdown', async () => {
    const { sim, s, input } = await start();
    await advance(QUIET - 1);
    input.fire('pointerdown');
    await advance(0);
    expect(s.presences).toBe(1);
    await advance(QUIET - 1);
    expect(warning(sim)).toBeNull();
    await advance(1);
    expect(warning(sim)).not.toBeNull();
  });

  it('throttles to one POST per 30 s, with no trailing POST; countdown from the last sent one', async () => {
    const { sim, s, input } = await start();
    await advance(1000);
    for (let i = 0; i < 100; i++) input.fire(INPUT_TYPES[i % 4], { movementX: 1 });
    await advance(PRESENCE_THROTTLE_MS - 1);
    input.fire();
    expect(s.presences).toBe(1);
    await advance(1); // 31 s: the next input may be sent
    expect(s.presences).toBe(1);
    input.fire();
    await advance(0);
    expect(s.presences).toBe(2);
    await advance(10_000);
    input.fire(); // throttled: must not move the countdown
    await advance(QUIET - 10_000 - 1);
    expect(warning(sim)).toBeNull();
    await advance(1);
    expect(warning(sim)).not.toBeNull();
  });

  it('ignores synthetic events, key repeat, motionless pointer events and a hidden tab', async () => {
    const { sim, s, input } = await start();
    await advance(QUIET);
    input.fire('keydown', { isTrusted: false });
    input.fire('pointerdown', { isTrusted: false });
    input.fire('keydown', { repeat: true });
    input.fire('pointermove', { movementX: 0, movementY: 0 });
    input.fire('pointermove');
    input.hidden = true;
    input.fire('keydown');
    sim.stillHere();
    await advance(0);
    expect(s.presences).toBe(0);
    expect(warning(sim)).not.toBeNull();
    // only the user-input events are listened to (nothing like focus, scroll or visibility)
    expect([...input.listeners.keys()].sort()).toEqual(INPUT_TYPES);
  });

  it('countdown uses the send time of the accepted POST, not the (late) answer', async () => {
    const { sim, s } = await start();
    await advance(QUIET);
    let accept!: () => void;
    s.answer = () => new Promise<void>((r) => (accept = r));
    void sim.stillHere();
    await advance(5_000);
    expect(warning(sim)).not.toBeNull(); // not accepted yet
    accept();
    await advance(0);
    expect(warning(sim)).toBeNull();
    await advance(QUIET - 5_000 - 1);
    expect(warning(sim)).toBeNull();
    await advance(1);
    expect(warning(sim)).not.toBeNull();
  });

  it('countdown starts when run was SENT', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { sim, done } = await start(IDLE, gate);
    await advance(10_000);
    release();
    await done;
    await advance(QUIET - 10_000 - 1);
    expect(warning(sim)).toBeNull();
    await advance(1);
    expect(warning(sim)).not.toBeNull();
  });

  it('accepted commands restart the countdown; rejected ones do not', async () => {
    const { sim, s } = await start();
    await advance(QUIET);
    s.accept = false;
    sim.momentary('S1', true);
    await advance(0);
    expect(warning(sim)).not.toBeNull();
    s.accept = true;
    sim.momentary('S1', false); // not pressed any more: nothing is sent
    sim.momentary('S1', true);
    await advance(0);
    expect(warning(sim)).toBeNull();
    await advance(QUIET);
    expect(warning(sim)).not.toBeNull();
    sim.control('R1', { params: { resistance: 100 } }, 2);
    await advance(0);
    expect(warning(sim)).toBeNull();
    expect(s.presences).toBe(0);
  });

  it('stillHere() extends in one action, also inside the throttle window, once per click', async () => {
    // idle shorter than warning + throttle: the warning can show right after a POST
    const { sim, s, input } = await start(MIN + 10_000);
    input.fire();
    await advance(10_000);
    expect(warning(sim)).not.toBeNull();
    sim.stillHere();
    sim.stillHere(); // in flight: one request
    await advance(0);
    expect(s.presences).toBe(2);
    expect(warning(sim)).toBeNull();
    sim.stillHere(); // no warning: the throttle applies
    expect(s.presences).toBe(2);
  });

  it.each([404, 503])('a failing presence (%s) is silent and never retried', async (status) => {
    const { sim, s, input } = await start();
    s.answer = () => Promise.reject(new RuntimeTransportError('not_found', status));
    await advance(QUIET - 1);
    input.fire();
    input.fire();
    await advance(MIN);
    expect(s.presences).toBe(1);
    expect(sim.state.status).toBe('running');
    expect(warning(sim)).not.toBeNull(); // not accepted: the warning stays
    expect((sim.state as { runtime: RuntimeView }).runtime.warnings).toEqual([]);
  });

  it.each([
    ['stop', (sim: McuSimulation) => sim.stop()],
    ['dispose', (sim: McuSimulation) => sim.dispose()],
    [
      'host end',
      (_: McuSimulation, s: FakeSession) =>
        s.emit({ type: 'state', simNs: null, state: 'ended', reason: 'idle_timeout' }),
    ],
    [
      'host failure',
      (_: McuSimulation, s: FakeSession) =>
        s.emit({ type: 'state', simNs: null, state: 'failed', reason: 'stalled' }),
    ],
    [
      'stream lost',
      (_: McuSimulation, s: FakeSession) =>
        s.onStatus({ kind: 'lost', error: new RuntimeTransportError('unreachable') }),
    ],
  ])('%s removes every listener and idle timer', async (name, end) => {
    const { sim, s, input } = await start();
    expect(input.count).toBe(INPUT_TYPES.length);
    await advance(QUIET);
    end(sim, s);
    expect(input.count).toBe(0);
    expect(warning(sim) ?? null).toBeNull();
    // stop() keeps only its own bounded stop timer
    expect(vi.getTimerCount()).toBe(name === 'stop' ? 1 : 0);
    sim.stillHere();
    await advance(10 * MIN);
    expect(s.presences).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a late presence answer after Stop starts nothing', async () => {
    const { sim, s, input } = await start();
    let accept!: () => void;
    s.answer = () => new Promise<void>((r) => (accept = r));
    input.fire();
    sim.dispose();
    accept();
    await advance(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Stop before run is answered never starts the idle watch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { sim, input, done } = await start(IDLE, gate);
    sim.stop();
    release();
    await done;
    expect(input.count).toBe(0);
  });

  it('idle_timeout maps to session_idle with the minutes, in EN and HE', async () => {
    const { sim, s } = await start();
    s.emit({ type: 'state', simNs: null, state: 'ended', reason: 'idle_timeout' });
    expect(sim.state).toMatchObject({
      status: 'failed',
      failure: {
        kind: 'runtime',
        code: 'session_idle',
        detail: 'idle_timeout',
        limit: { code: 'session_idle', params: { minutes: 5 } },
      },
    });
    const failure = (sim.state as { failure: Parameters<typeof simFailureMessage>[1] }).failure;
    for (const locale of LOCALES) {
      const text = simFailureMessage(locale, failure, null);
      expect(text).toContain('⁦5⁩');
      expect(text).not.toMatch(/[{}]|sim\.error/);
    }
    expect(en['sim.limit.session_idle']).toContain('{minutes}');
    expect(he['sim.limit.session_idle']).toContain('{minutes}');
  });

  it('idle_timeout without a host idleMs is the old session_lost (no invented minutes)', async () => {
    const { sim, s } = await start(undefined);
    s.emit({ type: 'state', simNs: null, state: 'ended', reason: 'idle_timeout' });
    expect(sim.state).toMatchObject({ failure: { code: 'session_lost' } });
  });
});

describe('K3-3 the "Still there?" prompt: only explicit answers decide', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('while the warning shows, passive input sends nothing and dismisses nothing', async () => {
    const { sim, s, input } = await start();
    await advance(QUIET);
    for (const type of INPUT_TYPES) input.fire(type, { movementX: 1 });
    await advance(0);
    expect(s.presences).toBe(0);
    expect(warning(sim)).not.toBeNull();
  });

  it('stillHere() resolves true once the host accepted, and clears the warning', async () => {
    const { sim, s } = await start();
    await advance(QUIET);
    await expect(sim.stillHere()).resolves.toBe(true);
    expect(s.presences).toBe(1);
    expect(warning(sim)).toBeNull();
  });

  it('a refused request resolves false, keeps the warning, and can be retried', async () => {
    const { sim, s } = await start();
    await advance(QUIET);
    s.answer = () => Promise.reject(new RuntimeTransportError('unreachable'));
    await expect(sim.stillHere()).resolves.toBe(false);
    expect(warning(sim)).not.toBeNull();
    s.answer = async () => undefined;
    await expect(sim.stillHere()).resolves.toBe(true);
    expect(s.presences).toBe(2);
  });

  it('an unanswered request resolves false after the answer limit; a retry sends again', async () => {
    const { sim, s } = await start();
    await advance(QUIET);
    s.answer = () => new Promise<void>(() => undefined);
    const results: boolean[] = [];
    void sim.stillHere().then((ok) => results.push(ok));
    void sim.stillHere().then((ok) => results.push(ok)); // same request
    await advance(PRESENCE_ANSWER_MS - 1);
    expect(results).toEqual([]);
    await advance(1);
    expect(results).toEqual([false, false]);
    expect(warning(sim)).not.toBeNull();
    s.answer = async () => undefined;
    await expect(sim.stillHere()).resolves.toBe(true);
    expect(s.presences).toBe(2);
  });

  it('the session ending drops the warning; stillHere() then resolves false without a POST', async () => {
    const { sim, s } = await start();
    await advance(QUIET);
    s.emit({ type: 'state', simNs: null, state: 'ended', reason: 'idle_timeout' });
    expect(warning(sim) ?? null).toBeNull();
    await expect(sim.stillHere()).resolves.toBe(false);
    expect(s.presences).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the idle end is a calm retryable limit; one minute is not "1 minutes"', () => {
    expect(simLimitUi('session_idle')).toEqual({ role: 'status', retry: true });
    for (const locale of LOCALES) {
      const text = (minutes: number) =>
        simLimitText(locale, { code: 'session_idle', params: { minutes } })!;
      expect(text(5)).toContain('\u20665\u2069');
      expect(text(1)).not.toMatch(/1|[{}]/);
    }
  });

  it('the prompt texts quote the exact button names and claim no save state', () => {
    for (const m of [en, he]) {
      const quoted = (text: string) => [...text.matchAll(/[“״]([^”״]+)[”״]/g)].map((q) => q[1]);
      expect(quoted(m['sim.idle.body'])).toEqual([m['sim.idle.continue']]);
      expect(quoted(m['sim.idle.failed'])).toEqual([m['sim.idle.continue'], m['sim.idle.stop']]);
    }
    for (const key of [
      'sim.idle.body',
      'sim.limit.session_idle',
      'sim.limit.session_idle.one',
    ] as const) {
      expect(en[key]).toMatch(/(does|did) not change your project/);
      expect(en[key]).not.toContain('saved');
      expect(he[key]).toMatch(/עצירת ההרצה לא (משנה|שינתה) את הפרויקט/);
      expect(he[key]).not.toContain('שמור');
    }
  });

  it('the dispatcher forwards stillHere() to the active host only', async () => {
    const host = (over: object) =>
      ({ subscribe: () => () => undefined, ...over }) as unknown as SimulationHost;
    const stillHere = vi.fn(async () => true);
    const local = new SimulationDispatcher(host({}), host({ stillHere }));
    await expect(local.stillHere()).resolves.toBe(false); // the local engine has no idle limit
    expect(stillHere).not.toHaveBeenCalled();
  });
});

describe('K3-2 presence() against the real Session Host', () => {
  const closers: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
  });

  async function serve(over: Record<string, number>) {
    const { host, art } = fakeHost('normal', over);
    const server: Server = createHttpServer(host, TEST_IDENTITY);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const gate = await startTestGate(
      { host: '127.0.0.1', port: (server.address() as AddressInfo).port },
      TEST_IDENTITY,
      'user-a',
    );
    closers.push(async () => {
      gate.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await host.shutdown();
    });
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new RuntimeClient({
      base: gate.base,
      fetch: (input, init) => {
        calls.push({ url: String(input), init: init! });
        return fetch(input, init);
      },
    });
    return { session: await client.create(createRequest(art.sha256)), calls };
  }

  it('reads idleMs and posts presence (204) with the token only in the header', async () => {
    const { session, calls } = await serve({ idleMs: 600_000 });
    expect(session.created.idleMs).toBe(600_000);
    await expect(session.presence()).resolves.toBeUndefined();
    const { url, init } = calls.at(-1)!;
    expect(url.endsWith(`/sessions/${session.id}/presence`)).toBe(true);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    const auth = (init.headers as Record<string, string>).authorization;
    expect(auth).toMatch(/^Bearer .+/);
    expect(url).not.toContain(auth!.slice(7));
  });

  it('idle off: the status has no idleMs; an unknown session is a typed not_found', async () => {
    const { session } = await serve({});
    expect(session.created).not.toHaveProperty('idleMs');
    await session.terminate();
    const old = new RuntimeClient({ fetch: async () => new Response('{}', { status: 404 }) });
    await expect(
      new RuntimeSession(old, 'x', 't', session.created).presence(),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
