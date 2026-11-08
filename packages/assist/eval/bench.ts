/**
 * Sprint 27 evaluation bench: real projects built through the domain's own edit operations and
 * solved by the real electrical engine (the same code the product runs). An ESP32 board is solved
 * as the Session Host solves it: the board-less projection with each pad attached to its net and
 * the pad's drive mode set (what the firmware would have done). Build and runtime outcomes, which
 * need the toolchain and QEMU, are given as the records those services produce (recorded shapes
 * from the Sprint 25/26 real-QEMU and real-toolchain tests), and labelled as such in each case.
 */
import {
  addComponent,
  addProgramFile,
  deleteSelection,
  addWire,
  checkCircuit,
  createProject,
  createSnapshot,
  setParam,
  setProgramProfile,
  setProgramText,
  type ComponentTypeId,
  type ParamValue,
  type ProjectDocument,
} from '@tbi-lab/domain';
import {
  EngineSession,
  ratingWarnings,
  type RuntimePinMode,
  type SolveOutcome,
} from '@tbi-lab/engine';
import type { BuildInput, ContextInput, FailureInput } from '../src/context.js';

export class Bench {
  /**
   * The product's wire routing (the app's `routeAutomatic`, which needs the canvas symbol boxes):
   * set by the app-side runner so wires are routed exactly as on the canvas. Unset: wires stay as
   * drawn, and the editor check may report wires passing over terminals.
   */
  static layout: ((doc: ProjectDocument) => ProjectDocument) | null = null;
  doc: ProjectDocument;
  private x = 0;
  board: string | null = null;
  constructor() {
    // createProject places PSU1 and GND1.
    this.doc = createProject({
      projectId: 'prj_eval',
      deviceId: 'd',
      name: 'Eval',
      appVersion: '0',
    });
  }
  add(type: ComponentTypeId): string {
    this.x += 240;
    const r = addComponent(this.doc, type, { x: this.x, y: 400 + (this.x % 480) });
    if (!r.ok) throw new Error(`${type}: ${r.error}`);
    this.doc = r.doc;
    if (type === 'board.esp32_devkitc_wroom32') this.board = r.id;
    return r.id;
  }
  wire(a: string, b: string): this {
    const [ac, at] = a.split('.') as [string, string];
    const [bc, bt] = b.split('.') as [string, string];
    const r = addWire(
      this.doc,
      { kind: 'terminal', component: ac, terminal: at },
      { kind: 'terminal', component: bc, terminal: bt },
      [],
      { waypoints: [] },
    );
    if (!r.ok) throw new Error(`${a}->${b}: ${r.error}`);
    this.doc = r.doc;
    return this;
  }
  set(id: string, key: string, value: ParamValue): this {
    const r = setParam(this.doc, id, key, value);
    if (!r.ok) throw new Error(`${id}.${key}: ${r.error}`);
    this.doc = r.doc;
    return this;
  }
  psu(volts: number, amps: number, enabled = true): this {
    return this.set('PSU1', 'setpointVoltage', { value: volts, unit: 'volt' })
      .set('PSU1', 'currentLimit', { value: amps, unit: 'ampere' })
      .set('PSU1', 'outputEnabled', enabled);
  }
  ohms(id: string, value: number): this {
    return this.set(id, 'resistance', { value, unit: 'ohm' });
  }
  /** The board's program (entry file), optionally in MicroPython. */
  program(text: string, language: 'arduino' | 'micropython' = 'arduino'): this {
    if (!this.board) throw new Error('no board');
    if (language === 'micropython') {
      const r = setProgramProfile(this.doc, this.board, 'esp32-micropython-1.29');
      if (!r.ok) throw new Error(r.error);
      this.doc = r.doc;
    }
    const r = setProgramText(this.doc, this.board, text);
    if (!r.ok) throw new Error(r.error);
    this.doc = r.doc;
    return this;
  }

  /** A further program file (Sprint 26 multi-file programs). */
  file(path: string, text: string): this {
    if (!this.board) throw new Error('no board');
    const r = addProgramFile(this.doc, this.board, path, text);
    if (!r.ok) throw new Error(r.error);
    this.doc = r.doc;
    return this;
  }
  /** Remove a part (e.g. the bench supply a board-only project does not use). */
  remove(id: string): this {
    const r = deleteSelection(this.doc, { components: [id], wires: [], junctions: [] });
    if (!r.ok) throw new Error(r.error);
    this.doc = r.doc;
    return this;
  }

  /** Solve the circuit as the product would (local DC, or the Session Host's projection). */
  solve(modes: Record<number, RuntimePinMode> = {}): SolveOutcome {
    const full = createSnapshot(this.doc);
    if (!this.board) return new EngineSession(full).solve();
    const u = this.board;
    const projected = {
      ...full,
      components: full.components.filter((c) => c.id !== u),
      connections: full.connections.filter((c) => c.component !== u),
    };
    const pins = full.connections
      .filter((c) => c.component === u && /^gpio\d+$/.test(c.terminal))
      .flatMap((c) => {
        const at = projected.connections.find((x) => x.net === c.net);
        return at
          ? [{ gpio: Number(c.terminal.slice(4)), component: at.component, terminal: at.terminal }]
          : [];
      });
    const s = new EngineSession(projected, { pins });
    for (const [g, m] of Object.entries(modes)) s.setPinMode(Number(g), m);
    return s.solve();
  }

  /**
   * The context input the app would gather: editor checks, and (when `run`) the engine's outcome
   * with its rating rows, or its refusal as the run's failure.
   */
  input(
    opts: {
      run?: boolean;
      modes?: Record<number, RuntimePinMode>;
      build?: BuildInput;
      failure?: FailureInput;
      runtimeCapabilities?: string[];
      observed?: ContextInput['observed'];
    } = {},
  ): ContextInput {
    if (Bench.layout) this.doc = Bench.layout(this.doc);
    let outcome: SolveOutcome | null = null;
    let failure: FailureInput | null = opts.failure ?? null;
    let ratings: ContextInput['ratings'] = [];
    if (opts.run && !failure) {
      const o = this.solve(opts.modes);
      if (o.ok) {
        outcome = o;
        ratings = ratingWarnings(createSnapshot(this.doc), o);
      } else failure = { kind: 'engine', error: o.error };
    }
    return {
      doc: this.doc,
      checks: checkCircuit(this.doc),
      outcome,
      ratings,
      failure,
      build: opts.build ?? null,
      observed: opts.observed ?? null,
      runtimeCapabilities: opts.runtimeCapabilities ?? RUNTIME_V5,
    };
  }
}

/** Runtime v5's announced capabilities (DEV-Lab, 39f2229a66d45e43). */
export const RUNTIME_V5 = [
  'gpio-irq',
  'i2c',
  'i2c-clock',
  'input-read',
  'pad-func',
  'pwm',
  'sched-input',
  'unmodelled',
];

/** A resistor-LED loop on the bench supply. */
export function ledLoop(volts: number, amps: number, ohms: number | null): Bench {
  const b = new Bench();
  const d = b.add('component.led');
  if (ohms === null) b.wire('PSU1.positive', `${d}.anode`);
  else {
    const r = b.add('component.resistor');
    b.ohms(r, ohms).wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, `${d}.anode`);
  }
  return b.wire(`${d}.cathode`, 'GND1.ref').wire('PSU1.negative', 'GND1.ref').psu(volts, amps);
}

/** An ESP32 board with its ground wired (and the supply's negative to ground). */
export function boardBench(opts: { psu?: boolean } = {}): { b: Bench; u: string } {
  const b = new Bench();
  const u = b.add('board.esp32_devkitc_wroom32');
  b.wire(`${u}.gnd`, 'GND1.ref');
  if (opts.psu === false) b.remove('PSU1');
  else b.wire('PSU1.negative', 'GND1.ref');
  return { b, u };
}
