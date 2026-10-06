/**
 * Sprint 10: the LED matrix abstraction (8x8 1088AS: rows are cathodes, columns anodes). Every dot
 * is its own diode between its lines, so what lights is exactly what the circuit drives.
 */
import { describe, expect, it } from 'vitest';
import { EngineSession, type SolveSuccess } from '../src/index.js';
import { ledMatrixPart } from '../src/parts/ledMatrix.js';
import { LED_MATRIX_1088AS_DOT, thermalVoltage } from '../src/models.js';
import { Bench } from './build.js';

/** Columns `cols` each from PSU+ through their own resistor; rows `rows` straight to GND. */
function drive(cols: number[], rows: number[], ohms = 220, volts = 5) {
  const b = new Bench();
  const m = b.add('display.led_matrix_8x8');
  for (const c of cols) {
    const r = b.add('component.resistor');
    b.ohms(r, ohms).wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, `${m}.c${c}`);
  }
  for (const r of rows) b.wire(`${m}.r${r}`, 'GND1.ref');
  b.wire('PSU1.negative', 'GND1.ref').psu(volts, 1);
  const o = new EngineSession(b.snapshot()).solve();
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  const arr = (o as SolveSuccess).components[m]!.array!;
  const dot = (r: number, c: number) => arr.currents[(r - 1) * 8 + (c - 1)]!;
  return { o: o as SolveSuccess, m, arr, dot };
}

describe('LED matrix 8x8 (1088AS)', () => {
  it('a dot conducts only where its column is driven and its row is grounded', () => {
    const { arr, dot, o, m } = drive([3], [5]);
    expect(arr.rows).toBe(8);
    expect(arr.cols).toBe(8);
    // KVL: 5 V = I R + V_F(I), V_F from the dot card.
    const i = dot(5, 3);
    const vf =
      LED_MATRIX_1088AS_DOT.emissionCoefficient *
      thermalVoltage() *
      Math.log(i / LED_MATRIX_1088AS_DOT.saturationCurrentA + 1);
    // (to 7 digits: the seven other dots on the column, to unconnected rows, leak at the gmin level)
    expect(i * 220 + vf).toBeCloseTo(5, 7);
    const others = arr.currents.filter((_, k) => k !== 4 * 8 + 2);
    expect(Math.max(...others.map(Math.abs))).toBeLessThan(1e-9);
    expect(o.components[m]!.state).toEqual({ lit: 1 });
  });

  it('dots on one column share its resistor; each driven column lights its own dots', () => {
    const one = drive([2], [2]).dot(2, 2);
    const two = drive([2], [2, 7]);
    expect(two.dot(2, 2)).toBeCloseTo(two.dot(7, 2), 12); // identical dots, identical share
    expect(two.dot(2, 2)).toBeLessThan(one); // the resistor now feeds two dots
    expect(two.dot(2, 2) * 2).toBeGreaterThan(one);
    const cross = drive([2, 7], [2, 7]);
    expect(cross.o.components[cross.m]!.state).toEqual({ lit: 4 });
  });

  it('the abstraction scales: a 16x16 spec is the same code (256 dots)', () => {
    const big = ledMatrixPart({
      rows: 16,
      cols: 16,
      rowsAre: 'cathodes',
      dot: LED_MATRIX_1088AS_DOT,
      validA: [1e-3, 20e-3],
      cards: { x: { partNumber: 'x' } },
    });
    expect(big.terminals).toHaveLength(32);
    const ctx = {
      component: { id: 'M', type: 'display.led_matrix_8x8', typeVersion: 1, params: {} },
      node: (t: string) => t,
      quantity: () => undefined,
      value: () => undefined,
      history: () => undefined,
    } as Parameters<typeof big.elements>[0];
    expect(big.elements(ctx, {})).toHaveLength(256);
  });
});
