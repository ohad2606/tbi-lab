/**
 * Sprint 6: ESP32 simulation host, dispatch and project -> session snapshot, with a scripted
 * fake R2 client (routine CI, no network, no QEMU).
 */
import { describe, expect, it } from 'vitest';
import { addComponent, addWire, deleteSelection, type ProjectDocument } from '@tbi-lab/domain';
import {
  validateCreate,
  type CreateSessionRequest,
  type SessionEvent,
} from '../../runtime/host/protocol.js';
import { EXAMPLES } from '../src/examples/catalog.js';
import { McuSimulation } from '../src/runtime/controller.js';
import type { RuntimeClient } from '../src/runtime/client.js';
import {
  buildSessionRequest,
  requiresMcuRuntime,
  resolveFirmware,
} from '../src/runtime/snapshot.js';
import type { BuildResult } from '../src/programs/client.js';
import { SERIAL_MAX_CHARS, WARNINGS_MAX } from '../src/runtime/view.js';
import { SimulationDispatcher } from '../src/sim/dispatch.js';
import type { SimState, SimulationHost } from '../src/sim/controller.js';

/** The example as shipped (Sprint 7: its board runs its Arduino program). */
const shipped = (id: string) =>
  structuredClone(EXAMPLES.find((e) => e.id === id)!.document) as ProjectDocument;
/**
 * The ESP32 examples on their pinned reference images (no build needed): the session lifecycle
 * tests below are about the runtime, not about building.
 */
const REFERENCE: Record<string, string> = {
  'esp32-blink': '5f177cbe95f490dce1f6efe7dda501e03762d523b79771968f967b297d3a44af',
  'esp32-input-echo': '9ca3a5cea66e46a2b54f14f38e0b065f36bc8cf70398cc88fae421028930a03d',
};
const example = (id: string) => {
  const doc = shipped(id);
  const board = doc.components.find((c) => c.type === 'board.esp32_devkitc_wroom32');
  if (board && REFERENCE[id]) board.params.firmware = REFERENCE[id]!;
  return doc;
};
/** Session request with the board's firmware resolved as the app does (no current build). */
const plan = (doc: ProjectDocument, build: BuildResult | null = null) =>
  buildSessionRequest(doc, (b) => resolveFirmware(doc, b, { build }));
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};
const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
};

// ---- scripted fake client ------------------------------------------------------------------

class FakeSession {
  static n = 0;
  readonly id = `s${++FakeSession.n}`;
  created = { state: 'ready' as const };
  commands: unknown[] = [];
  stops = 0;
  terminated = 0;
  statusCalls = 0;
  private seq = 0;
  private onEvent: ((e: SessionEvent) => void) | null = null;
  onStatus: ((s: { kind: string; error?: { code: string } }) => void) | null = null;
  commandResult: { accepted: boolean; reason?: string } = { accepted: true };
  constructor(readonly req: CreateSessionRequest) {}
  stream(onEvent: (e: SessionEvent) => void, onStatus: never) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
  }
  emit(e: Omit<SessionEvent, 'seq'> | Record<string, unknown>) {
    this.onEvent!({ ...(e as object), seq: ++this.seq } as SessionEvent);
  }
  async run() {}
  async stop() {
    this.stops++;
  }
  async terminate() {
    this.terminated++;
  }
  close() {}
  async status() {
    this.statusCalls++;
    return { state: 'running', simNs: '5000000000' };
  }
  async command(c: unknown) {
    this.commands.push(c);
    return this.commandResult;
  }
}

function fakeClient() {
  const sessions: FakeSession[] = [];
  let gate: Promise<void> | null = null;
  const client = {
    async create(req: CreateSessionRequest) {
      if (gate) await gate;
      const s = new FakeSession(req);
      sessions.push(s);
      return s;
    },
  } as unknown as RuntimeClient;
  return {
    client,
    sessions,
    hold() {
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const outcome = {
  ok: true,
  components: {},
  netVoltages: {},
  pins: [],
  notConnected: [],
  appliedRevision: 1,
};

async function running(sim: McuSimulation, f: ReturnType<typeof fakeClient>, doc: ProjectDocument) {
  await sim.run(doc);
  const s = f.sessions.at(-1)!;
  s.emit({ type: 'state', simNs: null, state: 'running' });
  s.emit({ type: 'electrical', simNs: '10000000', outcome });
  expect(sim.state.status).toBe('running');
  return s;
}

// ---- snapshot / dispatch rule --------------------------------------------------------------

describe('project -> R2 session snapshot', () => {
  it('replaces the board with pad attachments and its ground reference; valid for the frozen protocol', () => {
    const doc = example('esp32-input-echo');
    expect(requiresMcuRuntime(doc)).toBe(true);
    expect(requiresMcuRuntime(example('ohms-law'))).toBe(false);
    const b = plan(deepFreeze(doc));
    if (!b.ok) throw new Error(b.error.code);
    const req = b.plan.request;
    expect(validateCreate(req)).toMatchObject({ ok: true });
    expect(req.artifact.sha256).toBe(doc.components.find((c) => c.id === 'U1')!.params.firmware);
    expect(req.circuit.components.some((c) => c.id === 'U1')).toBe(false);
    expect(req.circuit.components.find((c) => c.id === 'U1_gnd')?.type).toBe('component.ground');
    expect(req.attachments.map((a) => a.gpio)).toEqual([4, 34]);
    expect(req.circuit.projectRevision).toBe(doc.revision.localRevision);
    // Only engineering data: no layout, no runtime anything.
    const text = JSON.stringify(req);
    for (const w of ['layout', 'sessionId', 'token', 'serial']) expect(text).not.toContain(w);
  });

  it('refuses what cannot run, explicitly', () => {
    let doc = example('esp32-blink');
    const board = doc.components.find((c) => c.id === 'U1')!;
    // Its program without a current build: Build required, before any runtime request.
    expect(plan(shipped('esp32-blink'))).toMatchObject({
      ok: false,
      error: { code: 'mcu_build_required', components: ['U1'] },
    });
    void board;
    const two = ok(addComponent(doc, 'board.esp32_devkitc_wroom32', { x: 900, y: 0 })).doc;
    expect(plan(two)).toMatchObject({ ok: false, error: { code: 'mcu_multiple' } });
    // GND not wired.
    const gndWire = doc.layout.wires.find(
      (w) => w.from.kind === 'terminal' && w.from.component === 'U1' && w.from.terminal === 'gnd',
    )!;
    const noGnd = ok(
      deleteSelection(doc, { components: [], wires: [gndWire.id], junctions: [] }),
    ).doc;
    expect(plan(noGnd)).toMatchObject({
      ok: false,
      error: { code: 'mcu_ground_unconnected' },
    });
    // A pad wired only to another pad has no circuit element to attach to.
    doc = ok(
      addWire(
        doc,
        { kind: 'terminal', component: 'U1', terminal: 'gpio32' },
        { kind: 'terminal', component: 'U1', terminal: 'gpio33' },
      ),
    ).doc;
    expect(plan(doc)).toMatchObject({
      ok: false,
      error: { code: 'mcu_pin_without_circuit', pins: [32, 33] },
    });
  });
});

describe('ESP32 simulation host (one-shot R2 sessions)', () => {
  it('run -> starting -> running; runtime view is ephemeral; the project is never mutated', async () => {
    const f = fakeClient();
    const sim = new McuSimulation({ client: f.client });
    const doc = deepFreeze(example('esp32-blink'));
    await sim.run(doc);
    expect(sim.state.status).toBe('starting');
    const s = f.sessions[0]!;
    s.emit({ type: 'state', simNs: null, state: 'running' });
    s.emit({
      type: 'gpio',
      simNs: '10000000',
      changes: [{ gpio: 2, drive: 1, level: 1, transitions: 1 }],
    });
    s.emit({ type: 'electrical', simNs: '10000000', outcome });
    s.emit({ type: 'serial', simNs: '10000000', data: Buffer.from('READY\n').toString('base64') });
    const st = sim.state as Extract<SimState, { status: 'running' }>;
    expect(st.status).toBe('running');
    expect(st.runtime!.gpio[2]).toMatchObject({ level: 1, drive: 1 });
    expect(st.runtime!.serial).toBe('READY\n');
    expect(st.runtime!.trace.events).toBe(3);
  });

  it('Stop ends the session for good; the next Run is a new session with an empty view', async () => {
    const f = fakeClient();
    const sim = new McuSimulation({ client: f.client });
    const s = await running(sim, f, example('esp32-blink'));
    s.emit({ type: 'serial', simNs: '20000000', data: Buffer.from('old').toString('base64') });
    sim.stop();
    expect(sim.state.status).toBe('stopping');
    expect(sim.active).toBe(true); // structural edits stay locked until it has ended
    expect(s.stops).toBe(1);
    s.emit({ type: 'state', simNs: null, state: 'ended', reason: 'stopped' });
    expect(sim.state.status).toBe('stopped');
    await running(sim, f, example('esp32-blink'));
    expect(f.sessions).toHaveLength(2);
    expect((sim.state as { runtime?: { serial: string } }).runtime!.serial).toBe('');
  });

  it('mirrors carry the committed revision; a rejected mirror fails and releases the session', async () => {
    const f = fakeClient();
    const sim = new McuSimulation({ client: f.client });
    const s = await running(sim, f, example('esp32-input-echo'));
    expect(sim.control('SW1', { closed: true }, 7)).toBe(true);
    expect(s.commands[0]).toEqual({
      category: 'mirror',
      projectRevision: 7,
      component: 'SW1',
      control: { closed: true },
    });
    s.commandResult = { accepted: false, reason: 'stale_revision' };
    sim.control('SW1', { closed: false }, 6);
    await tick();
    await tick();
    expect(sim.state).toMatchObject({
      status: 'failed',
      failure: { kind: 'runtime', code: 'mirror_failed' },
    });
    expect(s.terminated).toBe(1);
  });

  it('push buttons are transient: no revision, pressed state is runtime-only', async () => {
    const f = fakeClient();
    const sim = new McuSimulation({ client: f.client });
    const s = await running(sim, f, example('esp32-input-echo'));
    sim.momentary('SW2', true);
    expect(s.commands[0]).toEqual({ category: 'transient', action: 'press', component: 'SW2' });
    expect((sim.state as { pressed: string[] }).pressed).toEqual(['SW2']);
    sim.momentary('SW2', false);
    expect(s.commands[1]).toEqual({ category: 'transient', action: 'release', component: 'SW2' });
  });

  it('host failures map to product errors; a server-side engine error is the engine error', async () => {
    const cases: [string, unknown][] = [
      ['guest_reset', { kind: 'runtime', code: 'guest_reset' }],
      ['stalled', { kind: 'runtime', code: 'stalled' }],
      ['runtime_crashed', { kind: 'runtime', code: 'runtime_crashed' }],
      ['bridge_lost', { kind: 'runtime', code: 'runtime_crashed' }],
      ['artifact_hash_mismatch', { kind: 'runtime', code: 'firmware_unavailable' }],
      ['unsupported_feature', { kind: 'runtime', code: 'unsupported_feature' }],
      ['start_timeout', { kind: 'runtime', code: 'startup_failed' }],
    ];
    for (const [reason, failure] of cases) {
      const f = fakeClient();
      const sim = new McuSimulation({ client: f.client });
      const s = await running(sim, f, example('esp32-blink'));
      s.emit({ type: 'state', simNs: null, state: 'failed', reason });
      expect(sim.state, reason).toMatchObject({ status: 'failed', failure });
    }
    const f = fakeClient();
    const sim = new McuSimulation({ client: f.client });
    const s = await running(sim, f, example('esp32-blink'));
    s.emit({
      type: 'state',
      simNs: null,
      state: 'failed',
      reason: 'electrical_error',
      detail: { code: 'psu_parallel', components: ['PSU1', 'PSU2'] },
    });
    expect(sim.state).toMatchObject({
      status: 'failed',
      failure: { kind: 'engine', error: { code: 'psu_parallel' } },
    });
    // An unexpected end (lease, lifetime) is a lost session, not a Stop.
    const g = fakeClient();
    const sim2 = new McuSimulation({ client: g.client });
    const s2 = await running(sim2, g, example('esp32-blink'));
    s2.emit({ type: 'state', simNs: null, state: 'ended', reason: 'lease_expired' });
    expect(sim2.state).toMatchObject({ failure: { code: 'session_lost' } });
  });

  it('bounded: serial keeps the most recent 16 KiB, warnings the last 20', async () => {
    const f = fakeClient();
    const sim = new McuSimulation({ client: f.client });
    const s = await running(sim, f, example('esp32-blink'));
    for (let i = 0; i < 40; i++)
      s.emit({
        type: 'serial',
        simNs: '20000000',
        data: Buffer.from(`${i}`.padEnd(1000, '.')).toString('base64'),
      });
    for (let i = 0; i < 30; i++)
      s.emit({ type: 'diagnostic', simNs: '20000000', severity: 'warning', code: `w${i}` });
    const v = (
      sim.state as { runtime: { serial: string; serialDropped: number; warnings: unknown[] } }
    ).runtime;
    expect(v.serial.length).toBe(SERIAL_MAX_CHARS);
    expect(v.serialDropped).toBe(40_000 - SERIAL_MAX_CHARS);
    expect(v.warnings).toHaveLength(WARNINGS_MAX);
  });

  it('an explicit resync is shown, values are marked stale until the next operating point', async () => {
    const f = fakeClient();
    const sim = new McuSimulation({ client: f.client });
    const s = await running(sim, f, example('esp32-blink'));
    s.emit({ type: 'resync', simNs: null, missed: 42 });
    let v = (sim.state as { runtime: { missedEvents: number; stale: boolean } }).runtime;
    expect(v).toMatchObject({ missedEvents: 42, stale: true });
    await tick();
    expect(s.statusCalls).toBe(1);
    s.emit({ type: 'electrical', simNs: '6000000000', outcome });
    v = (sim.state as { runtime: { missedEvents: number; stale: boolean } }).runtime;
    expect(v.stale).toBe(false);
  });

  it('Stop while the session is still being created releases it the moment it exists', async () => {
    const f = fakeClient();
    const sim = new McuSimulation({ client: f.client });
    const release = f.hold();
    const p = sim.run(example('esp32-blink'));
    await tick();
    sim.stop();
    expect(sim.state.status).toBe('stopped');
    release();
    await p;
    expect(f.sessions[0]!.terminated).toBe(1);
    expect(sim.state.status).toBe('stopped');
  });

  it('a lost stream fails the session as lost; the project is untouched', async () => {
    const f = fakeClient();
    const sim = new McuSimulation({ client: f.client });
    const doc = deepFreeze(example('esp32-blink'));
    const s = await running(sim, f, doc);
    s.onStatus!({ kind: 'lost', error: { code: 'not_found' } });
    expect(sim.state).toMatchObject({ status: 'failed', failure: { code: 'session_lost' } });
  });
});

describe('simulation dispatch', () => {
  it('projects without an MCU use the local host; ESP32 projects the R2 host', async () => {
    const calls: string[] = [];
    const stub = (name: string): SimulationHost => ({
      state: { status: 'stopped' },
      active: false,
      subscribe: () => () => undefined,
      run: async () => void calls.push(`${name}.run`),
      stop: () => void calls.push(`${name}.stop`),
      control: () => true,
      momentary: () => true,
      dispose: () => undefined,
    });
    const d = new SimulationDispatcher(stub('local'), stub('mcu'));
    await d.run(example('ohms-law'));
    expect(d.engine).toBe('local');
    await d.run(example('esp32-blink'));
    expect(d.engine).toBe('mcu');
    await d.run(example('led-current'));
    expect(calls).toEqual(['local.run', 'local.stop', 'mcu.run', 'mcu.stop', 'local.run']);
  });
});
