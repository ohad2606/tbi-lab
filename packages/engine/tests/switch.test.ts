/**
 * Sprint 4 A7: open/closed switch behaviour is exact and numerically stable.
 *
 * Model: an OPEN contact contributes no element at all (an open circuit, no leakage). A
 * CLOSED contact is an ideal conductor, a 0 V branch whose current is an MNA unknown. No
 * Ron/Roff constants exist, so none can be "tuned"; tolerances are the Gate A ones.
 */
import { describe, expect, it } from 'vitest';
import { EngineSession, type SolveOutcome, type SolveSuccess } from '../src/index.js';
import { Bench } from './build.js';

const REL = 1e-9;
const DECADES = [1e-3, 1e-2, 1e-1, 1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9];
const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  return o;
};
const relErr = (a: number | null, e: number) =>
  a === null ? Infinity : Math.abs(a - e) / Math.abs(e);
const bits = (x: number | null) =>
  [...new Uint8Array(new Float64Array([x ?? NaN]).buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/** PSU1 -> SW1 -> R1 -> GND; `kind` picks the switch type; `closed` sets the toggle. */
function switchLoop(
  kind: 'component.toggle_switch' | 'component.push_button',
  ohms: number,
  closed = false,
) {
  const b = new Bench();
  const sw = b.add(kind);
  const r = b.add('component.resistor');
  b.wire('PSU1.positive', `${sw}.a`)
    .wire(`${sw}.b`, `${r}.a`)
    .wire(`${r}.b`, 'GND1.ref')
    .wire('PSU1.negative', 'GND1.ref');
  b.psu(5, 5).ohms(r, ohms);
  if (kind === 'component.toggle_switch') b.set(sw, 'closed', closed);
  return b;
}

describe('toggle switch: open is an open circuit, closed is an ideal conductor', () => {
  it('open: exactly zero current everywhere in the switched path', () => {
    const r = ok(
      new EngineSession(switchLoop('component.toggle_switch', 1000, false).snapshot()).solve(),
    );
    expect(r.components.SW1).toMatchObject({ closed: false, current: 0 });
    expect(r.components.R1!.current).toBe(0);
    expect(r.components.PSU1!.current).toBe(0);
    expect(r.components.SW1!.voltage).toBe(5); // the whole supply across the open contact
  });

  it('closed: exact Ohm current through switch and resistor, 0 V across the contact', () => {
    const r = ok(
      new EngineSession(switchLoop('component.toggle_switch', 1000, true).snapshot()).solve(),
    );
    expect(r.components.SW1!.closed).toBe(true);
    expect(relErr(r.components.SW1!.current, 5e-3)).toBeLessThanOrEqual(REL);
    expect(relErr(r.components.R1!.current, 5e-3)).toBeLessThanOrEqual(REL);
    expect(r.components.SW1!.voltage).toBe(0);
    expect(r.stats.maxBranchResidualV).toBeLessThanOrEqual(1e-12);
  });

  it('closed or open, every resistor decade 1 mΩ .. 1 GΩ is exact', () => {
    for (const R of DECADES) {
      const on = ok(
        new EngineSession(switchLoop('component.toggle_switch', R, true).snapshot()).solve(),
      );
      expect(
        relErr(on.components.SW1!.current, Math.min(5 / R, 5)),
        `closed ${R}`,
      ).toBeLessThanOrEqual(REL);
      const off = ok(
        new EngineSession(switchLoop('component.toggle_switch', R, false).snapshot()).solve(),
      );
      expect(off.components.R1!.current, `open ${R}`).toBe(0);
    }
  });

  it('current-limited supply through a closed switch enters CC', () => {
    const b = switchLoop('component.toggle_switch', 10, true);
    b.psu(5, 0.1);
    const r = ok(new EngineSession(b.snapshot()).solve());
    expect(r.components.PSU1!.mode).toBe('cc');
    expect(relErr(r.components.SW1!.current, 0.1)).toBeLessThanOrEqual(REL);
    expect(relErr(r.components.R1!.voltage, 1)).toBeLessThanOrEqual(REL);
  });

  it('switch directly in series with an LED', () => {
    const b = new Bench();
    const r = b.add('component.resistor');
    const sw = b.add('component.toggle_switch');
    const d = b.add('component.led');
    b.wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, `${sw}.a`).wire(`${sw}.b`, `${d}.anode`);
    b.wire(`${d}.cathode`, 'GND1.ref').wire('PSU1.negative', 'GND1.ref').psu(5, 0.1).ohms(r, 220);
    const open = ok(new EngineSession(b.snapshot()).solve());
    expect(open.components[d]!.current).toBe(0);
    b.set(sw, 'closed', true);
    const closed = ok(new EngineSession(b.snapshot()).solve());
    // The same LED operating point as Sprint 3 without a switch: an ideal contact adds nothing.
    expect(closed.components[d]!.current!).toBeCloseTo(0.013724, 5);
    expect(
      relErr(closed.components[sw]!.current, closed.components[d]!.current!),
    ).toBeLessThanOrEqual(REL);
  });
});

describe('multiple switches', () => {
  it('series switches: the path conducts only when all are closed', () => {
    const b = new Bench();
    const [s1, s2] = [b.add('component.toggle_switch'), b.add('component.toggle_switch')];
    const r = b.add('component.resistor');
    b.wire('PSU1.positive', `${s1}.a`).wire(`${s1}.b`, `${s2}.a`).wire(`${s2}.b`, `${r}.a`);
    b.wire(`${r}.b`, 'GND1.ref').wire('PSU1.negative', 'GND1.ref').psu(5, 5).ohms(r, 100);
    for (const [c1, c2] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      b.set(s1, 'closed', c1).set(s2, 'closed', c2);
      const res = ok(new EngineSession(b.snapshot()).solve());
      expect(res.components[r]!.current, `${c1}/${c2}`).toBe(c1 && c2 ? 0.05 : 0);
    }
  });

  it('parallel closed switches: circuit exact; the redundant contact current is "not defined"', () => {
    const b = new Bench();
    const [s1, s2] = [b.add('component.toggle_switch'), b.add('component.toggle_switch')];
    const r = b.add('component.resistor');
    b.wire('PSU1.positive', `${s1}.a`).wire('PSU1.positive', `${s2}.a`);
    b.wire(`${s1}.b`, `${r}.a`)
      .wire(`${s2}.b`, `${r}.a`)
      .wire(`${r}.b`, 'GND1.ref')
      .wire('PSU1.negative', 'GND1.ref');
    b.psu(5, 5).ohms(r, 1000).set(s1, 'closed', true).set(s2, 'closed', true);
    const res = ok(new EngineSession(b.snapshot()).solve());
    expect(relErr(res.components[r]!.current, 5e-3)).toBeLessThanOrEqual(REL);
    const currents = [res.components[s1]!.current, res.components[s2]!.current];
    expect(currents.filter((c) => c === null)).toHaveLength(1); // no invented split
    expect(
      relErr(
        currents.find((c) => c !== null)!,
        5e-3,
      ),
    ).toBeLessThanOrEqual(REL);
  });

  it('a closed switch across the supply is refused as a short, naming the switch', () => {
    const b = new Bench();
    const sw = b.add('component.toggle_switch');
    b.wire('PSU1.positive', `${sw}.a`)
      .wire(`${sw}.b`, 'PSU1.negative')
      .wire('PSU1.negative', 'GND1.ref');
    b.psu(5, 0.1).set(sw, 'closed', true);
    const o = new EngineSession(b.snapshot()).solve();
    expect(!o.ok && o.error).toMatchObject({ code: 'psu_shorted', components: ['PSU1', sw] });
    b.set(sw, 'closed', false);
    expect(new EngineSession(b.snapshot()).solve().ok).toBe(true);
  });

  it('an open switch that isolates an ungrounded part yields the floating diagnostic, honestly', () => {
    const b = new Bench();
    const sw = b.add('component.toggle_switch');
    const [r1, r2] = [b.add('component.resistor'), b.add('component.resistor')];
    // PSU+ -> R1 -> SW1 -> R2, and R2's far end back to SW1.a's net only via the switch.
    b.wire('PSU1.positive', `${r1}.a`)
      .wire(`${r1}.b`, `${sw}.a`)
      .wire(`${sw}.b`, `${r2}.a`)
      .wire(`${r2}.b`, `${sw}.b`);
    b.wire('PSU1.negative', 'GND1.ref').psu(5, 1);
    const open = new EngineSession(b.snapshot()).solve();
    expect(!open.ok && open.error.code).toBe('floating_circuit');
    expect(!open.ok && open.error.components).toEqual([r2]);
  });
});

describe('stability over many transitions', () => {
  it('1,000 alternating live toggle transitions reproduce fresh solves bit-for-bit', () => {
    const b = switchLoop('component.toggle_switch', 4700, false);
    const snap = b.snapshot();
    const fresh = {
      open: ok(
        new EngineSession(switchLoop('component.toggle_switch', 4700, false).snapshot()).solve(),
      ),
      closed: ok(
        new EngineSession(switchLoop('component.toggle_switch', 4700, true).snapshot()).solve(),
      ),
    };
    const s = new EngineSession(snap);
    for (let k = 1; k <= 1000; k++) {
      const closed = k % 2 === 1;
      expect(s.applyControl('SW1', { closed }, snap.projectRevision + k)).toBeNull();
      const r = ok(s.solve());
      const ref = closed ? fresh.closed : fresh.open;
      expect(bits(r.components.R1!.current)).toBe(bits(ref.components.R1!.current));
      expect(bits(r.components.SW1!.voltage)).toBe(bits(ref.components.SW1!.voltage));
    }
  });

  it('1,000 button press/release cycles with an LED return to the exact released state', () => {
    const b = new Bench();
    const sw = b.add('component.push_button');
    const r = b.add('component.resistor');
    const d = b.add('component.led');
    b.wire('PSU1.positive', `${sw}.a`).wire(`${sw}.b`, `${r}.a`).wire(`${r}.b`, `${d}.anode`);
    b.wire(`${d}.cathode`, 'GND1.ref').wire('PSU1.negative', 'GND1.ref').psu(5, 0.1).ohms(r, 220);
    const s = new EngineSession(b.snapshot());
    const released = ok(s.solve());
    expect(released.components[d]!.current).toBe(0);
    let pressedBits = '';
    for (let k = 0; k < 1000; k++) {
      s.setMomentary(sw, true);
      const p = ok(s.solve());
      pressedBits ||= bits(p.components[d]!.current);
      expect(bits(p.components[d]!.current)).toBe(pressedBits);
      s.setMomentary(sw, false);
      expect(ok(s.solve()).components[d]!.current).toBe(0);
    }
  });
});

describe('runtime interaction categories are separate', () => {
  it('push button: transient only, never through a persistent control or a revision', () => {
    const snap = switchLoop('component.push_button', 1000).snapshot();
    const s = new EngineSession(snap);
    expect(ok(s.solve()).components.SW1).toMatchObject({ closed: false, current: 0 });
    expect(s.setMomentary('SW1', true)).toBeNull();
    const pressed = ok(s.solve());
    expect(relErr(pressed.components.R1!.current, 5e-3)).toBeLessThanOrEqual(REL);
    expect(pressed.appliedRevision).toBe(snap.projectRevision); // no revision involved
    expect(s.applyControl('SW1', { closed: true }, 99)?.code).toBe('unsupported_component');
    expect(JSON.stringify(snap)).not.toMatch(/pressed/);
  });

  it('toggle: a persistent live control only; momentary input is refused', () => {
    const s = new EngineSession(switchLoop('component.toggle_switch', 1000).snapshot());
    expect(s.setMomentary('SW1', true)?.code).toBe('unsupported_component');
    expect(s.applyControl('SW1', { setpointVoltage: 3 }, 9)?.code).toBe('unsupported_component');
    expect(s.applyControl('PSU1', { closed: true }, 9)?.code).toBe('unsupported_component');
  });
});
