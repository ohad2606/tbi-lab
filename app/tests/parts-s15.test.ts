/**
 * Sprint 15 (R4), the product side: the SG90 servo in every view (palette, 2D symbol whose horn
 * follows the reported angle, schematic block, 3D model with its live horn), its result
 * presentation (angles, pulse width, supply current not modelled), the PWM pad readouts of the MCU
 * panel, and the ratings checking the PEAK current of a PWM-switched part (never the average).
 */
import { describe, expect, it } from 'vitest';
import type { VNode } from 'preact';
import { CATALOG, createSnapshot, setParam } from '@tbi-lab/domain';
import {
  EngineSession,
  ratingWarnings,
  type ComponentResult,
  type SolveSuccess,
} from '@tbi-lab/engine';
import { must, newDoc } from '../../packages/domain/tests/helpers.js';
import { mixedCircuit, place, wire } from '../../packages/domain/tests/circuits.js';
import { SERVO_REST_DEG, SYMBOLS, servoAngle, servoHornRotation } from '../src/ui/symbols.js';
import { PALETTE_GROUPS } from '../src/ui/Palette.js';
import { liveLevelText, pinVoltageText } from '../src/ui/McuPanel.js';
import { SCHEMATIC_SYMBOLS } from '../src/views/schematic/symbols.js';
import { schematicLayout } from '../src/views/schematic/layout.js';
import {
  FOOTPRINT,
  MODEL_FOR,
  MODEL_HEIGHT,
  deriveScene,
  touchingNodes,
} from '../src/views/scene3d/scene.js';
import { SERVO_SG90, SERVO_SHAFT_X_MM } from '../src/views/scene3d/physical.js';
import { servoHornYaw } from '../src/views/scene3d/models.js';
import { ASSETS } from '../src/views/scene3d/assets/manifest.js';
import { formatAngle, formatDuty, formatFrequency, formatPulseWidth } from '../src/sim/format.js';
import { peakOutcome, warningsFor } from '../src/sim/ratings.js';
import { getLocale, isMessageKey } from '../src/i18n/i18n.js';
import { rgbMix } from '../src/views/ledLooks.js';

const SERVO = 'component.servo_sg90' as const;
const en = getLocale('en');
const he = getLocale('he');

/** Every element of a rendered symbol tree (preact VNodes), depth first. */
function elements(node: unknown): VNode<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const v = node as VNode<Record<string, unknown>>;
  return [v, ...elements(v.props.children)];
}

/**
 * A 5 V bench with a servo on it (supply and ground wired, the signal open). Placed so each wire's
 * plain route reaches its terminal without running over another one.
 */
function servoCircuit() {
  let doc = newDoc();
  const r = place(doc, SERVO, 300, -20);
  doc = r.doc;
  const g = place(doc, 'component.ground', 160, -60);
  doc = g.doc;
  doc = wire(doc, ['PSU1', 'negative'], ['GND1', 'ref']);
  doc = wire(doc, ['PSU1', 'positive'], [r.id, 'vcc']);
  doc = wire(doc, [r.id, 'gnd'], [g.id, 'ref']);
  return { doc, id: r.id };
}

describe('the SG90 servo in every view', () => {
  it('is in the palette once, with the outputs', () => {
    const groups = PALETTE_GROUPS.filter((g) => g.types.includes(SERVO));
    expect(groups.map((g) => g.key)).toEqual(['palette.group.output']);
  });

  it('2D symbol: leads start on the terminals; the horn shows the reported angle (rest 90 deg)', () => {
    const sym = SYMBOLS[SERVO];
    const [x0, y0, x1, y1] = sym.bbox;
    for (const t of CATALOG[SERVO].terminals) {
      expect(t.offset.x >= x0 && t.offset.x <= x1 && t.offset.y >= y0 && t.offset.y <= y1).toBe(
        true,
      );
      expect(
        elements(sym.draw()).some(
          (e) => e.type === 'line' && e.props.x1 === t.offset.x && e.props.y1 === t.offset.y,
        ),
        t.id,
      ).toBe(true);
    }
    const horn = (angle?: number) =>
      elements(sym.draw({ servoAngle: angle })).find((e) => e.props.class === 'servo-horn')!.props
        .transform;
    expect(horn()).toBe('rotate(-90 22 0)');
    expect(horn(0)).toBe('rotate(0 22 0)');
    expect(horn(180)).toBe('rotate(-180 22 0)');
    // Clamped to the modelled travel; counter-clockwise (SVG y down) as the angle grows.
    expect(servoHornRotation(200)).toBe(-180);
    expect(servoHornRotation(45)).toBe(-45);
    // The angle comes only from the solved state.
    expect(servoAngle({ angleDeg: 37.5 })).toBe(37.5);
    expect(servoAngle({ powered: true })).toBeUndefined();
    expect(servoAngle(undefined)).toBeUndefined();
    expect(SERVO_REST_DEG).toBe(90);
  });

  it('schematic: a block naming every terminal once, with the servo glyph', () => {
    const sch = SCHEMATIC_SYMBOLS[SERVO];
    expect(sch.kind).toBe('module');
    if (sch.kind === 'module') {
      expect(sch.pins.map((p) => p.terminal).sort()).toEqual(['gnd', 'signal', 'vcc']);
      expect(sch.glyph).toBe('servo');
    }
    const { doc, id } = servoCircuit();
    const block = schematicLayout(doc).modules.find((m) => m.component === id)!;
    expect(block.glyph).toBe('servo');
    expect(block.pins.map((p) => p.name).sort()).toEqual(['GND', 'VCC']);
  });

  it('3D: the plug sockets are the terminals (2D column, 2.54 mm pitch); the horn is live', () => {
    expect(MODEL_FOR[SERVO]).toBe('servo.sg90');
    expect(ASSETS['servo.sg90'].live).toEqual(['servoHorn']);
    const { doc, id } = servoCircuit();
    const scene = deriveScene(doc);
    const c = scene.components.find((x) => x.id === id)!;
    expect(c.model).toBe('servo.sg90');
    for (const t of c.terminals) {
      const [px, pz] = SERVO_SG90.pins[t.id]!;
      expect(t.x).toBeCloseTo(c.x + px, 9);
      expect(t.z).toBeCloseTo(c.z + pz, 9);
      expect(t.y).toBe(SERVO_SG90.attachHeightMm);
    }
    // Sockets on the terminals' 2D column; GND, +V, signal in the lead's order, 2.54 mm apart.
    const offsets = CATALOG[SERVO].terminals;
    for (const t of offsets) expect(SERVO_SG90.pins[t.id]![0]).toBeCloseTo(t.offset.x * 0.15875, 9);
    const z = (k: string) => SERVO_SG90.pins[k]![1];
    expect(z('vcc') - z('gnd')).toBeCloseTo(2.54, 9);
    expect(z('signal') - z('vcc')).toBeCloseTo(2.54, 9);
    // The envelope: the horn's sweep fits the footprint; the height is the drawing's 31 mm at most.
    const [fx0, fx1, fz0, fz1] = FOOTPRINT['servo.sg90'];
    expect(fx0).toBeCloseTo(SERVO_SG90.plugTipXMm, 9);
    expect(fx1).toBeGreaterThanOrEqual(SERVO_SHAFT_X_MM + SERVO_SG90.hornReachMm);
    expect(fz1 - fz0).toBeGreaterThanOrEqual(2 * SERVO_SG90.hornReachMm);
    expect(MODEL_HEIGHT['servo.sg90']).toBeLessThanOrEqual(31);
    expect(touchingNodes(scene)).toEqual([]);
    // The horn: along +x at 0 deg, counter-clockwise from above (+Y) as the angle grows.
    expect(servoHornYaw(0)).toBe(0);
    expect(servoHornYaw(undefined)).toBeCloseTo(Math.PI / 2, 12);
    expect(servoHornYaw(180)).toBeCloseTo(Math.PI, 12);
    expect(servoHornYaw(-10)).toBe(0);
  });

  it('a local solve reports it at rest, powered, its supply current unknown (not 0 A)', () => {
    const { doc, id } = servoCircuit();
    const o = new EngineSession(createSnapshot(doc)).solve();
    if (!o.ok) throw new Error(JSON.stringify(o.error));
    const r = o.components[id]!;
    expect(r.currents).toEqual({ supply: null });
    expect(r.current).toBeNull();
    expect(r.state).toMatchObject({ powered: true, angleDeg: 90, signal: 'none' });
  });

  it('every state the servo reports has words in every locale', () => {
    for (const locale of [en, he]) {
      for (const k of [
        `sim.part.state.${SERVO}.powered`,
        'sim.part.state.angleDeg',
        'sim.part.state.commandedDeg',
        'sim.part.state.pulseUs',
        'sim.part.state.signal',
        ...['none', 'pulses', 'static', 'undefined'].map((v) => `sim.part.state.signal.${v}`),
        'sim.results.notModelled',
      ]) {
        expect(isMessageKey(k), k).toBe(true);
        expect(locale.messages[k as keyof typeof locale.messages], k).toBeTruthy();
      }
    }
  });
});

describe('servo and PWM figures, formatted', () => {
  it('angles, pulse widths, frequencies and duty cycles', () => {
    expect(formatAngle(en, 90)).toBe('90°');
    expect(formatAngle(en, 47.26)).toBe('47.3°');
    expect(formatAngle(en, -0.01)).toBe('0°');
    expect(formatPulseWidth(en, 1500)).toBe('1500 µs');
    expect(formatPulseWidth(en, 544.25)).toBe('544.3 µs');
    expect(formatFrequency(en, 1e9 / 1e6)).toBe('1 kHz');
    expect(formatFrequency(en, 1e9 / 20e6)).toBe('50 Hz');
    expect(formatDuty(en, 0.25)).toBe('25 %');
    expect(formatDuty(en, 0.0752)).toBe('7.5 %');
  });

  it('an MCU pad shows its PWM waveform distinctly (LTR tokens isolated in every locale)', () => {
    const LRI = '⁦';
    const PDI = '⁩';
    const plain = { drive: 1 as const, level: 1 as const, transitions: 3 };
    expect(liveLevelText(en, plain)).toBe('HIGH · output');
    const wave = {
      ...plain,
      level: 0 as const,
      pwm: {
        kind: 'wave' as const,
        periodNs: 1e6,
        highNs: 2.5e5,
        duty: 0.25,
        dutyTicks: 256,
        res: 10,
      },
    };
    expect(liveLevelText(en, wave)).toBe(`PWM ${LRI}1 kHz${PDI} · ${LRI}25 %${PDI}`);
    expect(liveLevelText(he, wave)).toBe(`PWM ${LRI}1 kHz${PDI} · ${LRI}25 %${PDI}`);
    expect(liveLevelText(en, { ...plain, pwm: { kind: 'zero', periodNs: 1e6 } })).toMatch(
      /^PWM · duty 0 .*not verified/,
    );
    expect(liveLevelText(en, { ...plain, pwm: { kind: 'static', level: 1 } })).toBe(
      'PWM · HIGH (steady)',
    );
    expect(liveLevelText(en, { ...plain, pwm: { kind: 'unsupported', why: 'fade' } })).toBe(
      'PWM · unsupported',
    );
    // A switching pad's solved voltage is its average over the waveform, and says so.
    expect(pinVoltageText(en, wave, 0.825)).toBe(`average ${LRI}825 mV${PDI}`);
    expect(pinVoltageText(en, plain, 3.3)).toBe(`${LRI}3.3 V${PDI}`);
    // Sprint 17C: duty 0 (O-R4-1) and unsupported modes show no voltage as fact.
    expect(pinVoltageText(en, { ...plain, pwm: { kind: 'zero', periodNs: 1e6 } }, 0)).toBe(
      'voltage not established',
    );
    expect(pinVoltageText(he, { ...plain, pwm: { kind: 'unsupported', why: 'fade' } }, 0)).toBe(
      'המתח לא ידוע',
    );
  });
});

/** PSU 5 V -> R -> LED -> GND, solved: an LED current well over its 30 mA rating at 47 ohm. */
function ledLoop(ohms: number) {
  let doc = newDoc();
  const r = place(doc, 'component.resistor', 200, 0);
  doc = r.doc;
  const d = place(doc, 'component.led', 400, 0);
  doc = d.doc;
  doc = wire(doc, ['PSU1', 'negative'], ['GND1', 'ref']);
  doc = wire(doc, ['PSU1', 'positive'], [r.id, 'a']);
  doc = wire(doc, [r.id, 'b'], [d.id, 'anode']);
  doc = wire(doc, [d.id, 'cathode'], ['GND1', 'ref']);
  doc = must(setParam(doc, 'PSU1', 'setpointVoltage', { value: 5, unit: 'volt' })).doc;
  doc = must(setParam(doc, 'PSU1', 'currentLimit', { value: 1, unit: 'ampere' })).doc;
  doc = must(setParam(doc, r.id, 'resistance', { value: ohms, unit: 'ohm' })).doc;
  const o = new EngineSession(createSnapshot(doc)).solve();
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  return { doc, led: d.id, outcome: o };
}

/**
 * The time-average a 25 % PWM output would publish for that LED (the runtime's form: the low point
 * at rest, so every current and voltage is a quarter of the high point's), with the peak beside it.
 */
function averaged(o: SolveSuccess, id: string, duty = 0.25): SolveSuccess {
  const r = o.components[id]!;
  const avg: ComponentResult = {
    ...r,
    current: r.current! * duty,
    voltage: r.voltage! * duty,
    pwm: { peakCurrent: r.current },
  };
  return { ...o, components: { ...o.components, [id]: avg } };
}

describe('ratings under PWM check the peak, not the average', () => {
  it('an LED at 25 % duty with a peak over its rating is flagged, at the peak value', () => {
    const { doc, led, outcome } = ledLoop(47);
    const peak = outcome.components[led]!.current!;
    expect(peak).toBeGreaterThan(0.03);
    const avg = averaged(outcome, led);
    // The average alone is under the rating: the engine's check would miss it.
    expect(avg.components[led]!.current!).toBeLessThan(0.03);
    const { pwm: _peak, ...averageOnly } = avg.components[led]!;
    const engineOnly = ratingWarnings(createSnapshot(doc), {
      ...avg,
      components: { ...avg.components, [led]: averageOnly },
    });
    expect(engineOnly.map((w) => w.code)).not.toContain('forward_current');
    const w = warningsFor(doc, avg).filter((x) => x.component === led);
    expect(w).toContainEqual(
      expect.objectContaining({ code: 'forward_current', value: peak, limit: 0.03 }),
    );
    // What is SHOWN stays the engine's average.
    expect(avg.components[led]!.current).toBeCloseTo(peak * 0.25, 15);
  });

  it('Sprint 17C (review V2): a reverse voltage over the rating only at one PWM extreme is flagged there', () => {
    // An LED whose reverse voltage swings 5.0 V / 8.3 V with the PWM (10 % duty): the 5.33 V
    // average is under the 6 V rating; the 8.3 V extreme is not.
    const { doc, led, outcome } = ledLoop(220);
    const r = outcome.components[led]!;
    const avg: SolveSuccess = {
      ...outcome,
      components: {
        ...outcome.components,
        [led]: {
          ...r,
          current: 0,
          voltage: -5.33,
          pwm: { peakCurrent: 0, voltageRange: [-8.3, -5], terminalRanges: {} },
        },
      },
    };
    const { pwm: _range, ...averageOnly } = avg.components[led]!;
    expect(
      ratingWarnings(createSnapshot(doc), {
        ...avg,
        components: { ...avg.components, [led]: averageOnly },
      }).filter((w) => w.code === 'reverse_voltage'),
    ).toEqual([]);
    expect(warningsFor(doc, avg).filter((w) => w.code === 'reverse_voltage')).toEqual([
      expect.objectContaining({ component: led, value: 8.3, limit: 6 }),
    ]);
  });

  it('within its rating at the peak, no warning', () => {
    const { doc, led, outcome } = ledLoop(220);
    expect(warningsFor(doc, averaged(outcome, led))).toEqual([]);
  });

  it('named currents and dot arrays are replaced by their peaks; pads by their worse point', () => {
    const base: SolveSuccess = {
      ok: true,
      components: {
        D1: {
          id: 'D1',
          type: 'component.rgb_led',
          current: null,
          voltage: null,
          terminals: {},
          currents: { red: 0.005, green: 0.001, blue: 0 },
          pwm: { peakCurrent: null, peakCurrents: { red: 0.02, green: 0.004 } },
        },
        M1: {
          id: 'M1',
          type: 'display.led_matrix_8x8',
          current: null,
          voltage: null,
          terminals: {},
          array: { rows: 1, cols: 2, currents: [0.002, 0] },
          pwm: { peakCurrent: null, peakArray: [0.008, 0] },
        },
        R1: { id: 'R1', type: 'component.resistor', current: 0.001, voltage: 1, terminals: {} },
      },
      netVoltages: {},
      pins: [
        {
          gpio: 4,
          mode: 'output-low',
          voltage: 0.8,
          current: 0.011,
          pwm: { duty: 0.25, periodNs: 1e6, highNs: 2.5e5, currentHigh: 0.045, currentLow: 0 },
          peakCurrent: 0.045,
        },
        { gpio: 5, mode: 'output-low', voltage: 0.1, current: -0.002, peakCurrent: 0.009 },
        { gpio: 18, mode: 'output-high', voltage: 3.3, current: 0.001 },
      ],
    } as unknown as SolveSuccess;
    const p = peakOutcome(base);
    expect(p.components.D1!.currents).toEqual({ red: 0.02, green: 0.004, blue: 0 });
    expect(p.components.M1!.array!.currents).toEqual([0.008, 0]);
    expect(p.components.R1).toBe(base.components.R1);
    expect(p.pins![0]).toMatchObject({ gpio: 4, mode: 'output-high', current: 0.045 });
    expect(p.pins![1]).toMatchObject({ gpio: 5, mode: 'output-low', current: -0.009 });
    expect(p.pins![2]).toBe(base.pins![2]);
    // Without PWM the outcome is checked as it is.
    const plain = { ...base, components: { R1: base.components.R1! }, pins: [base.pins![2]!] };
    expect(peakOutcome(plain)).toBe(plain);
  });

  it('a PWM pad sourcing over its drive rating while high is flagged (average under it)', () => {
    const { doc } = mixedCircuit();
    const outcome = {
      ok: true,
      components: {},
      netVoltages: {},
      pins: [
        {
          gpio: 4,
          mode: 'output-low',
          voltage: 0.66,
          current: 0.0125,
          pwm: { duty: 0.25, periodNs: 1e6, highNs: 2.5e5, currentHigh: 0.05, currentLow: 0 },
          peakCurrent: 0.05,
        },
      ],
    } as unknown as SolveSuccess;
    expect(warningsFor(doc, outcome)).toContainEqual(
      expect.objectContaining({ code: 'gpio_source_current', gpio: 4, value: 0.05 }),
    );
  });
});

describe('LED brightness under PWM follows the average current', () => {
  it('a 25 % duty RGB channel glows a quarter as bright as the same channel at its peak', () => {
    const peak = rgbMix({ red: 0.02 })!;
    const avg = rgbMix({ red: 0.02 * 0.25 })!;
    expect(peak.intensity).toBe(1);
    expect(avg.intensity).toBeCloseTo(0.25, 12);
    expect(avg.color).toBe(peak.color);
  });
});
