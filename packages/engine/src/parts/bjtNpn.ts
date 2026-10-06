/**
 * NPN transistor, 2N3904 (Sprint 10, PM-6 revision: "one clearly identified transistor"). The
 * device is the SPICE Gummel-Poon DC model with Fairchild's published model card (bjt.ts),
 * validated against ngspice on the same card (tests/bjt.test.ts).
 *
 * Reported: terminal currents (into the collector and base, out of the emitter), V_BE, V_CE, and an
 * operating REGION for teaching. The region is a display classification of the solved junction
 * biases only (it never changes a number): cutoff (neither junction above 0.5 V forward),
 * forward active (B-E forward, B-C not), saturation (both forward), reverse active (B-C forward,
 * B-E not).
 *
 * Limits (documented): DC only (no capacitances or transit times); no breakdown (V_CEO 40 V,
 * V_CBO 60 V, V_EBO 6 V are rating warnings, not modelled breakdown); no self-heating; 25 degC.
 * Ratings: onsemi 2N3903/D Rev. 9 (2021) absolute maximum ratings.
 */
import { BJT_2N3904, Npn } from '../bjt.js';
import { registerPart, validateCard, type PartModel } from '../parts.js';

export const RATINGS_2N3904 = {
  vceoV: 40,
  vcboV: 60,
  veboV: 6,
  icA: 0.2,
  pdW: 0.625,
};

const cards = { 'model.bjt.fairchild_2n3904': { partNumber: '2N3904' } };
const FORWARD = 0.5;

export function bjtRegion(
  vbe: number,
  vbc: number,
): 'cutoff' | 'active' | 'saturation' | 'reverse' {
  const be = vbe > FORWARD;
  const bc = vbc > FORWARD;
  return be && bc ? 'saturation' : be ? 'active' : bc ? 'reverse' : 'cutoff';
}

export const BJT_NPN: PartModel = {
  terminals: ['collector', 'base', 'emitter'],
  cards,
  validate: (ctx) => validateCard(ctx, cards),
  elements: (ctx) => {
    const key = ctx.component.id;
    const nodes: [string, string, string] = [
      ctx.node('collector'),
      ctx.node('base'),
      ctx.node('emitter'),
    ];
    return [
      {
        kind: 'device',
        key,
        nodes,
        make: () => new Npn(key, nodes[0], nodes[1], nodes[2], BJT_2N3904),
      },
    ];
  },
  report: (ctx, _s, sol) => {
    const c = sol.potential('collector');
    const b = sol.potential('base');
    const e = sol.potential('emitter');
    const ic = sol.deviceCurrent(ctx.component.id);
    const vbe = b !== null && e !== null ? b - e : null;
    const vce = c !== null && e !== null ? c - e : null;
    // The base current, exactly, from the device at the solution.
    const ib = sol.deviceTerminalCurrents?.(ctx.component.id)?.ib ?? null;
    return {
      current: ic,
      voltage: vce,
      terminals: { collector: c, base: b, emitter: e },
      currents: { collector: ic, base: ib, emitter: ib === null ? null : ic + ib },
      state: {
        region: vbe !== null && vce !== null ? bjtRegion(vbe, vbe - vce) : 'cutoff',
      },
    };
  },
  ratings: (_p, r) => {
    const out: ReturnType<NonNullable<PartModel['ratings']>> = [];
    const { collector: c, base: b, emitter: e } = r.terminals;
    const ic = r.currents?.collector;
    if (c != null && e != null && c - e > RATINGS_2N3904.vceoV)
      out.push({ code: 'voltage', value: c - e, limit: RATINGS_2N3904.vceoV, channel: 'vce' });
    if (c != null && b != null && c - b > RATINGS_2N3904.vcboV)
      out.push({ code: 'voltage', value: c - b, limit: RATINGS_2N3904.vcboV, channel: 'vcb' });
    if (e != null && b != null && e - b > RATINGS_2N3904.veboV)
      out.push({ code: 'voltage', value: e - b, limit: RATINGS_2N3904.veboV, channel: 'veb' });
    if (ic != null && ic > RATINGS_2N3904.icA)
      out.push({ code: 'current', value: ic, limit: RATINGS_2N3904.icA, channel: 'collector' });
    const ib = r.currents?.base;
    if (ic != null && ib != null && c != null && e != null && b != null) {
      const p = Math.abs(ic * (c - e)) + Math.abs(ib * (b - e));
      if (p > RATINGS_2N3904.pdW) out.push({ code: 'power', value: p, limit: RATINGS_2N3904.pdW });
    }
    return out;
  },
};

registerPart('component.bjt_npn', BJT_NPN);
