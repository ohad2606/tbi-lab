/**
 * Sprint 12 (R3, S12-8): the Session Host's I2C side against the engine. Electrical gating at
 * START (wiring, idle levels through solver-visible pull-ups, power), the LCD content through the
 * engine's HD44780/PCF8574 model, and the refusals (T-R3-3, -6..-8, -10..-13, T-SEC-3 at unit
 * level; the real-QEMU versions are in runtime/tests). Also the full Session Host with the fake
 * runtime: B frames in, the display text in the published operating point.
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
import { EngineSession, LCD1602_DC, type SolveSuccess } from '@tbi-lab/engine';
import { principalFor, ticketFor } from '../../identity/test-gate.js';
import type { I2cPhase } from '../../harness/protocol.js';
import type { SessionHost } from '../host.js';
import { I2C_PHASE_BUDGET_PER_SIM_S, I2cDevices, i2cAddressConflict } from '../i2cDevices.js';
import { PROTOCOL, type CreateSessionRequest } from '../protocol.js';
import { fakeHost, waitState } from './support.js';

interface Opts {
  lcdV?: number;
  pullUpV?: number | null;
  swapped?: boolean;
  address?: string;
  second?: string;
}

/** PSU1 -> LCD VCC; PSU2 -> 4.7 kΩ pull-ups on SDA and SCL; GPIO21/22 on SDA/SCL. */
function lcdCircuit(o: Opts = {}) {
  let doc: ProjectDocument = createProject({
    projectId: 'prj_r3',
    deviceId: 'd',
    name: 'R3',
    appVersion: '0',
  });
  let x = 0;
  const add = (t: ComponentTypeId) => {
    x += 200;
    const r = addComponent(doc, t, { x, y: 400 });
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
    return r.id;
  };
  const wire = (a: string, b: string) => {
    const [ac, at] = a.split('.') as [string, string];
    const [bc, bt] = b.split('.') as [string, string];
    const r = addWire(
      doc,
      { kind: 'terminal', component: ac, terminal: at },
      { kind: 'terminal', component: bc, terminal: bt },
    );
    if (!r.ok) throw new Error(`${a}-${b}: ${r.error}`);
    doc = r.doc;
  };
  const set = (id: string, k: string, v: ParamValue) => {
    const r = setParam(doc, id, k, v);
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
  };
  const lcd = add('display.lcd1602_i2c');
  if (o.address) set(lcd, 'address', o.address);
  set('PSU1', 'setpointVoltage', { value: o.lcdV ?? 4.5, unit: 'volt' });
  set('PSU1', 'outputEnabled', true);
  wire('PSU1.positive', `${lcd}.vcc`);
  wire(`${lcd}.gnd`, 'GND1.ref');
  wire('PSU1.negative', 'GND1.ref');
  if (o.pullUpV !== null) {
    const p2 = add('instrument.lab_psu');
    set(p2, 'setpointVoltage', { value: o.pullUpV ?? 3.3, unit: 'volt' });
    set(p2, 'outputEnabled', true);
    wire(`${p2}.negative`, 'GND1.ref');
    for (const line of ['sda', 'scl']) {
      const r = add('component.resistor');
      set(r, 'resistance', { value: 4700, unit: 'ohm' });
      wire(`${r}.a`, `${p2}.positive`);
      wire(`${r}.b`, `${lcd}.${line}`);
    }
  }
  let lcd2: string | null = null;
  if (o.second) {
    lcd2 = add('display.lcd1602_i2c');
    set(lcd2, 'address', o.second);
    wire('PSU1.positive', `${lcd2}.vcc`);
    wire(`${lcd2}.gnd`, 'GND1.ref');
    wire(`${lcd2}.sda`, `${lcd}.sda`);
    wire(`${lcd2}.scl`, `${lcd}.scl`);
  }
  const attachments = [
    { gpio: 21, component: lcd, terminal: o.swapped ? 'scl' : 'sda' },
    { gpio: 22, component: lcd, terminal: o.swapped ? 'sda' : 'scl' },
  ];
  return { doc, attachments, lcd, lcd2 };
}

function bench(o: Opts = {}) {
  const c = lcdCircuit(o);
  const snap = createSnapshot(c.doc);
  const engine = new EngineSession(snap, { pins: c.attachments });
  const dev = new I2cDevices(snap, c.attachments);
  dev.onFunc(21, 'i2c0-sda');
  dev.onFunc(22, 'i2c0-scl');
  let t = 1_000_000_000n;
  const solve = (): SolveSuccess => {
    const o2 = engine.solve();
    if (!o2.ok) throw new Error(o2.error.code);
    for (const ch of dev.power(o2)) engine.setPartRuntime(ch.id, 'backlight', ch.backlight);
    return o2;
  };
  let out = solve();
  const phase = (p: I2cPhase) => dev.phase((t += 10_000n), 0, p, out);
  /** START + bytes + STOP; whether the address was acknowledged. */
  const write = (addr: number, bytes: number[]) => {
    const ack = phase({ op: 'S', addr, read: false });
    for (const b of bytes) phase({ op: 'W', byte: b });
    phase({ op: 'P' });
    return ack;
  };
  // The probe's 4-bit HD44780 sequence through the backpack (P2 = E, P3 = backlight).
  const pulse = (v: number) => write(0x27, [v | 0x04, v & ~0x04]);
  const nibble = (n: number, rs: number) => pulse((n << 4) | 0x08 | rs);
  const byte = (b: number, rs: number) => (nibble(b >> 4, rs), nibble(b & 0x0f, rs));
  const init = () => {
    nibble(3, 0);
    nibble(3, 0);
    nibble(3, 0);
    nibble(2, 0);
    for (const b of [0x28, 0x0c, 0x01, 0x06]) byte(b, 0);
  };
  const text = (s: string) => {
    for (const ch of s) byte(ch.charCodeAt(0), 1);
  };
  return { c, dev, engine, phase, write, init, text, resolve: () => (out = solve()) };
}

const codes = (dev: I2cDevices) => dev.diagnostics.map((d) => d.d.code);

describe('I2C LCD on the Session Host (engine-gated)', () => {
  it('in-spec wiring (4.5 V module, 3.3 V pull-ups): ACK, and the display shows the text (T-R3-6)', () => {
    const b = bench();
    expect(b.write(0x27, [0x08])).toBe(true);
    b.init();
    b.text('Hello');
    const st = b.dev.displayState()[b.c.lcd]!;
    expect(st).toMatchObject({ backlight: true, displayOn: true });
    expect(st.line1).toBe('Hello' + ' '.repeat(11));
    expect(st.line2).toBe(' '.repeat(16));
    expect(codes(b.dev)).toEqual([]);
  });

  it('only the configured address answers; 0x48 (the removed TMP105) does not (T-R3-3, -8)', () => {
    const b = bench({ address: 'i2c.0x20' });
    const acks = [];
    for (let a = 1; a < 127; a++) if (b.write(a, [])) acks.push(a);
    expect(acks).toEqual([0x20]);
  });

  it('backlight bit off: the display state and the supply current follow (T-R3-7)', () => {
    const b = bench();
    const supply = () => b.resolve().components[b.c.lcd]!.currents!.supply!;
    expect(supply()).toBeCloseTo(LCD1602_DC.logicA + LCD1602_DC.backlightA, 12);
    b.write(0x27, [0x00]);
    b.engine.setPartRuntime(b.c.lcd, 'backlight', b.dev.backlight(b.c.lcd));
    expect(b.dev.displayState()[b.c.lcd]!.backlight).toBe(false);
    expect(supply()).toBeCloseTo(LCD1602_DC.logicA, 12);
  });

  it('5 V module with 3.3 V pull-ups: below the PCF8574 V_IH, NACK and i2c_logic_level', () => {
    const b = bench({ lcdV: 5 });
    expect(b.write(0x27, [0x08])).toBe(false);
    expect(codes(b.dev)).toEqual(['i2c_logic_level']);
    const d = b.dev.diagnostics[0]!.d.detail as { lines: { requiredVolts: number }[] };
    expect(d.lines[0]!.requiredVolts).toBeCloseTo(3.5, 9);
  });

  it('no pull-ups: NACK and i2c_no_pullup (T-R3-11)', () => {
    const b = bench({ pullUpV: null });
    expect(b.write(0x27, [0x08])).toBe(false);
    expect(codes(b.dev)).toEqual(['i2c_no_pullup']);
  });

  it('SDA and SCL swapped: NACK and i2c_wiring (T-R3-10)', () => {
    const b = bench({ swapped: true });
    expect(b.write(0x27, [0x08])).toBe(false);
    expect(codes(b.dev)).toEqual(['i2c_wiring']);
  });

  it('module under-voltage (3.3 V < 4.5 V): NACK, unpowered (T-R3-12)', () => {
    const b = bench({ lcdV: 3.3 });
    expect(b.write(0x27, [0x08])).toBe(false);
    expect(b.dev.displayState()[b.c.lcd]).toMatchObject({ backlight: false, displayOn: false });
  });

  it('two displays at one address on one bus: conflict named; different addresses are fine (T-R3-13)', () => {
    const same = lcdCircuit({ second: 'i2c.0x27' });
    expect(i2cAddressConflict(createSnapshot(same.doc))).toEqual([same.lcd, same.lcd2]);
    expect(i2cAddressConflict(createSnapshot(lcdCircuit({ second: 'i2c.0x26' }).doc))).toBeNull();
  });

  it('phases beyond the per-second budget are NACKed with i2c_rate_exceeded (T-SEC-3)', () => {
    const b = bench();
    let refused = 0;
    for (let i = 0; i <= I2C_PHASE_BUDGET_PER_SIM_S; i++)
      if (b.dev.phase(2_000_000_000n + BigInt(i), 0, { op: 'W', byte: 0 }, null) === false)
        refused++;
    expect(codes(b.dev)).toContain('i2c_rate_exceeded');
    expect(refused).toBeGreaterThan(0);
  });
});

// ---- through the Session Host (fake runtime) ----------------------------------------------------

const hosts: SessionHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.shutdown()));
});

describe('I2C through the Session Host', () => {
  function start(
    c: ReturnType<typeof lcdCircuit>,
    frames: string[],
    hello = '2 i2c,pad-func,sched-input',
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
  const end = async (s: ReturnType<typeof start>, ms = 400) => {
    s.run();
    await waitState(s, 'running');
    await new Promise((r) => setTimeout(r, ms));
    s.stop();
    await Promise.race([waitState(s, 'failed', 15_000), waitState(s, 'ended', 15_000)]);
    await s.done();
    return s.status();
  };

  it('B frames write "Hi"; the published LCD result carries the text and the backlight', async () => {
    const t0 = 9_500_000;
    const frames = ['F 9500000 21 i2c0-sda 1', 'F 9500001 22 i2c0-scl 1'];
    let t = t0 + 10;
    const write = (bytes: number[]) => {
      frames.push(`B ${t++} 0 S 27 0`);
      for (const b of bytes) frames.push(`B ${t++} 0 W ${b.toString(16).padStart(2, '0')}`);
      frames.push(`B ${t++} 0 P`);
    };
    const nibble = (n: number, rs: number) => {
      const v = (n << 4) | 0x08 | rs;
      write([v | 0x04, v & ~0x04]);
    };
    const byte = (v: number, rs: number) => (nibble(v >> 4, rs), nibble(v & 15, rs));
    [3, 3, 3, 2].forEach((n) => nibble(n, 0));
    [0x28, 0x0c, 0x01, 0x06].forEach((v) => byte(v, 0));
    byte(0x48, 1);
    byte(0x69, 1);
    const c = lcdCircuit();
    const s = start(c, frames);
    expect(await end(s)).toMatchObject({ state: 'ended' });
    const last = s.log
      .since(0)
      .filter((e) => e.type === 'electrical')
      .at(-1) as { outcome: { components: Record<string, { state: Record<string, unknown> }> } };
    expect(last.outcome.components[c.lcd]!.state).toMatchObject({
      powered: true,
      backlight: true,
      displayOn: true,
      line1: 'Hi' + ' '.repeat(14),
    });
  });

  it('on a runtime without i2c the session is refused naming the display', async () => {
    const c = lcdCircuit();
    const s = start(c, [], '2 sched-input');
    s.run();
    await Promise.race([waitState(s, 'failed', 15_000), waitState(s, 'ended', 15_000)]);
    await s.done();
    expect(s.status()).toMatchObject({
      reason: 'electrical_error',
      detail: { code: 'unsupported_component', components: [c.lcd] },
    });
  });

  it('two displays at one address: refused before the runtime starts', () => {
    const c = lcdCircuit({ second: 'i2c.0x27' });
    const s = start(c, []);
    expect(s.status()).toMatchObject({
      state: 'failed',
      reason: 'electrical_error',
      detail: { code: 'i2c_address_conflict', components: [c.lcd, c.lcd2] },
    });
  });
});
