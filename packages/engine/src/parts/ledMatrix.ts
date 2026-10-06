/**
 * LED matrices (Sprint 10, Tier 3): ONE abstraction for any rows x columns dot matrix, built from a
 * spec (size, dot model card, which side is anode). Each dot is its own `Diode` between its column
 * and row lines, so multiplexing, ghosting and current sharing are whatever the circuit drives; no
 * dot state is stored or hard-coded anywhere. A larger matrix is a new spec, not new code.
 *
 * The result carries the dot currents in row-major order (`array`), which the views read to light
 * each dot.
 */
import { Diode } from '../devices.js';
import { LED_MATRIX_1088AS_DOT, type DiodeModel } from '../models.js';
import { registerPart, validateCard, type PartModel } from '../parts.js';

export interface LedMatrixSpec {
  rows: number;
  cols: number;
  /** Row lines are the dots' cathodes and columns their anodes (or the reverse). */
  rowsAre: 'cathodes' | 'anodes';
  dot: DiodeModel;
  /** Forward-current range over which the dot card is documented. */
  validA: readonly [number, number];
  cards: Readonly<Record<string, { partNumber: string }>>;
}

export const rowTerminal = (i: number) => `r${i + 1}`;
export const colTerminal = (j: number) => `c${j + 1}`;

export function ledMatrixPart(spec: LedMatrixSpec): PartModel {
  const terminals = [
    ...Array.from({ length: spec.rows }, (_, i) => rowTerminal(i)),
    ...Array.from({ length: spec.cols }, (_, j) => colTerminal(j)),
  ];
  const dotKey = (id: string, i: number, j: number) => `${id}/${i + 1}.${j + 1}`;
  const model: PartModel = {
    terminals,
    cards: spec.cards,
    validate: (ctx) => validateCard(ctx, spec.cards),
    elements: (ctx) => {
      const els: ReturnType<PartModel['elements']> = [];
      for (let i = 0; i < spec.rows; i++)
        for (let j = 0; j < spec.cols; j++) {
          const key = dotKey(ctx.component.id, i, j);
          const row = ctx.node(rowTerminal(i));
          const col = ctx.node(colTerminal(j));
          const [anode, cathode] = spec.rowsAre === 'cathodes' ? [col, row] : [row, col];
          els.push({
            kind: 'device',
            key,
            nodes: [anode, cathode],
            make: () => new Diode(key, anode, cathode, spec.dot),
          });
        }
      return els;
    },
    report: (ctx, _s, sol) => {
      const currents: number[] = [];
      let outside = false;
      let lit = 0;
      for (let i = 0; i < spec.rows; i++)
        for (let j = 0; j < spec.cols; j++) {
          const c = sol.deviceCurrent(dotKey(ctx.component.id, i, j));
          currents.push(c);
          if (c > 1e-6) {
            lit++;
            if (c < spec.validA[0] || c > spec.validA[1]) outside = true;
          }
        }
      const term: Record<string, number | null> = {};
      for (const t of terminals) term[t] = sol.potential(t);
      return {
        current: null,
        voltage: null,
        terminals: term,
        array: { rows: spec.rows, cols: spec.cols, currents },
        state: { lit },
        ...(lit ? { outsideModelRange: outside } : {}),
      };
    },
  };
  return model;
}

/** 8x8 red, 3 mm dots, rows = cathodes, columns = anodes (1088AS). */
export const LED_MATRIX_8X8 = ledMatrixPart({
  rows: 8,
  cols: 8,
  rowsAre: 'cathodes',
  dot: LED_MATRIX_1088AS_DOT,
  validA: [1e-3, 20e-3],
  cards: { 'model.led_matrix.oasis_1088as': { partNumber: '1088AS' } },
});

registerPart('display.led_matrix_8x8', LED_MATRIX_8X8);
