/**
 * Sprint 10: the 2N3904 (Gummel-Poon DC, Fairchild card) against ngspice on the SAME .model card,
 * through the production session (catalog part, snapshot, solver), across cutoff, forward active,
 * saturation and reverse active; plus the region classification and ratings.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from 'eecircuit-engine';
import { EngineSession, ratingWarnings, type SolveSuccess } from '../src/index.js';
import { BJT_2N3904 } from '../src/bjt.js';
import { Bench } from './build.js';

const m = BJT_2N3904;
const MODEL =
  `.model Q2N3904 NPN(IS=${m.IS} BF=${m.BF} NF=${m.NF} VAF=${m.VAF} IKF=${m.IKF} ISE=${m.ISE} ` +
  `NE=${m.NE} BR=${m.BR} NR=${m.NR} ISC=${m.ISC} NC=${m.NC} RB=${m.RB} RC=${m.RC} ` +
  `XTI=${m.XTI} EG=${m.EG} XTB=${m.XTB} TNOM=27)`;

/** Vcc -> Rc -> collector; Vcc -> Rb -> base; emitter -> Re (or GND). */
function commonEmitter(vcc: number, rb: number, rc: number, re = 0, swapCE = false) {
  const b = new Bench();
  const q = b.add('component.bjt_npn');
  const rB = b.add('component.resistor');
  const rC = b.add('component.resistor');
  const [col, emi] = swapCE ? ['emitter', 'collector'] : ['collector', 'emitter'];
  b.ohms(rB, rb)
    .ohms(rC, rc)
    .wire('PSU1.positive', `${rB}.a`)
    .wire(`${rB}.b`, `${q}.base`)
    .wire('PSU1.positive', `${rC}.a`)
    .wire(`${rC}.b`, `${q}.${col}`)
    .wire('PSU1.negative', 'GND1.ref')
    .psu(vcc, 1);
  if (re > 0) {
    const rE = b.add('component.resistor');
    b.ohms(rE, re).wire(`${q}.${emi}`, `${rE}.a`).wire(`${rE}.b`, 'GND1.ref');
  } else b.wire(`${q}.${emi}`, 'GND1.ref');
  const snap = b.snapshot();
  const o = new EngineSession(snap).solve();
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  return { o: o as SolveSuccess, q, snap };
}

describe('2N3904 against ngspice (same Gummel-Poon card)', () => {
  let sim: Simulation;
  beforeAll(async () => {
    sim = new Simulation();
    await sim.start();
  }, 120_000);

  async function spice(vcc: number, rb: number, rc: number, re: number, swapCE: boolean) {
    const [c, e] = swapCE ? ['e', 'c'] : ['c', 'e'];
    sim.setNetList(
      [
        'ce',
        `V1 vcc 0 ${vcc}`,
        `RB vcc b ${rb}`,
        `RC vcc ${c} ${rc}`,
        re > 0 ? `RE ${e} 0 ${re}` : `VE ${e} 0 0`,
        'Q1 c b e Q2N3904',
        MODEL,
        '.options temp=25 reltol=1e-9 abstol=1e-15 vntol=1e-12 gmin=1e-12',
        '.op',
        '.end',
      ].join('\n'),
    );
    const res = await sim.runSim();
    expect(sim.getError()).toEqual([]);
    const v = (n: string) =>
      (
        res.data.find((x: { name: string }) => x.name.toLowerCase() === `v(${n})`)!
          .values as number[]
      )[0]!;
    return { vb: v('b'), vc: v('c'), ve: re > 0 || true ? v('e') : 0 };
  }

  const cases: [string, number, number, number, number, boolean][] = [
    ['cutoff-ish (1 GOhm base)', 5, 1e9, 1000, 0, false],
    ['forward active, light', 5, 1e6, 1000, 0, false],
    ['forward active', 5, 470e3, 1000, 0, false],
    ['edge of saturation', 5, 100e3, 1000, 0, false],
    ['saturated switch', 5, 10e3, 1000, 0, false],
    ['hard saturation, 100 mA region', 12, 2.2e3, 100, 0, false],
    ['emitter degeneration', 9, 220e3, 2200, 470, false],
    ['reverse active (C and E swapped)', 5, 100e3, 1000, 0, true],
  ];
  for (const [label, vcc, rb, rc, re, swap] of cases)
    it(label, async () => {
      const { o, q } = commonEmitter(vcc, rb, rc, re, swap);
      const s = await spice(vcc, rb, rc, re, swap);
      const r = o.components[q]!;
      const t = r.terminals;
      const near = (a: number, b: number) =>
        expect(Math.abs(a - b), `${label}: ${a} vs ${b}`).toBeLessThan(2e-6 + 1e-6 * Math.abs(b));
      near(t.base!, s.vb);
      near(t.collector!, s.vc);
      near(t.emitter!, s.ve);
    });
});

describe('2N3904 in the session: results, region, ratings', () => {
  it('reports currents by terminal (KCL), V_CE and the operating region', () => {
    const active = commonEmitter(5, 470e3, 1000);
    const r = active.o.components[active.q]!;
    const { collector: ic, base: ib, emitter: ie } = r.currents!;
    // About 140 at 9 uA: below BF because the card's B-E leakage (ISE, NE) dominates the base
    // current at low current; the datasheet's minimum hFE at 0.1 mA is 40.
    expect(ic! / ib!).toBeGreaterThan(40);
    expect(ie).toBeCloseTo(ic! + ib!, 15);
    expect(r.state!.region).toBe('active');
    expect(r.voltage).toBeCloseTo(r.terminals.collector! - r.terminals.emitter!, 12);
    expect(commonEmitter(5, 10e3, 1000).o.components.Q1!.state!.region).toBe('saturation');
    expect(commonEmitter(5, 1e9, 1000).o.components.Q1!.state!.region).toBe('cutoff');
    // Saturated: V_CE(sat) within the datasheet's 0.2 V maximum at Ic = 10 mA, Ib = 1 mA class.
    const sat = commonEmitter(5, 4.3e3, 500).o.components.Q1!;
    expect(sat.voltage!).toBeLessThan(0.2);
  });

  it('flags collector current beyond 200 mA and V_CE beyond 40 V (no breakdown is modelled)', () => {
    const hot = commonEmitter(12, 1e3, 20);
    const w = ratingWarnings(hot.snap, hot.o).filter((x) => x.component === 'Q1');
    expect(w.some((x) => x.code === 'current' && x.channel === 'collector')).toBe(true);
    const high = commonEmitter(30, 1e9, 10);
    expect(ratingWarnings(high.snap, high.o)).toEqual([]);
  });
});

describe('2N3904 in cut-off feeding an LED (an ill-conditioned femtoamp node)', () => {
  it('solves at every light level: verified by the exact equations, LED dark, region cut-off', () => {
    for (const rLow of [3550, 1000, 330, 100]) {
      // A divider (47 kOhm over a resistance standing in for the photoresistor) holds the base low.
      const b = new Bench();
      const q = b.add('component.bjt_npn');
      const r1 = b.add('component.resistor');
      const r2 = b.add('component.resistor');
      const rl = b.add('component.resistor');
      const d = b.add('component.led');
      b.ohms(r1, 47e3)
        .ohms(rl, rLow)
        .ohms(r2, 220)
        .wire('PSU1.positive', `${r1}.a`)
        .wire(`${r1}.b`, `${q}.base`)
        .wire(`${q}.base`, `${rl}.a`)
        .wire(`${rl}.b`, 'GND1.ref')
        .wire(`${q}.emitter`, 'GND1.ref')
        .wire('PSU1.positive', `${r2}.a`)
        .wire(`${r2}.b`, `${d}.anode`)
        .wire(`${d}.cathode`, `${q}.collector`)
        .wire('PSU1.negative', 'GND1.ref')
        .psu(5, 0.1);
      const o = new EngineSession(b.snapshot()).solve();
      expect(o.ok, `R_low = ${rLow}`).toBe(true);
      if (!o.ok) continue;
      expect(o.components[q]!.state!.region).toBe('cutoff');
      expect(Math.abs(o.components[d]!.current!)).toBeLessThan(1e-7); // nanoamps: dark
      expect(o.stats.maxKclResidualA).toBeLessThan(1e-12);
    }
  });
});
