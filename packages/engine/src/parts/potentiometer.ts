/**
 * Potentiometer, Bourns PTV09A series, linear taper (Sprint POT-UNITS). Three terminals: track
 * end A (pin 1), wiper W (pin 2), track end B (pin 3). The track is a linear resistor of total
 * resistance R; the wiper divides it:
 *
 *   R_AW = R * p,   R_WB = R * (1 - p),   p = position / 100
 *
 * Two linear resistors: a real, deterministic divider (and, with A or B unwired, a rheostat).
 *
 * Source: Bourns, "PTV09 - 9 mm Rotary Potentiometer" datasheet, REV. 01/25, 5 pages,
 * https://www.bourns.com/docs/Product-Datasheets/PTV09.pdf, fetched 2026-10-30, SHA-256
 * 411cdb6a…f28558 (docs/sprints/s10-evidence/datasheets/FACTS.md §12). Page 1:
 * - standard resistance range 1 kΩ … 1 MΩ (1-2-5 values, codes 102 … 105); tolerance ±20 %;
 * - power rating 0.05 W (linear and audio); maximum operating voltage 20 VDC (50 VAC);
 * - residual resistance "500 ohms or ±1 % max." (a BOUND, not a value);
 * - tapers: linear (B) and audio (A); pins 1, 3 = track ends, 2 = wiper.
 *
 * Idealisations (labelled engineering assumptions; packages/engine/PROVENANCE.md):
 * - ASSUMPTION POT-1 (end resistance): the datasheet bounds the residual resistance at the track
 *   ends but gives no typical value, so it is idealised to 0 Ω: at 0 % (100 %) the wiper is an
 *   ideal contact to end A (B). A real part leaves up to the stated bound there.
 * - ASSUMPTION POT-2 (nominal value): the total resistance is the nominal value; the ±20 %
 *   tolerance is not sampled (as for every other part, results are for a nominal part).
 * - `position` is the wiper's place along the electrical track (the share of R between A and
 *   W), not the shaft angle: the B-taper curve's flat end zones (p.4, a graph) are not modelled.
 * - Wiper contact resistance and maximum wiper current: NOT in the datasheet; not modelled and
 *   no limit is claimed (MODEL_LIMITATIONS: potentiometer_wiper_current).
 * - Ratings: the 0.05 W rating is for the whole element; the datasheet states no rating for a
 *   part of the track. Three `unrated` checks (outside the specified conditions; no damage
 *   threshold is published, owner decision OD-POT-2 stays open for damage behaviour):
 *   1. total dissipation above 0.05 W;
 *   2. DERIVED from the datasheet's own rated condition, no new number (review H1): at the rated
 *      whole-track dissipation the track current is I_rated = sqrt(P_rated / R_total), uniform
 *      along the track. A segment (or the wiper contact) carrying more than I_rated dissipates
 *      more heat per unit track length (I^2 R / length) than any rated condition: a conservative
 *      warning (`track_current`, per segment and for the wiper), not a damage threshold;
 *   3. more than 20 VDC across any two terminals (an operating maximum; no absolute maximum).
 */
import { POT_STANDARD_OHMS } from '@tbi-lab/domain';
import { Resistor } from '../devices.js';
import { registerPart, validateCard, type PartElement, type PartModel } from '../parts.js';

export const PTV09A = {
  rangeOhm: [1e3, 1e6] as const,
  tolerance: 0.2,
  ratedPowerW: 0.05,
  maxOperatingV: 20,
  /** The datasheet's residual-resistance BOUND (Ω), recorded, not used (ASSUMPTION POT-1). */
  residualBoundOhm: 500,
  /** …"or ±1 % max." of the total: the same bound as a share of the track. */
  residualBoundShare: 0.01,
};

/**
 * Sprint 25: the largest residual resistance the datasheet allows at a track end, read as the
 * larger of its two figures ("500 ohms or ±1 % max."; the sheet does not say which applies, so the
 * wider uncertainty is reported). Used only to say where a result is an ideal-track limit.
 */
export function residualBoundOhm(totalOhm: number): number {
  return Math.max(PTV09A.residualBoundOhm, PTV09A.residualBoundShare * totalOhm);
}

/**
 * The track current at the rated whole-element dissipation (A): I_rated = sqrt(P_rated / R_total),
 * derived from the datasheet's 0.05 W (review H1); no other number is introduced.
 */
export function ratedTrackCurrentA(totalOhm: number): number {
  return Math.sqrt(PTV09A.ratedPowerW / totalOhm);
}

/** The two track segments for a total resistance and a position in percent. */
export function potSegments(totalOhm: number, positionPct: number): { aw: number; wb: number } {
  const p = positionPct / 100;
  return { aw: totalOhm * p, wb: totalOhm * (1 - p) };
}

const cards = {
  'model.potentiometer.bourns_ptv09a_linear': { partNumber: 'PTV09A' },
};

/** A segment of the track: a resistor, or (0 Ω at an end of travel) an ideal closed contact. */
function segment(key: string, nodes: [string, string], ohm: number): PartElement {
  return ohm > 0
    ? { kind: 'device', key, nodes, make: () => new Resistor(key, nodes[0], nodes[1], ohm) }
    : { kind: 'contact', key, nodes, closed: true };
}

export const POTENTIOMETER: PartModel = {
  terminals: ['a', 'wiper', 'b'],
  cards,
  liveParams: ['position'],
  validate: (ctx) => {
    const bad = validateCard(ctx, cards);
    if (bad) return bad;
    const r = ctx.quantity('resistance');
    if (!(r !== undefined && r > 0 && Number.isFinite(r)))
      return { code: 'invalid_parameter', components: [ctx.component.id], param: 'resistance' };
    // Sprint 25: only the values the part is made in (the datasheet's standard table).
    if (!POT_STANDARD_OHMS.includes(r))
      return {
        code: 'invalid_parameter',
        components: [ctx.component.id],
        param: 'resistance',
        detail: { reason: 'not_standard', value: r, values: [...POT_STANDARD_OHMS] },
      };
    const p = ctx.quantity('position');
    return p !== undefined && p >= 0 && p <= 100
      ? null
      : { code: 'invalid_parameter', components: [ctx.component.id], param: 'position' };
  },
  elements: (ctx) => {
    const id = ctx.component.id;
    const { aw, wb } = potSegments(ctx.quantity('resistance')!, ctx.quantity('position')!);
    return [
      segment(`${id}/aw`, [ctx.node('a'), ctx.node('wiper')], aw),
      segment(`${id}/wb`, [ctx.node('wiper'), ctx.node('b')], wb),
    ];
  },
  report: (ctx, _s, sol) => {
    const id = ctx.component.id;
    const a = sol.potential('a');
    const w = sol.potential('wiper');
    const b = sol.potential('b');
    const { aw, wb } = potSegments(ctx.quantity('resistance')!, ctx.quantity('position')!);
    // Segment currents, A -> W and W -> B (an ideal end contact reports its own branch current).
    const iOf = (key: string, ohm: number) =>
      ohm > 0 ? sol.deviceCurrent(key) : sol.contactCurrent(key);
    const iaw = iOf(`${id}/aw`, aw);
    const iwb = iOf(`${id}/wb`, wb);
    const power = (iaw !== null ? iaw * iaw * aw : 0) + (iwb !== null ? iwb * iwb * wb : 0);
    return {
      // The whole element, A -> B: the current entering at A (= the A-W segment's current).
      current: iaw,
      voltage: a !== null && b !== null ? a - b : null,
      terminals: { a, wiper: w, b },
      currents: {
        aw: iaw,
        wb: iwb,
        // Into the wiper terminal from outside (Kirchhoff at W).
        wiper: iaw !== null && iwb !== null ? iwb - iaw : null,
      },
      // The wiper's potential to GND (the divider's output), when defined.
      state: {
        resistanceAW: aw,
        resistanceWB: wb,
        power,
        ...(w !== null ? { wiperVoltage: w } : {}),
        // Sprint 25: a segment shorter than the datasheet's residual bound. A real part keeps
        // between 0 and this much resistance there (ASSUMPTION POT-1 models 0), so values that
        // depend on that end are the ideal-track limit, not an exact prediction.
        ...(Math.min(aw, wb) < residualBoundOhm(aw + wb)
          ? { residualMaxOhm: residualBoundOhm(aw + wb) }
          : {}),
      },
    };
  },
  ratings: (_p, r) => {
    const out: ReturnType<NonNullable<PartModel['ratings']>> = [];
    const power = r.state?.power;
    if (typeof power === 'number' && power > PTV09A.ratedPowerW)
      out.push({ kind: 'unrated', code: 'power', value: power, limit: PTV09A.ratedPowerW });
    const { a, wiper, b } = r.terminals;
    const pairs: [number | null | undefined, number | null | undefined][] = [
      [a, b],
      [a, wiper],
      [wiper, b],
    ];
    // (2) Track current per segment and at the wiper, against I_rated = sqrt(P_rated / R_total).
    const total =
      typeof r.state?.resistanceAW === 'number' && typeof r.state?.resistanceWB === 'number'
        ? r.state.resistanceAW + r.state.resistanceWB
        : null;
    if (total !== null && total > 0) {
      const iRated = ratedTrackCurrentA(total);
      const segs: [string, number | null | undefined, number][] = [
        ['aw', r.currents?.aw, r.state!.resistanceAW as number],
        ['wb', r.currents?.wb, r.state!.resistanceWB as number],
        // The wiper contact (whatever segment lengths): the current entering or leaving at W.
        ['wiper', r.currents?.wiper, 1],
      ];
      for (const [channel, i, ohm] of segs)
        if (ohm > 0 && i != null && Math.abs(i) > iRated)
          out.push({
            kind: 'unrated',
            code: 'track_current',
            value: Math.abs(i),
            limit: iRated,
            channel,
          });
    }
    let vmax = 0;
    for (const [x, y] of pairs) if (x != null && y != null) vmax = Math.max(vmax, Math.abs(x - y));
    if (vmax > PTV09A.maxOperatingV)
      out.push({ kind: 'unrated', code: 'voltage', value: vmax, limit: PTV09A.maxOperatingV });
    return out;
  },
};

registerPart('component.potentiometer', POTENTIOMETER);
