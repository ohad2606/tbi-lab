/**
 * T-R4-4 (host): an SG90 on an LEDC output, through the whole Session Host with the fake runtime
 * injecting the frames patch 0009 sends for `ledcAttach(18, 50, 16)` (R4ProbeServo's timer:
 * APB, div 6250/256, 16 bit = 50 Hz exactly). The servo's angle follows the exact pulse widths:
 * 3277 -> 1000.061 us -> 0.011 deg; 6554 -> 2000.122 us -> 180 deg (clamped travel); it slews at
 * 600 deg/s and holds without pulses; unpowered (below 4.8 V) it does not move.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SolveSuccess } from '@tbi-lab/engine';
import { principalFor } from '../../identity/test-gate.js';
import type { SessionHost } from '../host.js';
import type { HostSession } from '../session.js';
import { Circuit } from './r1-support.js';
import { fakeHost, waitState } from './support.js';

const CAPS = '2 i2c,pad-func,pwm,sched-input';
const hosts: SessionHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.shutdown()));
});

function servoSession(
  frames: string[],
  supplyV = 5,
  hello = CAPS,
  extra?: (c: Circuit, servo: string) => void,
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
  const c = new Circuit();
  const m = c.add('component.servo_sg90');
  c.psu(supplyV).wire('PSU1.positive', `${m}.vcc`).wire(`${m}.gnd`, 'GND1.ref');
  c.pad(18, `${m}.signal`);
  extra?.(c, m);
  const created = r.host.create(c.request(r.art.sha256), principalFor());
  if (!created.ok) throw new Error(created.error);
  return { s: created.value.session, id: m };
}
const terminal = async (s: HostSession) => {
  await Promise.race([waitState(s, 'failed', 20_000), waitState(s, 'ended', 20_000)]);
  await s.done();
  return s.status();
};
/** Run until the simulation has reached `simMs`, then stop. */
async function runUntil(s: HostSession, simMs: number) {
  s.run();
  await waitState(s, 'running');
  const deadline = Date.now() + 20_000;
  while (BigInt(s.status().simNs) < BigInt(simMs) * 1_000_000n && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 20));
  s.stop();
  return terminal(s);
}
const servoStates = (s: HostSession, id: string) =>
  s.log
    .since(0)
    .filter((e) => e.type === 'electrical')
    .map((e) => ({
      t: Number(BigInt(e.simNs!)) / 1e6,
      st: (e as unknown as { outcome: SolveSuccess }).outcome.components[id]!.state!,
    }));
const at = (states: ReturnType<typeof servoStates>, ms: number) =>
  states.filter((x) => x.t <= ms).at(-1)!.st;

// 50 Hz, counter from 9.5002 ms; 1.0 ms pulses from the overflow at 29.5002 ms.
const ATTACH = [
  'F 9500000 18 periph:71 0',
  'P 9500100 0 reset',
  'P 9500200 0 run 80000000 6250 16',
  'W 9500300 71 on 0 0 3277',
];

describe('T-R4-4: SG90 on an LEDC output (Session Host)', () => {
  it('1.0 ms pulses: slews from 90 deg to ~0 at 600 deg/s, then 2.0 ms: to 180 (exact widths)', async () => {
    const { s, id } = servoSession([...ATTACH, '400@W 399500000 71 on 0 0 6554']);
    const st = await runUntil(s, 800);
    expect(st, JSON.stringify(st.detail)).toMatchObject({ state: 'ended', reason: 'stopped' });
    const states = servoStates(s, id);
    // Before the first full cycle: at rest, 90 deg.
    expect(at(states, 20)).toMatchObject({ angleDeg: 90, powered: true });
    // First accepted pulse ends at 29.5002 + 1.000061 ms; then 600 deg/s toward 0.011 deg:
    // 90 deg takes 150 ms, so by 200 ms the servo is there.
    const first = at(states, 250);
    expect(first.signal).toBe('pulses');
    // Exact width 1 000 061.035 ns; edges are handed to the servo on whole nanoseconds (<= 1 ns).
    expect(Math.abs((first.pulseUs as number) - 1000.06103515625)).toBeLessThanOrEqual(0.001);
    expect(first.commandedDeg as number).toBeCloseTo(((1000.061035 - 1000) / 1000) * 180, 3);
    expect(first.angleDeg as number).toBeCloseTo(first.commandedDeg as number, 6);
    // Halfway through the slew it is between (deterministic, 600 deg/s).
    const mid = at(states, 100);
    expect(mid.angleDeg as number).toBeGreaterThan(0.1);
    expect(mid.angleDeg as number).toBeLessThan(90);
    // 2.000122 ms commands past the 2.0 ms end: clamped to 180 deg; it gets there by 399+~20+300 ms.
    const last = at(states, 800);
    expect(Math.abs((last.pulseUs as number) - 2000.1220703125)).toBeLessThanOrEqual(0.001);
    expect(last.commandedDeg).toBe(180);
    expect(last.angleDeg).toBe(180);
  });

  it('is deterministic: the same frames give the same published states', async () => {
    const a = servoSession(ATTACH);
    await runUntil(a.s, 300);
    const b = servoSession(ATTACH);
    await runUntil(b.s, 300);
    const cut = (x: ReturnType<typeof servoStates>) => x.filter((e) => e.t <= 290);
    expect(cut(servoStates(b.s, b.id))).toEqual(cut(servoStates(a.s, a.id)));
  });

  it('below 4.8 V the servo is not simulated as moving (it holds, flagged)', async () => {
    const { s, id } = servoSession(ATTACH, 3.3);
    await runUntil(s, 300);
    const last = servoStates(s, id).at(-1)!;
    expect(last.st).toMatchObject({ powered: false, angleDeg: 90 });
  });

  it('a servo on a runtime without pwm is refused, named, before the firmware runs', async () => {
    const { s, id } = servoSession([], 5, '2 i2c,pad-func,sched-input');
    s.run();
    expect(await terminal(s)).toMatchObject({
      state: 'failed',
      reason: 'electrical_error',
      detail: { code: 'unsupported_component', components: [id] },
    });
  });

  it('review B1: other solves (an LED blinking on GPIO2 every 5 ms) do not replay the pulses', async () => {
    // The fake firmware toggles GPIO2 every 5 ms: every toggle solves the circuit while the
    // servo's LEDC waveform is unchanged. Before the fix the servo was re-anchored on every solve,
    // fed pulses from the past and the session hung.
    const { s, id } = servoSession(ATTACH, 5, CAPS, (c) => {
      const r = c.add('component.resistor');
      c.ohms(r, 1000).wire(`${r}.b`, 'GND1.ref').pad(2, `${r}.a`);
    });
    const st = await runUntil(s, 400);
    expect(st, JSON.stringify(st.detail)).toMatchObject({ state: 'ended', reason: 'stopped' });
    const last = servoStates(s, id).at(-1)!.st;
    expect(Math.abs((last.pulseUs as number) - 1000.06103515625)).toBeLessThanOrEqual(0.001);
    expect(last.angleDeg as number).toBeCloseTo(last.commandedDeg as number, 9);
  });

  it('duty 0 on a pad that only feeds a servo signal runs (no load can tell its level)', async () => {
    const { s, id } = servoSession([
      'F 9500000 18 periph:71 0',
      'P 9500100 0 reset',
      'P 9500200 0 run 80000000 6250 16',
      'W 9500300 71 on 0 0 0',
    ]);
    expect(await runUntil(s, 200)).toMatchObject({ state: 'ended', reason: 'stopped' });
    expect(servoStates(s, id).at(-1)!.st).toMatchObject({ angleDeg: 90, commandedDeg: 90 });
  });

  it('a signal between the thresholds is undefined: no pulse is read, a warning names it', async () => {
    // Signal through 10 k / 10 k from the pad: 1.65 V when high, between 0.8 V and 2.0 V.
    const { s: s2, id: id2 } = servoSession(ATTACH, 5, CAPS, (c, m) => {
      c.attachments = c.attachments.filter((a) => a.gpio !== 18);
      const r1 = c.add('component.resistor');
      const r2 = c.add('component.resistor');
      c.ohms(r1, 10_000).ohms(r2, 10_000);
      c.wire(`${r1}.b`, `${m}.signal`).wire(`${r2}.a`, `${m}.signal`).wire(`${r2}.b`, 'GND1.ref');
      c.pad(18, `${r1}.a`);
    });
    expect(await runUntil(s2, 300)).toMatchObject({ state: 'ended', reason: 'stopped' });
    expect(servoStates(s2, id2).at(-1)!.st).toMatchObject({ signal: 'undefined', angleDeg: 90 });
    const warn = s2.log
      .since(0)
      .find(
        (e) =>
          e.type === 'diagnostic' && (e as { code?: string }).code === 'servo_signal_undefined',
      );
    expect(warn).toMatchObject({ detail: { component: id2, gpios: [18] } });
  });
});
