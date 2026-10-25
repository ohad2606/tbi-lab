/**
 * Sprint 21 (s21r): the owner's circuit DERIVED FROM THE OWNER'S SCREENSHOTS (2D d855acf4 and the
 * 3D views ef06735f / 75cba03b / b433453a). NOT the serialized project: only what the pictures
 * show (part positions read at 2 px per layout unit, which terminal each wire ends on, every
 * wire's corners). The screenshots themselves are not in the repository.
 *
 * What the 2D screenshot shows:
 *  - PSU1 (5 V / 100 mA) at its default place, U1 = `logic.gate_and` at (-280, 0), unrotated;
 *  - no ground symbol, nothing on PSU1's - post and on the gate's output (both drawn with the
 *    "unconnected" ring);
 *  - FOUR wires from the gate to PSU1's **+** post (a, b, vcc AND gnd), with these corners:
 *    b   -320,20  -340,20  -340,-60  -80,-60  -80,-20
 *    vcc -280,-40 -80,-40  -80,-20
 *    a   -320,-20 -320,-80 -60,-80   -60,-20  -80,-20
 *    gnd -280,40  -60,40   -60,0     -80,0    -80,-20
 *  - a hop where a's vertical crosses b's horizontal (-320,-60), no branch dot at (-80,-40): the
 *    drawing of a build before Sprint 20 (s20r) round 2, i.e. fae6a3c.
 *
 * Reproduction (s21r evidence, probe at fae6a3c): that build draws exactly this picture when
 * GND1 is deleted and the wires are drawn b, a, gnd, vcc, the gate's gnd wire ENDED ON PSU1 +,
 * with a clicked waypoint on a (-60,-80) and on gnd (-80,0) (`ownerShotDrawn`), or with plain
 * clicks and then segment drags (`ownerShotDragged`). Whether the owner meant gnd -> PSU1 - is
 * unknown; `ownerShotIntent` is that corrected-intent variant (drawn as the Circuit view draws).
 */
import {
  addComponent,
  addWire,
  createProject,
  deleteSelection,
  emptySelection,
  setParam,
  type Point,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { T } from './ownerBench.js';
import { draw, normalize } from './wireScenario.js';

export const OWNER_SHOT_GATE: Point = { x: -280, y: 0 };

/** The screenshot's routes (gate end first), layout units. */
export const OWNER_SHOT_ROUTES: Readonly<Record<'a' | 'b' | 'vcc' | 'gnd', readonly Point[]>> = {
  b: [
    { x: -320, y: 20 },
    { x: -340, y: 20 },
    { x: -340, y: -60 },
    { x: -80, y: -60 },
    { x: -80, y: -20 },
  ],
  vcc: [
    { x: -280, y: -40 },
    { x: -80, y: -40 },
    { x: -80, y: -20 },
  ],
  a: [
    { x: -320, y: -20 },
    { x: -320, y: -80 },
    { x: -60, y: -80 },
    { x: -60, y: -20 },
    { x: -80, y: -20 },
  ],
  gnd: [
    { x: -280, y: 40 },
    { x: -60, y: 40 },
    { x: -60, y: 0 },
    { x: -80, y: 0 },
    { x: -80, y: -20 },
  ],
};

/** The drawing order that reproduces the screenshot at fae6a3c. */
export const OWNER_SHOT_ORDER = ['b', 'a', 'gnd', 'vcc'] as const;

/** PSU1 at 5 V / 100 mA, U1 at (-280, 0), the ground symbol deleted (as in the screenshot). */
export function ownerShotBase(): ProjectDocument {
  let doc = createProject({
    projectId: 'prj_s21ownershot',
    deviceId: 'dev_s21',
    name: 'owner screenshot AND',
    appVersion: '0',
  });
  for (const [key, value] of [
    ['setpointVoltage', { value: 5, unit: 'volt' }],
    ['currentLimit', { value: 0.1, unit: 'ampere' }],
  ] as const) {
    const p = setParam(doc, 'PSU1', key, value);
    if (!p.ok) throw new Error(p.error);
    doc = p.doc;
  }
  const g = addComponent(doc, 'logic.gate_and', OWNER_SHOT_GATE);
  if (!g.ok) throw new Error(g.error);
  if (g.id !== 'U1') throw new Error(`gate id ${g.id}`);
  const d = deleteSelection(normalize(g.doc), { ...emptySelection(), components: ['GND1'] });
  if (!d.ok) throw new Error(d.error);
  return normalize(d.doc);
}

/** Where the gate's wire `t` ends: PSU1 + for all four (as in the screenshot) unless `gndTo`. */
const target = (t: string, gndTo: 'positive' | 'negative') =>
  T('PSU1', t === 'gnd' ? gndTo : 'positive');

/**
 * The screenshot EXACTLY, in any build: the four wires as MANUAL wires whose corners are the
 * screenshot's (a manual wire's geometry is kept as stored).
 */
export function ownerShotExact(): ProjectDocument {
  let doc = ownerShotBase();
  for (const t of OWNER_SHOT_ORDER) {
    const r = OWNER_SHOT_ROUTES[t];
    const w = addWire(doc, T('U1', t), target(t, 'positive'), r.slice(1, -1) as Point[]);
    if (!w.ok) throw new Error(w.error);
    doc = normalize(w.doc);
  }
  return doc;
}

/** Sequence (i) at fae6a3c: automatic wires, with the clicked waypoints on a and gnd. */
export function ownerShotDrawn(): ProjectDocument {
  let doc = ownerShotBase();
  const clicks: Record<string, Point[]> = { a: [{ x: -60, y: -80 }], gnd: [{ x: -80, y: 0 }] };
  for (const t of OWNER_SHOT_ORDER)
    doc = draw(doc, T('U1', t), target(t, 'positive'), clicks[t] ?? []);
  return doc;
}

/**
 * Sequence (ii) at fae6a3c, as that build stored it: b and vcc automatic; a and gnd shaped by
 * segment drags, so MANUAL with the screenshot's corners.
 */
export function ownerShotDragged(): ProjectDocument {
  let doc = ownerShotBase();
  for (const t of OWNER_SHOT_ORDER) {
    if (t === 'a' || t === 'gnd') {
      const r = OWNER_SHOT_ROUTES[t];
      const w = addWire(doc, T('U1', t), target(t, 'positive'), r.slice(1, -1) as Point[]);
      if (!w.ok) throw new Error(w.error);
      doc = normalize(w.doc);
    } else doc = draw(doc, T('U1', t), target(t, 'positive'));
  }
  return doc;
}

/** Corrected intent: the gate's gnd to PSU1 -, every wire drawn plainly (no waypoints). */
export function ownerShotIntent(): ProjectDocument {
  let doc = ownerShotBase();
  for (const t of OWNER_SHOT_ORDER) doc = draw(doc, T('U1', t), target(t, 'negative'));
  return doc;
}

export const OWNER_SHOT_FIXTURES: Readonly<Record<string, () => ProjectDocument>> = {
  'shot-exact': ownerShotExact,
  'shot-drawn': ownerShotDrawn,
  'shot-dragged': ownerShotDragged,
  'shot-intent': ownerShotIntent,
};

/**
 * The expected electrical nets (sets of `component:terminal` with two or more members), written
 * from the screenshot / the intent, not from any wire geometry.
 */
export function ownerShotExpectedNets(name: string): string[][] {
  const nets =
    name === 'shot-intent'
      ? [
          ['PSU1:positive', 'U1:a', 'U1:b', 'U1:vcc'],
          ['PSU1:negative', 'U1:gnd'],
        ]
      : [['PSU1:positive', 'U1:a', 'U1:b', 'U1:gnd', 'U1:vcc']];
  return nets.map((n) => [...n].sort()).sort((x, y) => (x[0]! < y[0]! ? -1 : 1));
}
