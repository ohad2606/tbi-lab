/**
 * Piecewise-linear two-terminal load (Sprint 10): I(V) interpolated through datasheet points, for
 * parts whose datasheet gives a measured current-voltage curve rather than a physical model (an
 * internally driven buzzer: its DC current is the average drawn by its own oscillator and coil).
 *
 * Forward (V >= 0): linear interpolation through (0, 0) and the points; beyond the last point the
 * last segment's slope continues. Reverse (V < 0): the datasheet specifies nothing; the model
 * conducts only gmin (an open circuit), and the part reports the reverse bias as outside its model.
 * Newton linearises on the segment containing V (exact on that segment); the exact residual check
 * verifies the solution against the same curve.
 */
import type { Device, Indexer, StampOptions, StampTarget, TerminalCurrent } from './devices.js';
import { GROUND_NAMES } from './devices.js';

export class PwlLoad implements Device {
  readonly kind = 'pwl-load';
  readonly hasBranch = false;
  readonly limitingActive = false;
  private ia = -1;
  private ib = -1;
  private readonly pts: readonly (readonly [number, number])[];

  constructor(
    readonly id: string,
    private readonly a: string,
    private readonly b: string,
    /** [V, A] points with strictly increasing V > 0. */
    points: readonly (readonly [number, number])[],
  ) {
    this.pts = [[0, 0], ...points];
    for (let k = 1; k < this.pts.length; k++)
      if (!(this.pts[k]![0] > this.pts[k - 1]![0]))
        throw new Error(`PwlLoad ${id}: V must increase`);
  }

  nodeNames(): string[] {
    return [this.a, this.b];
  }
  prepare(idx: Indexer): void {
    this.ia = GROUND_NAMES.has(this.a) ? -1 : idx.node(this.a);
    this.ib = GROUND_NAMES.has(this.b) ? -1 : idx.node(this.b);
  }
  resetState(): void {}
  branchResidual(): null {
    return null;
  }

  private v(x: readonly number[] | null): number {
    if (!x) return 0;
    return (this.ia < 0 ? 0 : x[this.ia]!) - (this.ib < 0 ? 0 : x[this.ib]!);
  }

  /** Segment slope (S) and intercept (A) at V. */
  private segment(v: number, gmin: number): { g: number; i0: number } {
    if (v < 0) return { g: gmin, i0: 0 };
    const p = this.pts;
    let k = 1;
    while (k < p.length - 1 && v > p[k]![0]) k++;
    const [v0, c0] = p[k - 1]!;
    const [v1, c1] = p[k]!;
    const g = (c1 - c0) / (v1 - v0);
    return { g: g + gmin, i0: c0 - g * v0 };
  }

  /** Exact current for a terminal voltage. */
  currentAt(v: number, gmin: number): number {
    const { g, i0 } = this.segment(v, gmin);
    return i0 + g * v;
  }

  stamp(t: StampTarget, x: readonly number[] | null, opts: StampOptions): void {
    const { g, i0 } = this.segment(this.v(x), opts.gmin);
    const add = (r: number, c: number, val: number) => {
      if (r >= 0 && c >= 0) t.addA(r, c, val);
    };
    add(this.ia, this.ia, g);
    add(this.ia, this.ib, -g);
    add(this.ib, this.ib, g);
    add(this.ib, this.ia, -g);
    if (this.ia >= 0) t.addZ(this.ia, -i0);
    if (this.ib >= 0) t.addZ(this.ib, i0);
  }

  current(x: readonly number[], opts: StampOptions): number {
    return this.currentAt(this.v(x), opts.gmin);
  }

  exactTerminalCurrents(x: readonly number[], opts: StampOptions): TerminalCurrent[] {
    const i = this.current(x, opts);
    return [
      { nodeIndex: this.ia, currentLeaving: i },
      { nodeIndex: this.ib, currentLeaving: -i },
    ];
  }
}
