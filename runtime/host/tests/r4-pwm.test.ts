/**
 * R4 on the Session Host, with the fake runtime injecting the frames patch 0009 sends (no QEMU):
 * a pad routed to an LEDC signal is solved as a PWM output (architecture A1: duty-weighted average
 * of the two exact operating points, peaks kept), the waveform takes effect at the timer's next
 * cycle, and what cannot be simulated honestly is refused by name once it lasts a whole tick:
 * duty 0 driving a load (O-R4-1) and unrepresentable LEDC modes. The bench circuit: GPIO18 -> 1 kΩ
 * -> GND (a resistive load), GPIO2 -> 220 Ω -> LED -> GND (the fake firmware toggles GPIO2).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SolveSuccess } from '@tbi-lab/engine';
import { principalFor, ticketFor } from '../../identity/test-gate.js';
import type { SessionHost } from '../host.js';
import type { HostSession } from '../session.js';
import { Circuit, reference } from './r1-support.js';
import { createRequest, fakeHost, waitState } from './support.js';

const CAPS = '2 i2c,pad-func,pwm,sched-input';
const hosts: SessionHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.shutdown()));
});

function session(frames: string[], hello = CAPS, circuit?: Circuit) {
  const r = fakeHost('normal', {
    runtimeEnv: {
      PATH: process.env.PATH,
      TBI_FAKE_MODE: 'normal',
      TBI_FAKE_HELLO: hello,
      TBI_FAKE_FRAMES: frames.join(';'),
    },
  });
  hosts.push(r.host);
  const ticket = ticketFor(r.art.sha256, principalFor(), null);
  const req = circuit
    ? { ...circuit.request(r.art.sha256), ticket }
    : createRequest(r.art.sha256, { ticket });
  const c = r.host.create(req, principalFor());
  if (!c.ok) throw new Error(c.error);
  return { s: c.value.session, req };
}
const terminal = async (s: HostSession) => {
  await Promise.race([waitState(s, 'failed', 15_000), waitState(s, 'ended', 15_000)]);
  await s.done();
  return s.status();
};
const runFor = async (s: HostSession, ms: number) => {
  s.run();
  await waitState(s, 'running');
  await new Promise((r) => setTimeout(r, ms));
  s.stop();
  return terminal(s);
};
const electrical = (s: HostSession) =>
  s.log
    .since(0)
    .filter((e) => e.type === 'electrical')
    .map((e) => ({ t: BigInt(e.simNs!), o: (e as unknown as { outcome: SolveSuccess }).outcome }));
const gpioEvents = (s: HostSession, gpio: number) =>
  s.log
    .since(0)
    .flatMap((e) =>
      e.type === 'gpio'
        ? (e as unknown as { changes: { gpio: number; pwm?: unknown }[] }).changes
            .filter((c) => c.gpio === gpio)
            .map((c) => ({ t: BigInt(e.simNs!), ...c }))
        : [],
    );
const r4 = (req: ReturnType<typeof session>['req']) =>
  req.attachments.find((a) => a.gpio === 18)!.component;

// GPIO18 to the high-speed channel 0 signal; timer 0: REF_TICK, div 1000/256, 8 bit = 1 kHz,
// counter restarted at 9 500 200 ns; duty 64/256 latched at the next overflow (10 500 200 ns).
const ROUTE = 'F 9500000 18 periph:71 0';
const TIMER = ['P 9500100 0 reset', 'P 9500200 0 run 1000000 1000 8'];
const duty = (vns: number, d: number) => `W ${vns} 71 on 0 0 ${d}`;

describe('R4: PWM outputs on the Session Host (A1)', () => {
  it('a 25 % waveform: exact average and peak, from its first full cycle on', async () => {
    const { s, req } = session([ROUTE, ...TIMER, duty(9500300, 64)]);
    expect(await runFor(s, 500)).toMatchObject({ state: 'ended', reason: 'stopped' });
    const id = r4(req);
    const high = reference(req, { 18: 'output-high' }).components[id]!.current!;
    const ev = electrical(s);
    // Before the overflow at 10 500 200 ns the channel kept its previous output (idle, low).
    const before = ev.filter((e) => e.t <= 10_000_000n).at(-1)!.o;
    expect(before.components[id]!.current).toBeCloseTo(0, 12);
    const after = ev.filter((e) => e.t > 10_500_200n).at(-1)!.o;
    expect(after.components[id]!.current).toBeCloseTo(0.25 * high, 12);
    expect(after.components[id]!.pwm!.peakCurrent).toBeCloseTo(high, 12);
    const pin = after.pins!.find((p) => p.gpio === 18)!;
    expect(pin.pwm).toMatchObject({ duty: 0.25, periodNs: 1_000_000, highNs: 250_000 });
    expect(pin.pwm!.currentHigh).toBeCloseTo(
      reference(req, { 18: 'output-high' }).pins!.find((p) => p.gpio === 18)!.current,
      12,
    );
    // The gpio event names the waveform.
    expect(gpioEvents(s, 18).at(-1)).toMatchObject({
      drive: 1,
      pwm: {
        kind: 'wave',
        duty: 0.25,
        periodNs: 1_000_000,
        highNs: 250_000,
        dutyTicks: 64,
        res: 8,
      },
    });
  });

  it('a duty change waits for the cycle in progress; 100 % (2^res) is a static high', async () => {
    const { s, req } = session([ROUTE, ...TIMER, duty(9500300, 64), `12@${duty(11700000, 256)}`]);
    expect(await runFor(s, 500)).toMatchObject({ state: 'ended' });
    const id = r4(req);
    const high = reference(req, { 18: 'output-high' }).components[id]!.current!;
    const last = electrical(s).at(-1)!.o;
    expect(last.components[id]!.current).toBeCloseTo(high, 12);
    expect(last.components[id]!.pwm).toBeUndefined(); // a static level, not switching
    expect(gpioEvents(s, 18).at(-1)).toMatchObject({ level: 1, pwm: { kind: 'static', level: 1 } });
  });

  it('duty 0 driving a load is refused after a whole tick: its level is not established (O-R4-1)', async () => {
    const { s } = session([ROUTE, ...TIMER, duty(9500300, 0)]);
    s.run();
    const st = await terminal(s);
    expect(st).toMatchObject({
      state: 'failed',
      reason: 'pwm_unsupported',
      detail: { code: 'pwm_duty_zero_unverified', gpio: 18 },
    });
  });

  it('duty 0 replaced before its cycle starts never takes effect (attach, then write)', async () => {
    const { s } = session([ROUTE, ...TIMER, duty(9500300, 0), duty(9500400, 128)]);
    expect(await runFor(s, 400)).toMatchObject({ state: 'ended', reason: 'stopped' });
  });

  it('modes the runtime cannot represent are refused by name', async () => {
    const { s } = session([ROUTE, 'W 9500300 71 unsupported dither']);
    s.run();
    expect(await terminal(s)).toMatchObject({
      reason: 'pwm_unsupported',
      detail: { code: 'pwm_unsupported_mode', gpio: 18, why: 'dither' },
    });
    const held = session([ROUTE, ...TIMER, duty(9500300, 64), '13@P 12500000 0 paused']).s;
    held.run();
    expect(await terminal(held)).toMatchObject({
      reason: 'pwm_unsupported',
      detail: { code: 'pwm_unsupported_mode', why: 'timer-paused' },
    });
  });

  it('a transient held timer (the driver pulses the reset) is not refused', async () => {
    const { s } = session([
      ROUTE,
      ...TIMER,
      duty(9500300, 64),
      '13@P 12500000 0 reset',
      '13@P 12500056 0 run 1000000 1000 8',
    ]);
    expect(await runFor(s, 400)).toMatchObject({ state: 'ended', reason: 'stopped' });
  });

  it('an LEDC output on a pad outside the circuit changes nothing', async () => {
    const { s } = session(['F 9500000 4 periph:71 0', ...TIMER, duty(9500300, 0)]);
    expect(await runFor(s, 300)).toMatchObject({ state: 'ended', reason: 'stopped' });
  });

  it('P and W frames from a runtime that did not announce pwm fail closed', async () => {
    for (const fr of [TIMER[0]!, duty(9500300, 64)]) {
      const { s } = session([fr], '2 i2c,pad-func,sched-input');
      s.run();
      expect(await terminal(s), fr).toMatchObject({ reason: 'host_protocol_error' });
    }
  });

  it('without the pwm capability an LEDC routing stays a refused peripheral (Runtime v2 rule)', async () => {
    const { s } = session([ROUTE], '2 i2c,pad-func,sched-input');
    s.run();
    expect(await terminal(s)).toMatchObject({
      reason: 'unsupported_feature',
      detail: { gpio: 18, function: 'periph:71' },
    });
  });

  it('an open-drain LEDC output is refused by name (review M10)', async () => {
    const { s } = session(['F 9500000 18 periph:71 1', ...TIMER, duty(9500300, 64)]);
    s.run();
    expect(await terminal(s)).toMatchObject({
      reason: 'pwm_unsupported',
      detail: { code: 'pwm_unsupported_mode', gpio: 18, why: 'open-drain' },
    });
  });

  it('an inverted LEDC output (GPIO matrix, patch 0010) is refused by name (review M8)', async () => {
    // ledc_channel_config(.flags.output_invert = 1) or gpio_matrix_out(18, 71, true, false): the
    // pad carries the inverse of the waveform, which the host does not model.
    const { s } = session(['F 9500000 18 inverted:71 0', ...TIMER, duty(9500300, 64)]);
    s.run();
    expect(await terminal(s)).toMatchObject({
      reason: 'pwm_unsupported',
      detail: { code: 'pwm_unsupported_mode', gpio: 18, why: 'inverted' },
    });
  });

  it('inversion added to a running PWM output is refused too, also at 100 % (static high)', async () => {
    const { s } = session([ROUTE, ...TIMER, duty(9500300, 256), '30@F 30000000 18 inverted:71 0']);
    s.run();
    expect(await terminal(s)).toMatchObject({
      reason: 'pwm_unsupported',
      detail: { code: 'pwm_unsupported_mode', gpio: 18, why: 'inverted' },
    });
  });

  it('during the grace tick an unsupported state publishes no placeholder outcome (review M3)', async () => {
    const { s } = session([ROUTE, ...TIMER, duty(9500300, 64), '30@F 30000000 18 inverted:71 0']);
    s.run();
    expect(await terminal(s)).toMatchObject({ reason: 'pwm_unsupported' });
    const els = s.log.since(0).filter((e) => e.type === 'electrical');
    // The last published outcome is the truthful 25 % one, from before the inversion.
    expect(BigInt(els.at(-1)!.simNs!)).toBeLessThanOrEqual(30_000_000n);
    const led = (e: (typeof els)[number]) =>
      Object.values((e as unknown as { outcome: SolveSuccess }).outcome.components).find(
        (c) => c.current !== null && c.current !== undefined && c.current > 0,
      );
    expect(led(els.at(-1)!)).toBeDefined();
  });

  it('an inverted simple-GPIO pad is a lasting unsupported routing (review M8)', async () => {
    const { s } = session(['F 9500000 18 inverted:256 0']);
    s.run();
    expect(await terminal(s)).toMatchObject({
      reason: 'unsupported_feature',
      detail: { gpio: 18, function: 'inverted:256' },
    });
  });

  it('an inverted simple-GPIO pad publishes no uninverted operating point before its refusal', async () => {
    // QEMU still reports the pad's GPIO level (G frames); the pin carries its inverse.
    const { s } = session(['F 9500000 18 inverted:256 0', 'G 9500010 18 1 1']);
    s.run();
    expect(await terminal(s)).toMatchObject({ reason: 'unsupported_feature' });
    const late = s.log
      .since(0)
      .filter((e) => e.type === 'electrical' && BigInt(e.simNs!) >= 9_500_000n);
    expect(late).toEqual([]);
  });

  it('an inverted LEDC pad on a runtime without pwm is a lasting unsupported routing', async () => {
    const { s } = session(['F 9500000 18 inverted:71 0'], '2 i2c,pad-func,sched-input');
    s.run();
    expect(await terminal(s)).toMatchObject({
      reason: 'unsupported_feature',
      detail: { gpio: 18, function: 'inverted:71' },
    });
  });

  it('inversion set and cleared within one tick is not refused (a transient routing)', async () => {
    const { s } = session([
      ROUTE,
      ...TIMER,
      duty(9500300, 64),
      '31@F 30000000 18 inverted:71 0',
      '31@F 30000200 18 periph:71 0',
    ]);
    expect(await runFor(s, 400)).toMatchObject({ state: 'ended', reason: 'stopped' });
  });

  it('a relay coil on a PWM pad is refused at session level, naming it (A1, review M10)', async () => {
    const c = new Circuit();
    const k = c.add('component.relay');
    c.wire(`${k}.coil2`, 'GND1.ref').wire(`${k}.com`, 'GND1.ref').pad(18, `${k}.coil1`);
    const { s } = session([ROUTE, ...TIMER, duty(9500300, 64)], CAPS, c);
    s.run();
    expect(await terminal(s)).toMatchObject({
      reason: 'pwm_unsupported',
      detail: { code: 'pwm_load_unsupported', components: [k], gpios: [18] },
    });
  });
});

describe('Sprint 17C: M2 and M6 refusals through the whole Session Host', () => {
  it('M2: an APB timer republished at 40 MHz (CPU below 80 MHz) is refused as pwm_unsupported_mode', async () => {
    // 5 kHz on APB: 80 MHz / 62.5 (div 16000) / 256 ticks; then QEMU reports APB at 40 MHz.
    const { s } = session([
      ROUTE,
      'P 9500100 0 reset',
      'P 9500200 0 run 80000000 16000 8',
      duty(9500300, 64),
      '31@P 30000000 0 run 40000000 16000 8',
    ]);
    s.run();
    expect(await terminal(s)).toMatchObject({
      state: 'failed',
      reason: 'pwm_unsupported',
      detail: { code: 'pwm_unsupported_mode', gpio: 18, why: 'timer-apb-clock' },
    });
    // Before the change the 25 % average was published; nothing at 40 MHz ever was.
    const pub = electrical(s);
    expect(pub.some((e) => e.o.pins?.find((p) => p.gpio === 18)?.pwm?.duty === 0.25)).toBe(true);
    expect(pub.every((e) => e.t < 30_000_000n)).toBe(true);
  });

  it('M6: a supply that current-limits only while the pad is low is refused as pwm_supply_limited', async () => {
    const c = new Circuit().psu(5).set('PSU1', 'currentLimit', { value: 0.002, unit: 'ampere' });
    const r = c.add('component.resistor');
    c.ohms(r, 1000).wire('PSU1.positive', `${r}.a`).pad(18, `${r}.b`);
    const { s } = session([ROUTE, ...TIMER, duty(9500300, 128)], CAPS, c);
    s.run();
    expect(await terminal(s)).toMatchObject({
      state: 'failed',
      reason: 'pwm_unsupported',
      detail: { code: 'pwm_supply_limited', gpios: [18], components: ['PSU1'] },
    });
  });
});
