/**
 * Runtime R2: MCU pads attached to a project circuit inside the production EngineSession.
 *
 * The Session Host must use the SAME electrical implementation as the browser. These tests prove
 * that EngineSession with attached pads reproduces, to 1e-12 relative, a reference circuit built
 * directly from the same production devices (the way the R1 runtime harness built it), for
 * a GPIO driving an LED high and low, an externally driven input, and a divider inside the
 * hysteresis band. Without attachments the outcome is the browser outcome, unchanged.
 */
import { describe, expect, it } from 'vitest';
import {
  Circuit,
  Diode,
  EngineSession,
  GpioPin,
  LED_TLHR5400,
  LabPsu,
  Resistor,
  V_IH_V,
  V_IL_V,
  interpretDigitalInput,
  type SolveOutcome,
  type SolveSuccess,
} from '../src/index.js';
import { Bench } from './build.js';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${o.error.code}`);
  return o;
};
const close = (a: number, b: number) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(b)));

/** GPIO2 -> R1 (220 ohm) -> LED -> GND, as a project (PSU1 unused and wired off to GND). */
function ledBench() {
  const b = new Bench();
  const r = b.add('component.resistor');
  const d = b.add('component.led');
  b.wire(`${r}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref').ohms(r, 220);
  b.wire('PSU1.negative', 'GND1.ref').psu(5, 0.1, false);
  return { b, r, d };
}

describe('MCU pads in the production EngineSession', () => {
  for (const mode of ['output-high', 'output-low'] as const) {
    it(`GPIO ${mode} driving R + LED matches the reference circuit`, () => {
      const { b } = ledBench();
      const s = new EngineSession(b.snapshot(), {
        pins: [{ gpio: 2, component: 'R1', terminal: 'a' }],
      });
      expect(s.setPinMode(2, mode)).toBeNull();
      const out = ok(s.solve());

      const ref = new Circuit();
      ref.add(new GpioPin('IO2', 'io2', mode));
      ref.add(new Resistor('R1', 'io2', 'a', 220));
      ref.add(new Diode('D1', 'a', '0', LED_TLHR5400));
      const r = ref.solve();

      const pin = out.pins![0]!;
      expect(pin).toMatchObject({ gpio: 2, mode });
      close(pin.voltage, r.nodeVoltages.get('io2')!);
      close(pin.current, r.deviceCurrents.get('IO2')!);
      close(out.components.D1!.current!, r.deviceCurrents.get('D1')!);
      if (mode === 'output-high') expect(out.components.D1!.current!).toBeGreaterThan(5e-3);
      else expect(out.components.D1!.current!).toBeLessThan(1e-9);
    });
  }

  it('an externally driven input: PSU CV through 10 k into an input pad reads HIGH', () => {
    const b = new Bench();
    const r = b.add('component.resistor');
    b.wire('PSU1.positive', `${r}.a`)
      .wire('PSU1.negative', 'GND1.ref')
      .psu(3.3, 0.1)
      .ohms(r, 10_000);
    const s = new EngineSession(b.snapshot(), {
      pins: [{ gpio: 35, component: 'R1', terminal: 'b' }],
    });
    const out = ok(s.solve());

    const ref = new Circuit();
    ref.add(new LabPsu('PSU1', 'p', '0', 3.3, 0.1));
    ref.add(new Resistor('R1', 'p', 'b', 10_000));
    ref.add(new GpioPin('IO35', 'b', 'input'));
    const rr = ref.solve();
    close(out.pins![0]!.voltage, rr.nodeVoltages.get('b')!);
    expect(out.components.PSU1!.mode).toBe('cv');
    expect(interpretDigitalInput(out.pins![0]!.voltage, 0)).toBe(1);
  });

  it('a PSU in CC (current limit) with a pad sinking LOW matches the reference', () => {
    const b = new Bench();
    const r = b.add('component.resistor');
    b.wire('PSU1.positive', `${r}.a`).wire('PSU1.negative', 'GND1.ref').psu(5, 0.01).ohms(r, 10);
    const s = new EngineSession(b.snapshot(), {
      pins: [{ gpio: 4, component: 'R1', terminal: 'b' }],
    });
    s.setPinMode(4, 'output-low');
    const out = ok(s.solve());
    const ref = new Circuit();
    ref.add(new LabPsu('PSU1', 'p', '0', 5, 0.01));
    ref.add(new Resistor('R1', 'p', 'b', 10));
    ref.add(new GpioPin('IO4', 'b', 'output-low'));
    const rr = ref.solve();
    expect(out.components.PSU1!.mode).toBe('cc');
    expect(rr.supplyModes.get('PSU1')).toBe('CC');
    close(out.pins![0]!.current, rr.deviceCurrents.get('IO4')!);
  });

  it('inside the hysteresis band the input holds its previous level', () => {
    // 3.3 V -> 10 k -> pad <- 10 k <- GND: the pad sits near 1.65 V, between V_IL and V_IH.
    const b = new Bench();
    const r1 = b.add('component.resistor');
    const r2 = b.add('component.resistor');
    b.wire('PSU1.positive', `${r1}.a`).wire(`${r1}.b`, `${r2}.a`).wire(`${r2}.b`, 'GND1.ref');
    b.wire('PSU1.negative', 'GND1.ref').psu(3.3, 0.1).ohms(r1, 10_000).ohms(r2, 10_000);
    const out = ok(
      new EngineSession(b.snapshot(), {
        pins: [{ gpio: 5, component: 'R1', terminal: 'b' }],
      }).solve(),
    );
    const v = out.pins![0]!.voltage;
    expect(v).toBeGreaterThan(V_IL_V);
    expect(v).toBeLessThan(V_IH_V);
    expect(interpretDigitalInput(v, 0)).toBe(0);
    expect(interpretDigitalInput(v, 1)).toBe(1);
  });

  it('the R1 gate circuit (two pads, LED, lab PSU) matches the R1 harness construction', () => {
    // GPIO2 -> 220 -> LED -> GND; GPIO2 -> 10 k -> GPIO5 <- 10 k <- VEXT(PSU1).
    const b = new Bench();
    const r1 = b.add('component.resistor');
    const d = b.add('component.led');
    const r2 = b.add('component.resistor');
    const r3 = b.add('component.resistor');
    b.wire(`${r1}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref');
    b.wire(`${r1}.a`, `${r2}.a`).wire(`${r2}.b`, `${r3}.b`);
    b.wire('PSU1.positive', `${r3}.a`).wire('PSU1.negative', 'GND1.ref');
    b.ohms(r1, 220).ohms(r2, 10_000).ohms(r3, 10_000);
    for (const [vext, mode] of [
      [0, 'output-high'],
      [3.3, 'output-high'],
      [3.3, 'output-low'],
      [0, 'output-low'],
    ] as const) {
      b.psu(vext, 0.1, true);
      const s = new EngineSession(b.snapshot(), {
        pins: [
          { gpio: 2, component: 'R1', terminal: 'a' },
          { gpio: 5, component: 'R2', terminal: 'b' },
        ],
      });
      s.setPinMode(2, mode);
      const o = s.solve();
      const ref = new Circuit();
      ref.add(new GpioPin('IO2', 'io2', mode));
      ref.add(new Resistor('R1', 'io2', 'led_a', 220));
      ref.add(new Diode('D1', 'led_a', '0', LED_TLHR5400));
      ref.add(new Resistor('R2', 'io2', 'io5', 10_000));
      ref.add(new GpioPin('IO5', 'io5', 'input'));
      ref.add(new LabPsu('VEXT', 'ext', '0', vext, 0.1));
      ref.add(new Resistor('R3', 'ext', 'io5', 10_000));
      const r = ref.solve();
      // Sprint 22 review 3: where the pad would push current back into the external supply (it
      // would have to SINK), the product refuses by name: the bench-supply model cannot sink.
      if (r.deviceCurrents.get('VEXT')! < -1e-9) {
        expect(o.ok ? null : o.error.code, `${vext} ${mode}`).toBe('psu_sinking');
        continue;
      }
      const out = ok(o);
      close(out.pins![0]!.voltage, r.nodeVoltages.get('io2')!);
      close(out.pins![1]!.voltage, r.nodeVoltages.get('io5')!);
      close(out.components.D1!.current!, r.deviceCurrents.get('D1')!);
    }
  });

  it('without attachments the outcome is exactly the browser outcome (no pins field)', () => {
    const { b } = ledBench();
    const plain = new EngineSession(b.snapshot()).solve();
    const empty = new EngineSession(b.snapshot(), { pins: [] }).solve();
    expect(JSON.stringify(empty)).toBe(JSON.stringify(plain));
    expect('pins' in plain).toBe(false);
  });

  it('refuses structurally invalid attachments; pad modes are transient and per session', () => {
    const { b } = ledBench();
    for (const pins of [
      [{ gpio: 2, component: 'R9', terminal: 'a' }],
      [{ gpio: 2, component: 'R1', terminal: 'anode' }],
      [{ gpio: 40, component: 'R1', terminal: 'a' }],
      [
        { gpio: 2, component: 'R1', terminal: 'a' },
        { gpio: 2, component: 'D1', terminal: 'anode' },
      ],
    ]) {
      const out = new EngineSession(b.snapshot(), { pins }).solve();
      expect(!out.ok && out.error.code, JSON.stringify(pins)).toBe('invalid_attachment');
    }
    const a = new EngineSession(b.snapshot(), {
      pins: [{ gpio: 2, component: 'R1', terminal: 'a' }],
    });
    const c = new EngineSession(b.snapshot(), {
      pins: [{ gpio: 2, component: 'R1', terminal: 'a' }],
    });
    a.setPinMode(2, 'output-high');
    expect(ok(c.solve()).pins![0]!.mode).toBe('input');
    expect(a.setPinMode(3, 'output-high')?.code).toBe('invalid_attachment');
  });
});
