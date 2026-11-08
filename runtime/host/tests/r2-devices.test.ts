/**
 * Sprint 12 (R2, S12-4): the Session Host's HC-SR04 and DHT22 drivers against the engine oracle,
 * through the whole host with the fake runtime. Scripted `G` frames play the firmware's trigger
 * and start signal; the `J` commands in the host's reply are checked against hcsr04Echo /
 * dht22Frame timing and against levels solved by the engine (T-R2-1, -3, -4, -7, -8, -9, -10,
 * T-SEC-2 at unit level; the real-QEMU versions are in runtime/tests).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  addComponent,
  addWire,
  createProject,
  createSnapshot,
  setParam,
  type ComponentTypeId,
  type ParamValue,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { EngineSession, dht22Frame, hcsr04Echo } from '@tbi-lab/engine';
import { InputSchedule } from '../../harness/protocol.js';
import { principalFor, ticketFor } from '../../identity/test-gate.js';
import { DHT22_TGO_NS, J_BUDGET_PER_SIM_S, RuntimeDevices } from '../devices.js';
import type { SessionHost } from '../host.js';
import { PROTOCOL, type CreateSessionRequest } from '../protocol.js';
import type { HostSession } from '../session.js';
import { fakeHost, serialText, waitState } from './support.js';

const hosts: SessionHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.shutdown()));
});

function project(
  build: (p: {
    add(t: ComponentTypeId): string;
    wire(a: string, b: string): void;
    set(id: string, k: string, v: ParamValue): void;
  }) => void,
): ProjectDocument {
  let doc = createProject({ projectId: 'prj_r2', deviceId: 'd', name: 'R2', appVersion: '0' });
  let x = 0;
  build({
    add(t) {
      x += 200;
      const r = addComponent(doc, t, { x, y: 400 });
      if (!r.ok) throw new Error(r.error);
      doc = r.doc;
      return r.id;
    },
    wire(a, b) {
      const [ac, at] = a.split('.') as [string, string];
      const [bc, bt] = b.split('.') as [string, string];
      const r = addWire(
        doc,
        { kind: 'terminal', component: ac, terminal: at },
        { kind: 'terminal', component: bc, terminal: bt },
      );
      if (!r.ok) throw new Error(`${a}-${b}: ${r.error}`);
      doc = r.doc;
    },
    set(id, k, v) {
      const r = setParam(doc, id, k, v);
      if (!r.ok) throw new Error(r.error);
      doc = r.doc;
    },
  });
  return doc;
}

/** PSU (vcc) -> HC-SR04; TRIG on GPIO13; ECHO -> 1k -> GPIO14 (the fake firmware uses 2, 5, 18) -> 2k -> GND (or direct). */
function sonarCircuit(vcc = 5, divider = true, distance = 0.5, top = 1000, bottom = 2000) {
  const ids: Record<string, string> = {};
  const doc = project((p) => {
    const u = (ids.u = p.add('sensor.hc_sr04'));
    p.wire('PSU1.positive', `${u}.vcc`);
    p.wire(`${u}.gnd`, 'GND1.ref');
    p.wire('PSU1.negative', 'GND1.ref');
    p.set('PSU1', 'setpointVoltage', { value: vcc, unit: 'volt' });
    p.set('PSU1', 'outputEnabled', true);
    p.set(u, 'distance', { value: distance, unit: 'metre' });
    if (divider) {
      const r1 = (ids.r1 = p.add('component.resistor'));
      const r2 = p.add('component.resistor');
      p.set(r1, 'resistance', { value: top, unit: 'ohm' });
      p.set(r2, 'resistance', { value: bottom, unit: 'ohm' });
      p.wire(`${u}.echo`, `${r1}.a`);
      p.wire(`${r1}.b`, `${r2}.a`);
      p.wire(`${r2}.b`, 'GND1.ref');
    }
  });
  const attachments = [
    { gpio: 13, component: ids.u!, terminal: 'trig' },
    divider
      ? { gpio: 14, component: ids.r1!, terminal: 'b' }
      : { gpio: 14, component: ids.u!, terminal: 'echo' },
  ];
  return { doc, attachments, u: ids.u! };
}

/** PSU 3.3 V -> DHT22 VDD; DATA <-> GPIO4 with an optional pull-up to the PSU. */
function dhtCircuit(pullUp: number | null = 10_000, vdd = 3.3) {
  const ids: Record<string, string> = {};
  const doc = project((p) => {
    const u = (ids.u = p.add('sensor.dht22'));
    p.wire('PSU1.positive', `${u}.vdd`);
    p.wire(`${u}.gnd`, 'GND1.ref');
    p.wire('PSU1.negative', 'GND1.ref');
    p.set('PSU1', 'setpointVoltage', { value: vdd, unit: 'volt' });
    p.set('PSU1', 'outputEnabled', true);
    p.set(u, 'temperature', { value: -10.3, unit: 'celsius' });
    p.set(u, 'humidity', { value: 55.2, unit: 'percent_rh' });
    if (pullUp !== null) {
      const r = p.add('component.resistor');
      p.set(r, 'resistance', { value: pullUp, unit: 'ohm' });
      p.wire(`${r}.a`, 'PSU1.positive');
      p.wire(`${r}.b`, `${u}.data`);
    }
  });
  return { doc, attachments: [{ gpio: 4, component: ids.u!, terminal: 'data' }], u: ids.u! };
}

function start(
  c: { doc: ProjectDocument; attachments: CreateSessionRequest['attachments'] },
  frames: string[],
  hello = '2 sched-input',
) {
  const r = fakeHost('normal', {
    runtimeEnv: {
      PATH: process.env.PATH,
      TBI_FAKE_MODE: 'normal',
      TBI_FAKE_HELLO: hello,
      TBI_FAKE_FRAMES: frames.join(';'),
    },
  });
  hosts.push(r.host);
  const req: CreateSessionRequest = {
    protocol: PROTOCOL,
    artifact: { sha256: r.art.sha256 },
    board: 'board.esp32_devkitc_wroom32',
    circuit: createSnapshot(c.doc),
    attachments: c.attachments,
    ticket: ticketFor(r.art.sha256),
  };
  const created = r.host.create(req, principalFor());
  if (!created.ok) throw new Error(created.error);
  return created.value.session;
}

async function runUntil(s: HostSession, text: RegExp, ms = 8000) {
  s.run();
  await waitState(s, 'running');
  const t0 = Date.now();
  while (!text.test(serialText(s)) && Date.now() - t0 < ms)
    await new Promise((r) => setTimeout(r, 50));
  s.stop();
  await Promise.race([waitState(s, 'failed', 15_000), waitState(s, 'ended', 15_000)]);
  await s.done();
  return serialText(s);
}

/** The J commands of the reply to `frame`, from the fake's echo. */
function js(text: string, frame: string) {
  const line = text.split('\n').find((l) => l.startsWith(`REPLY ${frame} ->`));
  if (!line) throw new Error(`no reply to ${frame}`);
  return line
    .slice(line.indexOf('->') + 2)
    .trim()
    .split('|')
    .filter((c) => c.startsWith('J '))
    .map((c) => {
      const [, vns, pad, level] = c.split(' ');
      return { vns: BigInt(vns!), pad: Number(pad), level: Number(level) };
    });
}
const diag = (s: HostSession, code: string) =>
  s.log.since(0).filter((e) => e.type === 'diagnostic' && (e as { code: string }).code === code);

describe('HC-SR04 driver (scheduled echo)', () => {
  const RISE = 'G 9500000 13 1 1';
  it('a 10 us trigger gets the oracle echo on the divided pad, with solved levels (T-R2-1)', async () => {
    const fall = 'G 9510000 13 1 0';
    const s = start(sonarCircuit(), [RISE, fall]);
    const text = await runUntil(s, /REPLY G 9510000/);
    const e = hcsr04Echo(9_510_000n, 10, 0.5, 20)!;
    expect(js(text, fall)).toEqual([
      { vns: e.riseNs, pad: 14, level: 1 },
      { vns: e.fallNs, pad: 14, level: 0 },
    ]);
    expect(s.status().state).toBe('ended');
  });

  it('Sprint 25 closure: an echo that would put the read pad between V_IL and V_IH ends the run, no edge scheduled', async () => {
    const fall = 'G 9510000 13 1 0';
    // 2 kΩ over 1 kΩ: about a third of the echo level, inside 0.825..2.475 V.
    const c = sonarCircuit(5, true, 0.5, 2000, 1000);
    const r = fakeHost('normal', {
      runtimeEnv: {
        PATH: process.env.PATH,
        TBI_FAKE_MODE: 'normal',
        TBI_FAKE_HELLO: '2 input-read,sched-input',
        TBI_FAKE_FRAMES: [RISE, fall].join(';'),
      },
    });
    hosts.push(r.host);
    const features = {
      internalPull: [],
      gpioInterrupt: [],
      restart: false,
      unsupported: [],
      requires: ['input-read'],
      inputReads: { pins: [14], unresolved: false },
    };
    const created = r.host.create(
      {
        protocol: PROTOCOL,
        artifact: { sha256: r.art.sha256 },
        board: 'board.esp32_devkitc_wroom32',
        circuit: createSnapshot(c.doc),
        attachments: c.attachments,
        ticket: ticketFor(r.art.sha256, principalFor(), features),
      },
      principalFor(),
    );
    if (!created.ok) throw new Error(created.error);
    const s = created.value.session;
    s.run();
    await Promise.race([waitState(s, 'failed', 15_000), waitState(s, 'ended', 15_000)]);
    await s.done();
    const st = s.status();
    expect(st).toMatchObject({
      state: 'failed',
      reason: 'electrical_error',
      detail: {
        code: 'sensor_level_undefined',
        components: expect.arrayContaining([c.u]),
        param: 'gpio14',
        detail: { gpio: 14, sinceNs: '9510000' },
      },
    });
    const v = (st.detail as { detail: { voltage: number } }).detail.voltage;
    expect(v).toBeGreaterThan(0.825);
    expect(v).toBeLessThan(2.475);
    // No echo edge was ever scheduled on the pad (the reply, if echoed at all, carries only Q).
    expect(serialText(s)).not.toMatch(/J \d+ 14 /);
  });

  it('a 5 us trigger, an out-of-range target or an unpowered module: no echo (T-R2-1/3)', async () => {
    const short = 'G 9505000 13 1 0';
    let text = await runUntil(start(sonarCircuit(), [RISE, short]), /REPLY G 9505000/);
    expect(js(text, short)).toEqual([]);
    const fall = 'G 9510000 13 1 0';
    for (const c of [sonarCircuit(5, true, 4.5), sonarCircuit(5, true, 0.01), sonarCircuit(3.3)]) {
      text = await runUntil(start(c, [RISE, fall]), /REPLY G 9510000/);
      expect(js(text, fall)).toEqual([]);
    }
  });

  it('a re-trigger while the echo is pending is ignored (T-R2-4)', async () => {
    const f1 = 'G 9510000 13 1 0';
    const f2 = 'G 9530000 13 1 0';
    const text = await runUntil(
      start(sonarCircuit(), [RISE, f1, 'G 9520000 13 1 1', f2]),
      /REPLY G 9530000/,
    );
    expect(js(text, f1)).toHaveLength(2);
    expect(js(text, f2)).toEqual([]);
  });

  it('ECHO wired straight to the pad: 5 V is a logic HIGH (the pad over-stress warning is engine-tested, r2-parts)', async () => {
    const fall = 'G 9510000 13 1 0';
    const s = start(sonarCircuit(5, false), [RISE, fall]);
    const text = await runUntil(s, /REPLY G 9510000/);
    expect(js(text, fall).map((j) => j.level)).toEqual([1, 0]);
  });

  it('on a runtime without sched-input the session is refused naming the part', async () => {
    const c = sonarCircuit();
    const s = start(c, [], '1');
    s.run();
    await Promise.race([waitState(s, 'failed', 15_000), waitState(s, 'ended', 15_000)]);
    await s.done();
    expect(s.status()).toMatchObject({
      state: 'failed',
      reason: 'electrical_error',
      detail: {
        code: 'unsupported_component',
        components: [c.u],
        detail: { reason: 'runtime_capability', runtimeCapabilities: [] },
      },
    });
  });

  it('the firmware driving ECHO while edges are pending cancels them: X + pad_contention (T-R2-10)', async () => {
    const fall = 'G 9510000 13 1 0';
    const drive = 'G 9600000 14 1 0';
    const s = start(sonarCircuit(5, false), [RISE, fall, drive]);
    const text = await runUntil(s, /REPLY G 9600000/);
    expect(text).toMatch(/REPLY G 9600000 14 1 0 -> X 14/);
    expect(diag(s, 'pad_contention')).toHaveLength(1);
  });
});

/** Decode a DHT22 frame from the scheduled DATA edges (high durations: 26-28 us 0, 70 us 1). */
function decodeEdges(j: { vns: bigint; level: number }[]): number[] {
  const highs: number[] = [];
  for (let i = 0; i + 1 < j.length; i++)
    if (j[i]!.level === 1) highs.push(Number(j[i + 1]!.vns - j[i]!.vns) / 1000);
  // highs[0] is the 80 us response; then one per bit.
  const bits = highs.slice(1, 41).map((us) => (us > 50 ? 1 : 0));
  const bytes: number[] = [];
  for (let b = 0; b < 5; b++)
    bytes.push(bits.slice(b * 8, b * 8 + 8).reduce<number>((a, x) => (a << 1) | x, 0));
  return bytes;
}

describe('DHT22 driver (scheduled frame)', () => {
  const LOW = '1300@G 1299100000 4 1 0';
  const REL = 'G 1300200000 4 0 0';
  const rel = REL;

  it('a 1.1 ms start signal gets the oracle frame after T_go (T-R2-7)', async () => {
    const s = start(dhtCircuit(), [LOW, `1301@${REL}`]);
    const text = await runUntil(s, /REPLY G 1300200000/, 15_000);
    const j = js(text, rel);
    expect(j.every((x) => x.pad === 4)).toBe(true);
    expect(j[0]).toEqual({ vns: 1_300_200_000n + DHT22_TGO_NS, pad: 4, level: 0 });
    expect(j).toHaveLength(84); // 83 waveform segments + the final release
    expect(decodeEdges(j)).toEqual(dht22Frame(55.2, -10.3));
    expect(j.at(-1)!.level).toBe(1);
  });

  it('no pull-up: the released level is LOW, so no edge is scheduled at all (T-R2-8)', async () => {
    const text = await runUntil(
      start(dhtCircuit(null), [LOW, `1301@${REL}`]),
      /REPLY G 1300200000/,
      15_000,
    );
    expect(js(text, rel)).toEqual([]);
  });

  it('a start within 1 s of power-up or 2 s of the last answer gets no response (T-R2-9)', async () => {
    const early = ['500@G 499100000 4 1 0', '501@G 500200000 4 0 0'];
    const s = start(dhtCircuit(), [
      ...early,
      LOW,
      `1301@${REL}`,
      '2000@G 1999100000 4 1 0',
      '2001@G 2000200000 4 0 0',
    ]);
    const text = await runUntil(s, /REPLY G 2000200000/, 20_000);
    expect(js(text, 'G 500200000 4 0 0')).toEqual([]);
    expect(js(text, rel)).toHaveLength(84);
    expect(js(text, 'G 2000200000 4 0 0')).toEqual([]);
    expect(
      diag(s, 'sensor_no_response').map((e) => (e as { detail: { reason: string } }).detail.reason),
    ).toEqual(['power_up', 'collecting_period']);
  });
});

describe('J budget (T-SEC-2)', () => {
  it('a trigger flood beyond the per-second budget gets input_schedule_full, never a partial echo', () => {
    const c = sonarCircuit(5, true, 0.02);
    const snap = createSnapshot(c.doc);
    const engine = new EngineSession(snap, { pins: c.attachments });
    const levels = new Map<number, 0 | 1>();
    const schedule = new InputSchedule();
    const dev = new RuntimeDevices(snap, engine, [13, 14], levels, schedule);
    const solve = (t: bigint) => {
      dev.advance(t);
      schedule.advance(t);
      const o = engine.solve();
      if (!o.ok) throw new Error(o.error.code);
      return dev.observe(t, o);
    };
    let scheduled = 0;
    // A 2 cm echo ends 317 us after the trigger: a 400 us cycle is never busy.
    for (let i = 0; i < 3000; i++) {
      const t = 10_000_000n + BigInt(i) * 400_000n;
      engine.setPinMode(13, 'output-high');
      solve(t);
      engine.setPinMode(13, 'output-low');
      const j = solve(t + 10_000n);
      for (const x of j) if (x.type === 'J') schedule.add(x.vns, x.pad);
      expect([0, 2]).toContain(j.length); // all or nothing
      scheduled += j.length;
    }
    const full = dev.diagnostics.filter((d) => d.d.code === 'input_schedule_full');
    expect(full.length).toBeGreaterThan(0);
    expect(full[0]!.d.detail).toMatchObject({ reason: 'budget' });
    // Each simulated second gets at most the budget.
    expect(scheduled).toBeLessThanOrEqual(J_BUDGET_PER_SIM_S * 2);
  });
});
