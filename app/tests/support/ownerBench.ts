/**
 * Sprint 20 owner report (s20r): a PSU set to 5 V / 100 mA, ONE single AND gate U1 and several
 * wires between the gate and the supply showed, in 3D, crossings, loops and entangled wires.
 *
 * The owner's screenshots were not available to the routing work; these fixtures are built from
 * the verbal description, so they are EQUIVALENT circuits, not an exact reproduction:
 *  - U1 = `logic.gate_and` (TI SN74LVC1G08, V_CC 1.65-5.5 V: runs at the PSU's 5 V);
 *  - its V_CC and GND to the PSU's + and - posts, both inputs tied to the PSU's + rail (or input A
 *    through a toggle switch with a pull-down), its output through a resistor to an LED back to
 *    the PSU's - post; the PSU's - post to the ground symbol, as the app draws a new project;
 *  - the gate placed right of, left of, above and below the supply, rotated, and dragged away and
 *    back.
 * Every wire is drawn as the Circuit view draws a click-to-click wire (automatic, routed by the
 * product router at the moment it is drawn, then canonically after every edit).
 */
import {
  addComponent,
  createProject,
  emptySelection,
  setParam,
  type Point,
  type ProjectDocument,
  type Rotation,
  type WireTarget,
} from '@tbi-lab/domain';
import { rotateComponents } from '@tbi-lab/domain';
import { draw, normalize } from './wireScenario.js';
import { moveRouted } from '../../src/ui/routing.js';

export const T = (component: string, terminal: string): WireTarget => ({
  kind: 'terminal',
  component,
  terminal,
});

export type OwnerSide = 'right' | 'left' | 'above' | 'below' | 'near';
export interface OwnerOptions {
  side?: OwnerSide;
  /** Gate rotation (layout degrees, clockwise). */
  rotation?: Rotation;
  /** Input A through a toggle switch (with a pull-down to the - rail) instead of tied high. */
  switched?: boolean;
  /** Output to an LED through a resistor (default true). */
  led?: boolean;
}

/** Where U1 goes for each side (layout units; the PSU sits at (-120, 0), the ground at (-80, 120)). */
export const OWNER_POSITIONS: Record<OwnerSide, Point> = {
  right: { x: 160, y: 0 },
  left: { x: -400, y: 0 },
  above: { x: -100, y: -260 },
  below: { x: -100, y: 320 },
  /** Right beside the supply's posts (one grid step of free bench between the symbols). */
  near: { x: 60, y: 0 },
};

export interface OwnerBench {
  doc: ProjectDocument;
  gate: string;
  /** The parts the expected nets are written with. */
  parts: { resistor?: string; led?: string; toggle?: string; pulldown?: string };
}

/** The owner-equivalent bench (see the module comment). */
export function ownerBench(options: OwnerOptions = {}): OwnerBench {
  const side = options.side ?? 'right';
  let doc = createProject({
    projectId: `prj_s20owner${side}`,
    deviceId: 'dev_s20',
    name: 'owner 5V AND',
    appVersion: '0',
  });
  const add = (type: Parameters<typeof addComponent>[1], at: Point) => {
    const r = addComponent(doc, type, at);
    if (!r.ok) throw new Error(`${type} at ${JSON.stringify(at)}: ${r.error}`);
    doc = normalize(r.doc);
    return r.id;
  };
  // The supply at the owner's settings (they are also the part's defaults).
  for (const [key, value] of [
    ['setpointVoltage', { value: 5, unit: 'volt' }],
    ['currentLimit', { value: 0.1, unit: 'ampere' }],
  ] as const) {
    const p = setParam(doc, 'PSU1', key, value);
    if (!p.ok) throw new Error(p.error);
    doc = p.doc;
  }
  const at = OWNER_POSITIONS[side];
  const gate = add('logic.gate_and', at);
  if (options.rotation) {
    let r = options.rotation;
    while (r > 0) {
      const x = rotateComponents(doc, [gate]);
      if (!x.ok) throw new Error(x.error);
      doc = normalize(x.doc);
      r -= 90;
    }
  }
  const parts: OwnerBench['parts'] = {};
  // The output stage beside the gate, away from the supply.
  const away = side === 'left' ? -1 : 1;
  if (options.led !== false) {
    const base =
      side === 'above' || side === 'below'
        ? { x: at.x + 200, y: at.y }
        : { x: at.x + away * 200, y: at.y + 120 };
    parts.resistor = add('component.resistor', base);
    parts.led = add('component.led', { x: base.x + away * 160, y: base.y });
  }
  if (options.switched) {
    parts.toggle = add('component.toggle_switch', { x: at.x - away * 80, y: at.y - 160 });
    parts.pulldown = add('component.resistor', { x: at.x - away * 80, y: at.y - 240 });
  }
  // Wires in the order a person wires it: ground reference, the gate's supply, its inputs, the
  // output stage.
  doc = draw(doc, T('PSU1', 'negative'), T('GND1', 'ref'));
  doc = draw(doc, T('PSU1', 'positive'), T(gate, 'vcc'));
  doc = draw(doc, T(gate, 'gnd'), T('PSU1', 'negative'));
  if (options.switched) {
    doc = draw(doc, T('PSU1', 'positive'), T(parts.toggle!, 'a'));
    doc = draw(doc, T(parts.toggle!, 'b'), T(gate, 'a'));
    doc = draw(doc, T(parts.pulldown!, 'a'), T(gate, 'a'));
    doc = draw(doc, T(parts.pulldown!, 'b'), T('PSU1', 'negative'));
  } else doc = draw(doc, T(gate, 'a'), T('PSU1', 'positive'));
  doc = draw(doc, T(gate, 'b'), T('PSU1', 'positive'));
  if (parts.resistor && parts.led) {
    doc = draw(doc, T(gate, 'y'), T(parts.resistor, 'a'));
    doc = draw(doc, T(parts.resistor, 'b'), T(parts.led, 'anode'));
    doc = draw(doc, T(parts.led, 'cathode'), T('PSU1', 'negative'));
  }
  return { doc, gate, parts };
}

/**
 * The expected electrical nets of an owner bench, as sets of `component:terminal`, written from
 * the circuit description (independently of the wires' geometry).
 */
export function expectedNets(b: OwnerBench, options: OwnerOptions = {}): string[][] {
  const g = b.gate;
  const { resistor: r, led: d, toggle: s, pulldown: p } = b.parts;
  const plus = ['PSU1:positive', `${g}:vcc`, `${g}:b`];
  const minus = ['PSU1:negative', 'GND1:ref', `${g}:gnd`];
  const nets: string[][] = [];
  if (options.switched) {
    plus.push(`${s}:a`);
    minus.push(`${p}:b`);
    nets.push([`${s}:b`, `${g}:a`, `${p}:a`]);
  } else plus.push(`${g}:a`);
  if (r && d) {
    minus.push(`${d}:cathode`);
    nets.push([`${g}:y`, `${r}:a`], [`${r}:b`, `${d}:anode`]);
  }
  nets.push(plus, minus);
  return nets.map((n) => [...n].sort()).sort((x, y) => (x[0]! < y[0]! ? -1 : 1));
}

/** Drag a part away and back by the same total (each step as the Circuit view commits it). */
export function awayAndBack(doc: ProjectDocument, id: string, steps: Point[]): ProjectDocument {
  let out = doc;
  const total = { x: 0, y: 0 };
  for (const s of [...steps, null]) {
    const d = s ?? { x: -total.x, y: -total.y };
    const r = moveRouted(out, { ...emptySelection(), components: [id] }, d);
    if (!r.ok) throw new Error(`move ${JSON.stringify(d)}: ${r.error}`);
    out = normalize(r.doc);
    if (s) {
      total.x += s.x;
      total.y += s.y;
    }
  }
  return out;
}

/** Every owner-bench variant the regression tests and the evidence cover. */
export function ownerVariants(): { name: string; options: OwnerOptions }[] {
  const out: { name: string; options: OwnerOptions }[] = [];
  for (const side of ['right', 'left', 'above', 'below', 'near'] as const)
    out.push({ name: `${side}`, options: { side } });
  for (const rotation of [90, 180, 270] as const)
    out.push({ name: `right-rot${rotation}`, options: { side: 'right', rotation } });
  out.push({ name: 'right-switched', options: { side: 'right', switched: true } });
  out.push({ name: 'left-switched', options: { side: 'left', switched: true } });
  out.push({ name: 'right-bare', options: { side: 'right', led: false } });
  return out;
}
