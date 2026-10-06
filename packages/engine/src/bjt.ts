/**
 * Bipolar junction transistor: the SPICE Gummel-Poon model, DC part (Sprint 10, PM-6 revision).
 *
 * Equations follow the SPICE3/ngspice BJT model (bjtload.c / bjttemp.c), restricted to what a DC
 * operating point uses; tests/bjt.test.ts checks them against ngspice on the same .model card:
 *
 *   I_be = IS (exp(Vbe/(NF Vt)) - 1)          I_be,leak = ISE (exp(Vbe/(NE Vt)) - 1)
 *   I_bc = IS (exp(Vbc/(NR Vt)) - 1)          I_bc,leak = ISC (exp(Vbc/(NC Vt)) - 1)
 *   q1 = 1 / (1 - Vbc/VAF - Vbe/VAR),  q2 = I_be/IKF + I_bc/IKR,  qb = q1 (1 + sqrt(1 + 4 q2)) / 2
 *   Ic = (I_be - I_bc)/qb - I_bc/BR - I_bc,leak
 *   Ib = I_be/BF + I_be,leak + I_bc/BR + I_bc,leak
 *
 * with constant base resistance RB (RBM = RB, IRB not used), collector resistance RC and emitter
 * resistance RE as internal nodes, gmin across each leakage term (as SPICE), and SPICE junction
 * voltage limiting (pnjlim) on Vbe and Vbc. Temperature: the card's parameters apply at TNOM; the
 * standard SPICE scaling (XTI, EG, XTB) brings IS, ISE, ISC, BF and BR to the simulation
 * temperature (25 degC). Charge storage (capacitances, transit times) is not used: DC only.
 */
import type { Device, Indexer, StampOptions, StampTarget, TerminalCurrent } from './devices.js';
import { CODATA_2019, T_AMBIENT_K } from './models.js';

export interface BjtModel {
  /** Model name, also the ngspice .model name in tests. */
  readonly name: string;
  readonly IS: number;
  readonly BF: number;
  readonly NF: number;
  readonly VAF: number; // Infinity = not modelled
  readonly IKF: number; // Infinity = not modelled (SPICE 0)
  readonly ISE: number;
  readonly NE: number;
  readonly BR: number;
  readonly NR: number;
  readonly VAR: number;
  readonly IKR: number;
  readonly ISC: number;
  readonly NC: number;
  readonly RB: number;
  readonly RC: number;
  readonly RE: number;
  readonly XTI: number;
  readonly EG: number;
  readonly XTB: number;
  /** Temperature the parameters were extracted at, kelvin (SPICE default TNOM = 27 degC). */
  readonly TNOM: number;
  readonly provenance: string;
}

const KOVERQ = CODATA_2019.boltzmannJPerK / CODATA_2019.elementaryChargeC;

/** The model's DC parameters scaled to temperature T (SPICE3 bjttemp.c). */
export function bjtAtTemperature(m: BjtModel, T: number = T_AMBIENT_K) {
  const vt = KOVERQ * T;
  const ratlog = Math.log(T / m.TNOM);
  const ratio1 = T / m.TNOM - 1;
  const factlog = (ratio1 * m.EG) / vt + m.XTI * ratlog;
  const factor = Math.exp(factlog);
  const bfactor = Math.exp(ratlog * m.XTB);
  return {
    vt,
    IS: m.IS * factor,
    BF: m.BF * bfactor,
    BR: m.BR * bfactor,
    ISE: (m.ISE * Math.exp(factlog / m.NE)) / bfactor,
    ISC: m.ISC === 0 ? 0 : (m.ISC * Math.exp(factlog / m.NC)) / bfactor,
  };
}

/** DC currents and their partial derivatives at internal junction voltages. */
export function bjtCurrents(
  m: BjtModel,
  t: ReturnType<typeof bjtAtTemperature>,
  vbe: number,
  vbc: number,
  gmin: number,
) {
  const vtnF = t.vt * m.NF;
  const vtnR = t.vt * m.NR;
  const junction = (v: number, is: number, vtn: number) => {
    // SPICE: an exponential forward branch; well into reverse bias a linear continuation.
    if (v > -5 * vtn) {
      const e = Math.exp(v / vtn);
      return { i: is * (e - 1), g: (is * e) / vtn };
    }
    const g = -is / v;
    return { i: g * v, g };
  };
  const leak = (v: number, is: number, n: number, vtn: number) => {
    if (is === 0) return { i: gmin * v, g: gmin };
    const vte = n * t.vt;
    if (v > -5 * vtn) {
      const e = Math.exp(v / vte);
      return { i: is * (e - 1) + gmin * v, g: (is * e) / vte + gmin };
    }
    const g = -is / v;
    return { i: g * v + gmin * v, g: g + gmin };
  };
  const be = junction(vbe, t.IS, vtnF);
  const bc = junction(vbc, t.IS, vtnR);
  const ben = leak(vbe, t.ISE, m.NE, vtnF);
  const bcn = leak(vbc, t.ISC, m.NC, vtnR);
  const invVaf = Number.isFinite(m.VAF) ? 1 / m.VAF : 0;
  const invVar = Number.isFinite(m.VAR) ? 1 / m.VAR : 0;
  const oik = Number.isFinite(m.IKF) ? 1 / m.IKF : 0;
  const oikr = Number.isFinite(m.IKR) ? 1 / m.IKR : 0;
  const q1 = 1 / (1 - invVaf * vbc - invVar * vbe);
  let qb: number;
  let dqbdve: number;
  let dqbdvc: number;
  if (oik === 0 && oikr === 0) {
    qb = q1;
    dqbdve = q1 * qb * invVar;
    dqbdvc = q1 * qb * invVaf;
  } else {
    const q2 = oik * be.i + oikr * bc.i;
    const arg = Math.max(0, 1 + 4 * q2);
    const sqarg = arg !== 0 ? Math.sqrt(arg) : 1;
    qb = (q1 * (1 + sqarg)) / 2;
    dqbdve = q1 * (qb * invVar + (oik * be.g) / sqarg);
    dqbdvc = q1 * (qb * invVaf + (oikr * bc.g) / sqarg);
  }
  const ic = (be.i - bc.i) / qb - bc.i / t.BR - bcn.i;
  const ib = be.i / t.BF + ben.i + bc.i / t.BR + bcn.i;
  // Partial derivatives (Jacobian) with respect to vbe and vbc.
  const dic_dvbe = (be.g - ((be.i - bc.i) * dqbdve) / qb) / qb;
  const dic_dvbc = (-bc.g - ((be.i - bc.i) * dqbdvc) / qb) / qb - bc.g / t.BR - bcn.g;
  const dib_dvbe = be.g / t.BF + ben.g;
  const dib_dvbc = bc.g / t.BR + bcn.g;
  return { ic, ib, dic_dvbe, dic_dvbc, dib_dvbe, dib_dvbc, qb };
}

/** NPN transistor device: collector, base, emitter (+ internal nodes for RB, RC, RE). */
export class Npn implements Device {
  readonly kind = 'bjt-npn';
  readonly hasBranch = false;
  private ic = -1;
  private ib = -1;
  private ie = -1;
  private icp = -1;
  private ibp = -1;
  private iep = -1;
  private prev: { vbe: number; vbc: number } | null = null;
  private limiting = false;
  private readonly t: ReturnType<typeof bjtAtTemperature>;
  private readonly vcrit: number;
  private readonly nodes: { c: string; b: string; e: string; cp: string; bp: string; ep: string };

  constructor(
    readonly id: string,
    collector: string,
    base: string,
    emitter: string,
    readonly model: BjtModel,
    temperatureK: number = T_AMBIENT_K,
  ) {
    this.t = bjtAtTemperature(model, temperatureK);
    this.vcrit = this.t.vt * Math.log(this.t.vt / (Math.SQRT2 * this.t.IS));
    this.nodes = {
      c: collector,
      b: base,
      e: emitter,
      cp: model.RC > 0 ? `${id}#c` : collector,
      bp: model.RB > 0 ? `${id}#b` : base,
      ep: model.RE > 0 ? `${id}#e` : emitter,
    };
  }

  get limitingActive(): boolean {
    return this.limiting;
  }
  nodeNames(): string[] {
    return [...new Set(Object.values(this.nodes))];
  }
  prepare(idx: Indexer): void {
    const n = this.nodes;
    this.ic = idx.node(n.c);
    this.ib = idx.node(n.b);
    this.ie = idx.node(n.e);
    this.icp = idx.node(n.cp);
    this.ibp = idx.node(n.bp);
    this.iep = idx.node(n.ep);
  }
  resetState(): void {
    this.prev = null;
    this.limiting = false;
  }
  branchResidual(): null {
    return null;
  }

  private v(x: readonly number[] | null, i: number) {
    return x === null || i < 0 ? 0 : x[i]!;
  }

  /** SPICE pnjlim. */
  private limit(vNew: number, vOld: number, vtn: number): number {
    if (vNew > this.vcrit && Math.abs(vNew - vOld) > 2 * vtn) {
      if (vOld > 0) {
        const arg = 1 + (vNew - vOld) / vtn;
        return arg > 0 ? vOld + vtn * Math.log(arg) : this.vcrit;
      }
      return vtn * Math.log(vNew / vtn);
    }
    return vNew;
  }

  private junctions(x: readonly number[] | null) {
    return {
      vbe: this.v(x, this.ibp) - this.v(x, this.iep),
      vbc: this.v(x, this.ibp) - this.v(x, this.icp),
    };
  }

  stamp(t: StampTarget, x: readonly number[] | null, opts: StampOptions): void {
    const A = (r: number, c: number, val: number) => {
      if (r >= 0 && c >= 0) t.addA(r, c, val);
    };
    const Z = (r: number, val: number) => {
      if (r >= 0) t.addZ(r, val);
    };
    const resistor = (a: number, b: number, ohm: number) => {
      const g = 1 / ohm;
      A(a, a, g);
      A(a, b, -g);
      A(b, b, g);
      A(b, a, -g);
    };
    const m = this.model;
    if (m.RB > 0) resistor(this.ib, this.ibp, m.RB);
    if (m.RC > 0) resistor(this.ic, this.icp, m.RC);
    if (m.RE > 0) resistor(this.ie, this.iep, m.RE);

    const raw = this.junctions(x);
    let { vbe, vbc } = raw;
    if (this.prev) {
      vbe = this.limit(vbe, this.prev.vbe, this.t.vt * m.NF);
      vbc = this.limit(vbc, this.prev.vbc, this.t.vt * m.NR);
    }
    this.limiting = vbe !== raw.vbe || vbc !== raw.vbc;
    this.prev = { vbe, vbc };
    const k = bjtCurrents(m, this.t, vbe, vbc, opts.gmin);
    // Linearised terminal currents INTO the device at c', b' (and out of e'):
    //   Ic ~ ic + dic_dvbe (Vbe - vbe) + dic_dvbc (Vbc - vbc), Vbe = V(b') - V(e'), Vbc = V(b') - V(c').
    // KCL rows hold currents LEAVING each node into devices: a current into the device at c' leaves c'.
    const rows: [number, number, number, number][] = [
      // node, current, d/dVbe, d/dVbc
      [this.icp, k.ic, k.dic_dvbe, k.dic_dvbc],
      [this.ibp, k.ib, k.dib_dvbe, k.dib_dvbc],
      [this.iep, -(k.ic + k.ib), -(k.dic_dvbe + k.dib_dvbe), -(k.dic_dvbc + k.dib_dvbc)],
    ];
    for (const [node, i0, gbe, gbc] of rows) {
      if (node < 0) continue;
      // d/dV(b') = gbe + gbc, d/dV(e') = -gbe, d/dV(c') = -gbc
      A(node, this.ibp, gbe + gbc);
      A(node, this.iep, -gbe);
      A(node, this.icp, -gbc);
      Z(node, -(i0 - gbe * vbe - gbc * vbc));
    }
  }

  /** Exact terminal currents into the device: collector, base, emitter (sign: into the device). */
  terminalCurrents(x: readonly number[], gmin: number) {
    const { vbe, vbc } = this.junctions(x);
    const k = bjtCurrents(this.model, this.t, vbe, vbc, gmin);
    return { ic: k.ic, ib: k.ib, ie: -(k.ic + k.ib) };
  }

  current(x: readonly number[], opts: StampOptions): number {
    return this.terminalCurrents(x, opts.gmin).ic;
  }

  exactTerminalCurrents(x: readonly number[], opts: StampOptions): TerminalCurrent[] {
    const { ic, ib, ie } = this.terminalCurrents(x, opts.gmin);
    const out: TerminalCurrent[] = [
      { nodeIndex: this.icp, currentLeaving: ic },
      { nodeIndex: this.ibp, currentLeaving: ib },
      { nodeIndex: this.iep, currentLeaving: ie },
    ];
    const m = this.model;
    const res = (a: number, b: number, ohm: number) => {
      const i = (this.v(x, a) - this.v(x, b)) / ohm;
      out.push({ nodeIndex: a, currentLeaving: i }, { nodeIndex: b, currentLeaving: -i });
    };
    if (m.RB > 0) res(this.ib, this.ibp, m.RB);
    if (m.RC > 0) res(this.ic, this.icp, m.RC);
    if (m.RE > 0) res(this.ie, this.iep, m.RE);
    return out;
  }
}

/**
 * 2N3904 model card: Fairchild Semiconductor's published SPICE model (2N3904/MMBT3904/PZT3904
 * datasheet, Rev A, 2001, page 2 "Spice Model"; also the Fairchild PSpice library, pid=23 case=TO92).
 * The datasheet prints `Ise=6.734` without the femto suffix, an evident typo (6.734 A); the library
 * listing of the same model reads `Ise=6.734f`, used here. Unlisted parameters take SPICE defaults
 * (NF = NR = 1, VAR = IKR = infinity, RE = 0, TNOM = 27 degC).
 */
export const BJT_2N3904: BjtModel = {
  name: 'Q2N3904',
  IS: 6.734e-15,
  BF: 416.4,
  NF: 1,
  VAF: 74.03,
  IKF: 66.78e-3,
  ISE: 6.734e-15,
  NE: 1.259,
  BR: 0.7371,
  NR: 1,
  VAR: Infinity,
  IKR: Infinity,
  ISC: 0,
  NC: 2,
  RB: 10,
  RC: 1,
  RE: 0,
  XTI: 3,
  EG: 1.11,
  XTB: 1.5,
  TNOM: 273.15 + 27,
  provenance:
    'Fairchild 2N3904/MMBT3904/PZT3904 datasheet Rev A (2001) p.2 Spice Model (Ise=6.734f per ' +
    'the Fairchild PSpice library listing; the datasheet omits the f suffix). DC parameters only.',
};
