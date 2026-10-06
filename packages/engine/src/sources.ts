/**
 * Module power primitives (Sprint 10), for sensor modules that regulate their own supply.
 *
 * RegulatedOutput: an output held at `volts` above a reference node, whose current is TAKEN FROM
 * the module's supply input (a series-pass regulator / driver): the current delivered out of
 * `out` enters the device at `vin`. So a load on a module's output shows up in the supply current,
 * as it does on the real board. Branch unknown j = current delivered out of `out`.
 *
 * ConstantSink: a constant current drawn from `a` to `b` (a module's quiescent supply current).
 */
import type { Device, Indexer, StampTarget, TerminalCurrent } from './devices.js';

export class RegulatedOutput implements Device {
  readonly kind = 'regulated-output';
  readonly hasBranch = true;
  readonly limitingActive = false;
  private iv = -1;
  private io = -1;
  private ir = -1;
  private br = -1;
  constructor(
    readonly id: string,
    private readonly vin: string,
    private readonly out: string,
    private readonly ref: string,
    public volts: number,
  ) {}
  nodeNames(): string[] {
    return [this.vin, this.out, this.ref];
  }
  prepare(idx: Indexer): void {
    this.iv = idx.node(this.vin);
    this.io = idx.node(this.out);
    this.ir = idx.node(this.ref);
    this.br = idx.branch(this.id);
  }
  resetState(): void {}
  stamp(t: StampTarget): void {
    const A = (r: number, c: number, v: number) => {
      if (r >= 0 && c >= 0) t.addA(r, c, v);
    };
    // KCL: j leaves vin (into the device) and enters out.
    A(this.iv, this.br, +1);
    A(this.io, this.br, -1);
    // Branch: V(out) - V(ref) = volts.
    A(this.br, this.io, +1);
    A(this.br, this.ir, -1);
    t.addZ(this.br, this.volts);
  }
  private v(x: readonly number[], i: number) {
    return i < 0 ? 0 : x[i]!;
  }
  current(x: readonly number[]): number {
    return x[this.br]!;
  }
  exactTerminalCurrents(x: readonly number[]): TerminalCurrent[] {
    const j = x[this.br]!;
    return [
      { nodeIndex: this.iv, currentLeaving: j },
      { nodeIndex: this.io, currentLeaving: -j },
    ];
  }
  branchResidual(x: readonly number[]): { value: number; unit: 'V' } {
    return { value: this.v(x, this.io) - this.v(x, this.ir) - this.volts, unit: 'V' };
  }
}

export class ConstantSink implements Device {
  readonly kind = 'constant-sink';
  readonly hasBranch = false;
  readonly limitingActive = false;
  private ia = -1;
  private ib = -1;
  constructor(
    readonly id: string,
    private readonly a: string,
    private readonly b: string,
    public amps: number,
  ) {}
  nodeNames(): string[] {
    return [this.a, this.b];
  }
  prepare(idx: Indexer): void {
    this.ia = idx.node(this.a);
    this.ib = idx.node(this.b);
  }
  resetState(): void {}
  stamp(t: StampTarget): void {
    if (this.ia >= 0) t.addZ(this.ia, -this.amps);
    if (this.ib >= 0) t.addZ(this.ib, this.amps);
  }
  current(): number {
    return this.amps;
  }
  exactTerminalCurrents(): TerminalCurrent[] {
    return [
      { nodeIndex: this.ia, currentLeaving: this.amps },
      { nodeIndex: this.ib, currentLeaving: -this.amps },
    ];
  }
  branchResidual(): null {
    return null;
  }
}
