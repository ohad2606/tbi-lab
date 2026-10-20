/**
 * Sprint 15 (R4) on the REAL runtime (Runtime v3: patches 0001-0009) with the pinned R4 firmware.
 *
 * Harness level (no Session Host):
 * - T-R4-1: the 3.3.12 driver's LEDC programming becomes P/W frames whose waveform equals hand
 *   calculation exactly: analogWrite (1 kHz, 8 bit, REF_TICK) 25 %, 50 %, high; ledcAttach 5 kHz /
 *   12 bit (APB) 25 %, 50 %, high; a second channel at 1 kHz; ledcDetach returns the pad to GPIO.
 * - T-R4-3: the frame stream (P, W, F with their virtual times) is identical across runs.
 * - A ninth channel lands in the low-speed group and is reported unsupported.
 * - Sprint 17C (review M2): a CPU clock below 80 MHz republishes the APB timer; refused.
 * Session Host level:
 * - T-R4-5: LED and resistor loads on PWM pads: the published currents are the exact duty-weighted
 *   averages of the engine's own two operating points (the reference), peaks kept.
 * - T-R4-4: an SG90 follows 1.0 / 2.0 / 1.5 ms pulses: commanded 0, 180, ~90 deg; exact widths.
 */
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { SolveSuccess } from '@tbi-lab/engine';
import { createSessionOverlay } from '../harness/artifacts.js';
import { QEMU, artifact, assertProvisioned, recordEvidence } from '../harness/env.js';
import { runSession } from '../harness/session.js';
import { LedcTracker, ratToNumber, type Waveform } from '../host/pwm.js';
import { principalFor, ticketFor } from '../identity/test-gate.js';
import type { TicketFeatures } from '../identity/ticket.js';
import type { HostSession } from '../host/session.js';
import { Circuit, reference } from '../host/tests/r1-support.js';
import { waitState } from '../host/tests/support.js';
import { realHost } from './r2-support.js';

const host = realHost();
afterAll(() => host.shutdown());

const PWM_FEATURES: TicketFeatures = {
  internalPull: [],
  gpioInterrupt: [],
  restart: false,
  unsupported: [],
  requires: ['pwm'],
};

interface Trace {
  frames: string[];
  serial: { vns: bigint; text: string }[];
  /** The waveform on `pad` at `vns` (tracker fed with the frames up to then). */
  waveAt(pad: number, vns: bigint): Waveform | { kind: 'gpio' };
  marker(tag: string): bigint;
}

/** Run a firmware on the bare harness, recording the LEDC and routing frames. */
async function trace(name: string, simMs: number): Promise<Trace> {
  assertProvisioned();
  const fw = artifact(name);
  const ov = createSessionOverlay(fw.path, fw.sha256);
  const frames: string[] = [];
  const events: ({ vns: bigint } & (
    | { k: 'P'; timer: number; state: never }
    | { k: 'W'; signal: number; state: never }
    | { k: 'F'; pad: number; func: string }
  ))[] = [];
  const serial: { vns: bigint; text: string }[] = [];
  try {
    const r = await runSession(
      { qemu: QEMU, flash: ov.flash, dir: ov.dir, wallTimeoutMs: 600_000 },
      {
        serial: (vns, b) => void serial.push({ vns, text: b.toString('latin1') }),
        func: (e) => {
          frames.push(`F ${e.vns} ${e.pad} ${e.func} ${e.openDrain ? 1 : 0}`);
          events.push({ vns: e.vns, k: 'F', pad: e.pad, func: e.func });
          return [];
        },
        pwm: (e) => {
          const st = JSON.stringify(e.state);
          if ('timer' in e) {
            frames.push(`P ${e.vns} ${e.timer} ${st}`);
            events.push({ vns: e.vns, k: 'P', timer: e.timer, state: e.state as never });
          } else {
            frames.push(`W ${e.vns} ${e.signal} ${st}`);
            events.push({ vns: e.vns, k: 'W', signal: e.signal, state: e.state as never });
          }
          return [];
        },
        tick: (vns) => (vns >= BigInt(simMs) * 1_000_000n ? [{ type: 'Q' }] : []),
      },
    );
    expect(r.outcome).toBe('completed');
  } finally {
    ov.discard();
  }
  const text = serial.map((s) => s.text).join('');
  return {
    frames,
    serial,
    marker(tag) {
      let acc = '';
      for (const s of serial) {
        acc += s.text;
        if (acc.includes(`${tag}\n`) || acc.includes(`${tag}\r\n`)) return s.vns;
      }
      throw new Error(`no marker ${tag} in ${JSON.stringify(text.slice(0, 400))}`);
    },
    waveAt(pad, vns) {
      const t = new LedcTracker();
      let routed: number | null = null;
      for (const e of events) {
        if (e.vns > vns) break;
        t.advance(e.vns);
        if (e.k === 'P') t.timer(e.vns, e.timer, e.state);
        else if (e.k === 'W') t.channel(e.vns, e.signal, e.state);
        else if (e.pad === pad)
          routed = e.func.startsWith('periph:') ? Number(e.func.slice(7)) : null;
      }
      t.advance(vns);
      return routed === null ? { kind: 'gpio' } : t.waveform(routed);
    },
  };
}

const wave = (w: Waveform | { kind: 'gpio' }) => {
  if (w.kind !== 'wave') throw new Error(`not a wave: ${JSON.stringify(w)}`);
  return { periodNs: ratToNumber(w.periodNs), highNs: ratToNumber(w.highNs), duty: w.duty };
};
const MS = 1_000_000n;

describe('R4 on the real runtime (harness level)', () => {
  it('T-R4-1/-3: LEDC waveforms equal hand calculation; the frame stream is deterministic', async () => {
    const a = await trace('TbiPwm', 1600);
    // 25 ms into each 50 ms step: well past the cycle boundary where the duty takes effect.
    const mid = (tag: string) => a.marker(tag) + 25n * MS;
    expect(wave(a.waveAt(2, mid('PWM A64')))).toEqual({
      periodNs: 1_000_000,
      highNs: 250_000,
      duty: 0.25,
    });
    expect(wave(a.waveAt(2, mid('PWM A128')))).toEqual({
      periodNs: 1_000_000,
      highNs: 500_000,
      duty: 0.5,
    });
    expect(a.waveAt(2, mid('PWM A255'))).toEqual({ kind: 'static', level: 1 });
    expect(wave(a.waveAt(4, mid('PWM L1024')))).toEqual({
      periodNs: 200_000,
      highNs: 50_000,
      duty: 0.25,
    });
    expect(wave(a.waveAt(4, mid('PWM L2048')))).toEqual({
      periodNs: 200_000,
      highNs: 100_000,
      duty: 0.5,
    });
    expect(a.waveAt(4, mid('PWM L4096'))).toEqual({ kind: 'static', level: 1 });
    expect(wave(a.waveAt(5, mid('PWM L5-64')))).toEqual({
      periodNs: 1_000_000,
      highNs: 250_000,
      duty: 0.25,
    });
    // ledcDetach: GPIO4 is simple GPIO again (its level then arrives as G frames).
    expect(a.waveAt(4, mid('PWM D4-HIGH'))).toEqual({ kind: 'gpio' });
    // Duty 0 never takes effect on the routed pads (every attach is followed by its first write).
    for (const tag of ['PWM A64', 'PWM L1024', 'PWM L5-64'])
      for (const pad of [2, 4, 5])
        expect(a.waveAt(pad, mid(tag)).kind, `${tag} GPIO${pad}`).not.toBe('zero');

    const b = await trace('TbiPwm', 1600);
    expect(b.frames).toEqual(a.frames);
    const fingerprint = createHash('sha256').update(a.frames.join('\n')).digest('hex');
    recordEvidence('s15-r4-pwm-frames', {
      frames: a.frames.length,
      fingerprint,
      sample: a.frames.slice(0, 40),
    });
  }, 900_000);

  it('a ninth channel is in the low-speed group: reported unsupported, on its routed pad', async () => {
    const t = await trace('TbiPwmLs', 1300);
    const w = t.waveAt(17, t.marker('LS-DONE') + 5n * MS);
    expect(w).toEqual({ kind: 'unsupported', why: 'low-speed' });
    for (const pad of [2, 4, 5, 12, 13, 14, 15, 16])
      expect(wave(t.waveAt(pad, t.marker('LS-DONE') + 5n * MS)).duty, `GPIO${pad}`).toBe(0.5);
  }, 900_000);

  it('review M8: GPIO-matrix inversion is reported on its pad (patch 0010), set by API or below it', async () => {
    const t = await trace('TbiPwmInv', 1300);
    const funcs = (pad: number, from: string, to: string) =>
      t.frames
        .filter((f) => f.startsWith('F '))
        .map((f) => f.split(' '))
        .filter(
          ([, vns, p]) =>
            Number(p) === pad && BigInt(vns!) > t.marker(from) && BigInt(vns!) <= t.marker(to),
        )
        .map(([, , , func]) => func);
    const sig18 = t.frames.find((f) => / 18 periph:\d+ /.test(f))!.split(' ')[3]!;
    const sig19 = t.frames.find((f) => / 19 periph:\d+ /.test(f))!.split(' ')[3]!;
    expect(sig18).toMatch(/^periph:(7[1-8])$/);
    // ledcOutputInvert(18, true / false): inverted on the same LEDC signal, then back.
    expect(funcs(18, 'INV-ATTACHED', 'INV-API')).toEqual([sig18.replace('periph', 'inverted')]);
    expect(funcs(18, 'INV-API', 'INV-OFF')).toEqual([sig18]);
    // Below the Arduino API (what the build service cannot see).
    expect(funcs(19, 'INV-OFF', 'INV-MATRIX')).toEqual([sig19.replace('periph', 'inverted')]);
    // A simple GPIO output inverted through the matrix, then restored.
    expect(funcs(21, 'INV-MATRIX', 'INV-GPIO')).toEqual(['inverted:256']);
    expect(funcs(21, 'INV-GPIO', 'INV-INPUT')).toEqual(['gpio']);
    // GPIO22: the ROM routine also enables the output (it reports INV-EN22 1), so the pad drives
    // and its inversion is reported; once the firmware clears GPIO_ENABLE it is an input with
    // OUT_INV still set, which drives nothing: the report is withdrawn (simple GPIO again).
    const text = t.serial.map((x) => x.text).join('');
    const en22 = /INV-EN22 (\d)/.exec(text)![1];
    expect(en22).toBe('1');
    // pinMode(INPUT) passes OUT_SEL 0 before OEN_SEL (the known two-write transient), then the ROM
    // call leaves the pad driving, inverted; after GPIO_ENABLE is cleared, simple GPIO again.
    const p22 = funcs(22, 'INV-INPUT', `INV-EN22 ${en22}`);
    expect(p22.at(-1)).toBe('inverted:256');
    expect(funcs(22, `INV-EN22 ${en22}`, 'INV-DONE')).toEqual(['gpio']);
    recordEvidence('s15-r4-m8-gpio22', { en22, p22 });
    // Deterministic like every other frame stream.
    const again = await trace('TbiPwmInv', 1300);
    expect(again.frames).toEqual(t.frames);
    recordEvidence('s15-r4-m8-inversion', {
      frames: t.frames.length,
      fingerprint: createHash('sha256').update(t.frames.join('\n')).digest('hex'),
      inverted: t.frames.filter((f) => f.includes(' inverted:')),
    });
  }, 900_000);

  it('Sprint 17C (review M2): setCpuFrequencyMhz(40) republishes the APB timer at 40 MHz; the tracker refuses it', async () => {
    const t = await trace('TbiPwmApb', 1000);
    const text = t.serial.map((x) => x.text).join('');
    expect(text).toContain('APB 80 80000000');
    expect(text).toContain('APB 40 40000000');
    // 5 kHz / 8 bit on APB at 80 MHz, 25 %: exact.
    expect(wave(t.waveAt(18, t.marker('APB 80 80000000') + 25n * MS))).toEqual({
      periodNs: 200_000,
      highNs: 50_000,
      duty: 0.25,
    });
    // QEMU republishes the running timer with the new APB clock; the model refuses it at once.
    const slow = t.frames.filter((f) => /^P \d+ 0 .*"clockHz":40000000/.test(f));
    expect(slow).toHaveLength(1);
    const at = BigInt(slow[0]!.split(' ')[1]!);
    expect(at).toBeLessThan(t.marker('APB 40 40000000'));
    expect(t.waveAt(18, at)).toEqual({ kind: 'unsupported', why: 'timer-apb-clock' });
    expect(t.waveAt(18, t.marker('APB 40 40000000') + 1n * MS)).toEqual({
      kind: 'unsupported',
      why: 'timer-apb-clock',
    });
    const again = await trace('TbiPwmApb', 1000);
    expect(again.frames).toEqual(t.frames);
    recordEvidence('s17c-r4-m2-apb', {
      frames: t.frames.length,
      fingerprint: createHash('sha256').update(t.frames.join('\n')).digest('hex'),
      slow: slow[0],
    });
  }, 900_000);
});

// ---------------------------------------------------------------------------------------------
// Session Host level

const terminal = async (s: HostSession) => {
  await Promise.race([waitState(s, 'failed', 600_000), waitState(s, 'ended', 600_000)]);
  await s.done();
  return s.status();
};
async function runUntil(s: HostSession, marker: string) {
  s.run();
  await waitState(s, 'running', 120_000);
  const deadline = Date.now() + 600_000;
  for (;;) {
    const text = s.log
      .since(0)
      .filter((e) => e.type === 'serial')
      .map((e) => Buffer.from((e as unknown as { data: string }).data, 'base64').toString('latin1'))
      .join('');
    const st = s.status().state;
    if (text.includes(marker) || st === 'failed' || st === 'ended' || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  s.stop();
  return terminal(s);
}
/** The published outcome at the end of the window that holds `tag` + `afterMs`. */
function outcomeAfter(s: HostSession, tag: string, afterMs: number): SolveSuccess {
  const events = s.log.since(0);
  let acc = '';
  let at: bigint | null = null;
  for (const e of events) {
    if (e.type !== 'serial') continue;
    acc += Buffer.from((e as unknown as { data: string }).data, 'base64').toString('latin1');
    if (acc.includes(`${tag}\n`) || acc.includes(`${tag}\r\n`)) {
      at = BigInt(e.simNs!);
      break;
    }
  }
  if (at === null) throw new Error(`no ${tag}`);
  const want = at + BigInt(afterMs) * MS;
  const el = events.filter((e) => e.type === 'electrical' && BigInt(e.simNs!) <= want).at(-1)!;
  return (el as unknown as { outcome: SolveSuccess }).outcome;
}

describe('R4 on the real runtime (Session Host)', () => {
  it('T-R4-5: LED on analogWrite and resistors on ledcWrite: exact averages of the reference points', async () => {
    const c = new Circuit();
    const r1 = c.add('component.resistor');
    const d1 = c.add('component.led');
    const r4 = c.add('component.resistor');
    const r5 = c.add('component.resistor');
    c.ohms(r1, 220).ohms(r4, 1000).ohms(r5, 2200);
    c.wire(`${r1}.b`, `${d1}.anode`).wire(`${d1}.cathode`, 'GND1.ref');
    c.wire(`${r4}.b`, 'GND1.ref').wire(`${r5}.b`, 'GND1.ref');
    c.pad(2, `${r1}.a`).pad(4, `${r4}.a`).pad(5, `${r5}.a`);
    const fw = artifact('TbiPwm');
    const req = c.request(fw.sha256);
    req.ticket = ticketFor(fw.sha256, principalFor(), PWM_FEATURES);
    const created = host.create(req, principalFor());
    if (!created.ok) throw new Error(created.error);
    const s = created.value.session;
    expect(await runUntil(s, 'PWM-DONE')).toMatchObject({ state: 'ended', reason: 'stopped' });
    const hiLed = reference(req, { 2: 'output-high' }).components[d1]!.current!;
    const hi4 = reference(req, { 4: 'output-high' }).components[r4]!.current!;
    const hi5 = reference(req, { 5: 'output-high' }).components[r5]!.current!;
    const led = (tag: string) => outcomeAfter(s, tag, 30).components[d1]!;
    expect(led('PWM A64').current).toBeCloseTo(0.25 * hiLed, 12);
    expect(led('PWM A64').pwm!.peakCurrent).toBeCloseTo(hiLed, 12);
    expect(led('PWM A128').current).toBeCloseTo(0.5 * hiLed, 12);
    expect(led('PWM A255').current).toBeCloseTo(hiLed, 12);
    expect(outcomeAfter(s, 'PWM L1024', 30).components[r4]!.current).toBeCloseTo(0.25 * hi4, 12);
    expect(outcomeAfter(s, 'PWM L2048', 30).components[r4]!.current).toBeCloseTo(0.5 * hi4, 12);
    // Two PWM pads at once (GPIO2 high, GPIO5 at 25 %): independent loads, each exact.
    const both = outcomeAfter(s, 'PWM L5-64', 30);
    expect(both.components[r5]!.current).toBeCloseTo(0.25 * hi5, 12);
    expect(both.components[d1]!.current).toBeCloseTo(hiLed, 12);
    // After ledcDetach + digitalWrite(4, HIGH): plain GPIO, a static high operating point.
    expect(outcomeAfter(s, 'PWM D4-HIGH', 30).components[r4]!.current).toBeCloseTo(hi4, 12);
    recordEvidence('s15-r4-led-averages', {
      hiLedA: hiLed,
      a64: led('PWM A64').current,
      a128: led('PWM A128').current,
      a255: led('PWM A255').current,
    });
  }, 900_000);

  it('review M8: an LED on an LEDC output that the firmware inverts is refused by name', async () => {
    const c = new Circuit();
    const r1 = c.add('component.resistor');
    const d1 = c.add('component.led');
    c.ohms(r1, 220).wire(`${r1}.b`, `${d1}.anode`).wire(`${d1}.cathode`, 'GND1.ref');
    c.pad(18, `${r1}.a`);
    const fw = artifact('TbiPwmInv');
    const req = c.request(fw.sha256);
    req.ticket = ticketFor(fw.sha256, principalFor(), PWM_FEATURES);
    const created = host.create(req, principalFor());
    if (!created.ok) throw new Error(created.error);
    const s = created.value.session;
    expect(await runUntil(s, 'INV-DONE')).toMatchObject({
      state: 'failed',
      reason: 'pwm_unsupported',
      detail: { code: 'pwm_unsupported_mode', gpio: 18, why: 'inverted' },
    });
    // Before the inversion the LED was simulated as usual (25 % average); after it, nothing
    // else was published (review M3: no placeholder "solved low" during the grace tick).
    const hiLed = reference(req, { 18: 'output-high' }).components[d1]!.current!;
    const leds = s.log
      .since(0)
      .filter((e) => e.type === 'electrical')
      .map((e) => (e as unknown as { outcome: SolveSuccess }).outcome.components[d1]!.current!);
    expect(leds.at(-1)).toBeCloseTo(0.25 * hiLed, 12);
    expect(leds.filter((i) => i > 0).length).toBeGreaterThan(0);
  }, 900_000);

  it('Sprint 17C (review M2): an LED on PWM is refused by name when the CPU drops below 80 MHz', async () => {
    const c = new Circuit();
    const r1 = c.add('component.resistor');
    const d1 = c.add('component.led');
    c.ohms(r1, 220).wire(`${r1}.b`, `${d1}.anode`).wire(`${d1}.cathode`, 'GND1.ref');
    c.pad(18, `${r1}.a`);
    const fw = artifact('TbiPwmApb');
    const req = c.request(fw.sha256);
    req.ticket = ticketFor(fw.sha256, principalFor(), PWM_FEATURES);
    const created = host.create(req, principalFor());
    if (!created.ok) throw new Error(created.error);
    const s = created.value.session;
    // The refusal comes within a tick of the change, before the emulator stalls (F-17C-1).
    expect(await runUntil(s, 'APB 40 40000000')).toMatchObject({
      state: 'failed',
      reason: 'pwm_unsupported',
      detail: { code: 'pwm_unsupported_mode', gpio: 18, why: 'timer-apb-clock' },
    });
    // At 80 MHz the LED was simulated (exact 25 % average); nothing was published at 40 MHz.
    const hiLed = reference(req, { 18: 'output-high' }).components[d1]!.current!;
    expect(outcomeAfter(s, 'APB 80 80000000', 25).components[d1]!.current).toBeCloseTo(
      0.25 * hiLed,
      12,
    );
  }, 900_000);

  it('T-R4-4: an SG90 follows 1.0 / 2.0 / 1.5 ms pulses from ledcWrite (exact widths, 600 deg/s)', async () => {
    const c = new Circuit();
    const m = c.add('component.servo_sg90');
    c.psu(5).wire('PSU1.positive', `${m}.vcc`).wire(`${m}.gnd`, 'GND1.ref');
    c.pad(18, `${m}.signal`);
    const fw = artifact('TbiServo');
    const req = c.request(fw.sha256);
    req.ticket = ticketFor(fw.sha256, principalFor(), PWM_FEATURES);
    const created = host.create(req, principalFor());
    if (!created.ok) throw new Error(created.error);
    const s = created.value.session;
    expect(await runUntil(s, 'SERVO-DONE')).toMatchObject({ state: 'ended', reason: 'stopped' });
    const st = (tag: string) => outcomeAfter(s, tag, 380).components[m]!.state!;
    const exact = (duty: number) => (duty * 6250 * 1e9) / 256 / 80e6 / 1000; // us
    const a = st('SERVO 3277');
    expect(Math.abs((a.pulseUs as number) - exact(3277))).toBeLessThanOrEqual(0.001);
    // The model maps the width it received (whole-ns edges, <= 1 ns from exact) to its angle.
    const deg = (us: number) => ((us - 1000) / 1000) * 180;
    expect(a.angleDeg as number).toBeCloseTo(deg(a.pulseUs as number), 9);
    const b = st('SERVO 6554');
    expect(Math.abs((b.pulseUs as number) - exact(6554))).toBeLessThanOrEqual(0.001);
    expect(b).toMatchObject({ commandedDeg: 180, angleDeg: 180, signal: 'pulses', powered: true });
    const c3 = st('SERVO 4915');
    expect(Math.abs((c3.pulseUs as number) - exact(4915))).toBeLessThanOrEqual(0.001);
    expect(c3.angleDeg as number).toBeCloseTo(deg(c3.pulseUs as number), 9);
    recordEvidence('s15-r4-servo', { a, b, c: c3 });
  }, 900_000);
});
