/**
 * Fresh 3D wire routes (Sprint 10 owner review: the PIR alarm and the relay -> LED wiring): wires
 * re-routed from the final 3D terminals, leaving module pins through clean exit lanes with a
 * fan-out, resting near the bench and rising only over what is actually in the way, with smooth
 * bends; deterministic; the project untouched.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addWire, createPackage, serializePackage, type ProjectDocument } from '@tbi-lab/domain';
import { place, wire } from '../../packages/domain/tests/circuits.js';
import { must, newDoc } from '../../packages/domain/tests/helpers.js';
import {
  collisionBodies,
  deriveScene,
  deriveSceneVariant,
  touchingNodes,
  WIRE_RADIUS,
  type SceneDescription,
  type SceneWire,
} from '../src/views/scene3d/scene.js';
import { bodiesCollide } from '../src/views/scene3d/separation.js';
import { expectNoWireThroughBodies, samples } from './support/scene3dChecks.js';
import { CLEARANCE, FLOOR, routeWires, type Obstacle } from '../src/views/scene3d/route3d.js';
import { RELAY_SRD } from '../src/views/scene3d/physical.js';
import { EXAMPLE_DOCUMENTS } from '../src/examples/documents.js';
import { denseBench, partsBench } from '../../scripts/evidence/benches.js';
import {
  denseMixedCircuit,
  esp32ModuleCircuit,
  pirMatrixCircuit,
  relayLedCircuit,
  transistorPsuCircuit,
} from './separationFixtures.js';
import * as THREE from 'three';
import { buildComponent, createMaterials, OwnedResources } from '../src/views/scene3d/models.js';

const example = (id: string) =>
  JSON.parse(
    readFileSync(new URL(`../src/examples/data/${id}.json`, import.meta.url), 'utf8'),
  ) as ProjectDocument;

const ofWire = (doc: ProjectDocument, s: SceneDescription, from: string, to: string) => {
  const w = doc.layout.wires.find(
    (x) =>
      x.from.kind === 'terminal' &&
      x.to.kind === 'terminal' &&
      `${x.from.component}:${x.from.terminal}` === from &&
      `${x.to.component}:${x.to.terminal}` === to,
  )!;
  return s.wires.find((x) => x.id === w.id)!;
};
const maxY = (w: SceneWire) => Math.max(...w.points.map((p) => p.y));
/** Longest vertical stretch (plan movement under 0.05 mm) of a wire's polyline. */
const longestRiser = (w: SceneWire) =>
  Math.max(
    0,
    ...w.points.slice(1).map((b, i) => {
      const a = w.points[i]!;
      return Math.hypot(b.x - a.x, b.z - a.z) < 0.05 ? Math.abs(b.y - a.y) : 0;
    }),
  );

/** No back-and-forth in plan: consecutive plan runs never reverse. */
function expectNoZigZag(s: SceneDescription, label: string) {
  for (const w of s.wires) {
    const plan = w.points
      .map((p) => ({ x: p.x, z: p.z }))
      .filter(
        (p, i, all) => i === 0 || Math.hypot(p.x - all[i - 1]!.x, p.z - all[i - 1]!.z) > 0.05,
      );
    for (let i = 2; i < plan.length; i++) {
      const u = { x: plan[i - 1]!.x - plan[i - 2]!.x, z: plan[i - 1]!.z - plan[i - 2]!.z };
      const v = { x: plan[i]!.x - plan[i - 1]!.x, z: plan[i]!.z - plan[i - 1]!.z };
      const cos = (u.x * v.x + u.z * v.z) / (Math.hypot(u.x, u.z) * Math.hypot(v.x, v.z));
      expect(cos, `${label}: ${w.id} reverses at ${i}`).toBeGreaterThan(-0.99);
    }
  }
}

describe('3D wire routes: the owner-reviewed PIR alarm', () => {
  const doc = example('pir-alarm');
  const s = deriveScene(doc);
  const pirWires = s.wires.filter((w) => {
    const src = doc.layout.wires.find((x) => x.id === w.id)!;
    return [src.from, src.to].some((e) => e.kind === 'terminal' && e.component === 'U1');
  });

  it('the PIR body overlaps nothing; its three wires leave three separate pins cleanly', () => {
    const bodies = collisionBodies(doc).map((b) => {
      const c = s.components.find((x) => x.id === b.id)!;
      return { ...b, x: c.x, z: c.z };
    });
    const pir = bodies.find((b) => b.id === 'U1')!;
    for (const b of bodies) if (b !== pir) expect(bodiesCollide(pir, b), b.id).toBe(false);
    expect(pirWires).toHaveLength(3);
    const u1 = s.components.find((c) => c.id === 'U1')!;
    const pinOf = (w: SceneWire) =>
      u1.terminals.find((t) =>
        [w.points[0]!, w.points.at(-1)!].some((e) => e.x === t.x && e.y === t.y && e.z === t.z),
      )!;
    expect(new Set(pirWires.map((w) => pinOf(w).id))).toEqual(new Set(['gnd', 'out', 'vcc']));
    for (const w of pirWires) {
      const t = pinOf(w);
      const pts =
        w.points[0]!.x === t.x && w.points[0]!.z === t.z ? w.points : [...w.points].reverse();
      // Straight out at pin level first (an exit lane), not a turn or a climb at the pin: the
      // first 2 mm stay at pin level and run straight away from the pin.
      const along = samples({ ...w, points: pts });
      const dir = { x: pts[1]!.x - t.x, z: pts[1]!.z - t.z };
      for (const p of along) {
        const d = Math.hypot(p.x - t.x, p.z - t.z);
        if (d > 2) break;
        expect(Math.abs(p.y - t.y)).toBeLessThan(0.5);
        // On the line of the lane.
        expect(
          Math.abs((p.x - t.x) * dir.z - (p.z - t.z) * dir.x) / Math.hypot(dir.x, dir.z),
        ).toBeLessThan(0.05);
      }
      expect(Math.hypot(pts.at(-1)!.x - t.x, pts.at(-1)!.z - t.z)).toBeGreaterThan(2);
    }
  });

  it('no vertical bundle: the PIR wires stay low by the module and rise nowhere steeply', () => {
    for (const w of pirWires) {
      expect(longestRiser(w), w.id).toBeLessThan(1);
      // Near the module (first/last 12 mm) every point lies near the bench.
      const pts = samples(w);
      let run = 0;
      for (let i = 1; i < pts.length && run < 12; i++) {
        run += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z);
        expect(pts[i]!.y, w.id).toBeLessThan(FLOOR + 0.5);
      }
    }
  });

  it('no wire passes through the PIR board or dome, or any other part', () => {
    expectNoWireThroughBodies(doc, s, 'pir-alarm');
    expectNoZigZag(s, 'pir-alarm');
    expect(touchingNodes(s)).toEqual([]);
  });

  it('deterministic, connectivity untouched, the project byte-identical after viewing in 3D', () => {
    const text = serializePackage(
      createPackage(doc, { appVersion: 't', exportedAt: '2026-10-07T00:00:00Z' }),
    );
    expect(deriveScene(doc)).toEqual(s);
    expect(deriveScene(example('pir-alarm'))).toEqual(s);
    expect(
      serializePackage(createPackage(doc, { appVersion: 't', exportedAt: '2026-10-07T00:00:00Z' })),
    ).toBe(text);
    // Each wire still ends on exactly its own terminals.
    for (const src of doc.layout.wires) {
      const w = s.wires.find((x) => x.id === src.id)!;
      for (const [e, p] of [
        [src.from, w.points[0]!],
        [src.to, w.points.at(-1)!],
      ] as const) {
        if (e.kind !== 'terminal') continue;
        const t = s.components
          .find((c) => c.id === e.component)!
          .terminals.find((x) => x.id === e.terminal)!;
        expect(p).toEqual({ x: t.x, y: t.y, z: t.z });
      }
    }
  });
});

describe('3D wire routes: no false hop (the owner-reviewed transistor / supply case)', () => {
  it('the base wire stays low beside the transistor: clear of its real body and leads', () => {
    (globalThis as { document?: unknown }).document ??= {
      createElement: () => ({
        width: 0,
        height: 0,
        style: {},
        getContext: () =>
          new Proxy(
            {},
            {
              get: (_t, k) =>
                k === 'createLinearGradient' || k === 'createRadialGradient'
                  ? () => ({ addColorStop() {} })
                  : k === 'measureText'
                    ? () => ({ width: 10 })
                    : () => undefined,
              set: () => true,
            },
          ),
      }),
    };
    const doc = transistorPsuCircuit();
    const before = serializePackage(
      createPackage(doc, { appVersion: 't', exportedAt: '2026-10-07T00:00:00Z' }),
    );
    const s = deriveScene(doc);
    const w = ofWire(doc, s, 'R3:b', 'Q1:base');
    // Low all the way: no raised bridge.
    expect(maxY(w)).toBeLessThan(1.2);
    expect(longestRiser(w)).toBeLessThan(1);
    // Physically clear, checked against the built transistor (not the routing boxes): the
    // wire's axis is a wire radius away from the body's box and from every vertex of the leads
    // it is not connected to.
    const q1 = s.components.find((c) => c.id === 'Q1')!;
    const model = buildComponent(q1, createMaterials(), new OwnedResources(null, 'reduced'));
    model.updateMatrixWorld(true);
    const leads: THREE.Vector3[] = [];
    let body: THREE.Box3 | null = null;
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (m.userData.lead) {
        const pos = m.geometry.attributes.position!;
        for (let i = 0; i < pos.count; i++)
          leads.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
      } else if (!body && m.geometry.type === 'ExtrudeGeometry')
        body = new THREE.Box3().setFromObject(m);
    });
    expect(body).not.toBeNull();
    const base = q1.terminals.find((t) => t.id === 'base')!;
    for (const p of samples(w)) {
      const v = new THREE.Vector3(p.x, p.y, p.z);
      if (v.distanceTo(new THREE.Vector3(base.x, base.y, base.z)) < 4) continue; // its own lead
      expect(body!.distanceToPoint(v)).toBeGreaterThanOrEqual(WIRE_RADIUS);
      for (const l of leads)
        if (Math.hypot(l.x - base.x, l.z - base.z) > 1.5)
          expect(l.distanceTo(v)).toBeGreaterThanOrEqual(WIRE_RADIUS);
    }
    expectNoWireThroughBodies(doc, s, 'transistor+psu');
    expect(touchingNodes(s)).toEqual([]);
    expect(deriveScene(transistorPsuCircuit())).toEqual(s); // deterministic
    expect(
      serializePackage(createPackage(doc, { appVersion: 't', exportedAt: '2026-10-07T00:00:00Z' })),
    ).toBe(before);
  });

  it('a wire really crossing the transistor still rises over it', () => {
    let doc = place(newDoc(), 'component.bjt_npn', 300, 0).doc; // Q1
    doc = place(doc, 'component.resistor', 160, 0).doc; // R1
    doc = place(doc, 'component.resistor', 440, 0).doc; // R2
    doc = wire(doc, ['R1', 'b'], ['R2', 'a']); // straight across the transistor's body
    const s = deriveScene(doc);
    const w = ofWire(doc, s, 'R1:b', 'R2:a');
    expect(maxY(w)).toBeGreaterThan(4.8 + 3 + CLEARANCE - 1e-6);
    expectNoWireThroughBodies(doc, s, 'across transistor');
  });
});

describe('3D wire routes: local connections stay low (the relay -> LED case)', () => {
  it('relay-load: K1.NO -> R1 (next to the LED) is short, low and direct', () => {
    const doc = example('relay-load');
    const s = deriveScene(doc);
    const w = ofWire(doc, s, 'K1:no', 'R1:a');
    expect(maxY(w)).toBeLessThan(1.5);
    expect(longestRiser(w)).toBeLessThan(1);
    const [a, b] = [w.points[0]!, w.points.at(-1)!];
    let length = 0;
    for (let i = 1; i < w.points.length; i++)
      length += Math.hypot(
        w.points[i]!.x - w.points[i - 1]!.x,
        w.points[i]!.z - w.points[i - 1]!.z,
      );
    expect(length).toBeLessThan(Math.abs(a.x - b.x) + Math.abs(a.z - b.z) + 6);
    expectNoWireThroughBodies(doc, s, 'relay-load');
    expectNoZigZag(s, 'relay-load');
    expect(touchingNodes(s)).toEqual([]);
  });

  it('a relay wired straight to a nearby LED: no climb up the relay', () => {
    const doc = relayLedCircuit();
    const s = deriveScene(doc);
    const w = ofWire(doc, s, 'K1:no', 'D1:anode');
    expect(maxY(w)).toBeLessThan(1.5);
    expect(longestRiser(w)).toBeLessThan(1);
    expectNoWireThroughBodies(doc, s, 'relay+led');
    expectNoZigZag(s, 'relay+led');
    expect(touchingNodes(s)).toEqual([]);
    // Every wire of this small bench stays low: nothing here needs to climb over the relay.
    for (const x of s.wires) expect(maxY(x), x.id).toBeLessThan(6);
  });

  it('a genuinely obstructed route still rises over the obstacle, and only there', () => {
    // R1 -> R2 straight across a relay that is not connected to them.
    let doc = place(newDoc(), 'component.resistor', 160, 0).doc; // R1
    doc = place(doc, 'component.relay', 300, 0).doc; // K1
    doc = place(doc, 'component.resistor', 460, 0).doc; // R2
    doc = wire(doc, ['R1', 'b'], ['R2', 'a']);
    const s = deriveScene(doc);
    const w = ofWire(doc, s, 'R1:b', 'R2:a');
    const relayTop = RELAY_SRD.standoffMm + RELAY_SRD.heightMm;
    expect(maxY(w)).toBeGreaterThanOrEqual(relayTop + CLEARANCE - 1e-6);
    // Low at both ends, a smooth arch (no vertical riser), and not over the relay's top for
    // longer than the relay is long plus its ramps.
    expect(w.points[0]!.y).toBeLessThan(1);
    expect(w.points.at(-1)!.y).toBeLessThan(1);
    expect(longestRiser(w)).toBeLessThan(1);
    expectNoWireThroughBodies(doc, s, 'across relay');
  });
});

describe('3D wire routes: modules, fan-out, separation', () => {
  it('PIR next to the ESP32: clean lanes from the PIR, through no body', () => {
    const doc = esp32ModuleCircuit();
    const s = deriveScene(doc);
    expectNoWireThroughBodies(doc, s, 'esp32+pir');
    expectNoZigZag(s, 'esp32+pir');
    expect(touchingNodes(s)).toEqual([]);
    for (const w of s.wires) expect(longestRiser(w), w.id).toBeLessThan(3.5);
  });

  it('two neighbouring modules (the PIR moved by the separation, the matrix not)', () => {
    const doc = pirMatrixCircuit();
    const s = deriveScene(doc);
    expect(s.separation.moved.map((m) => m.id)).toEqual(['U1']);
    expectNoWireThroughBodies(doc, s, 'pir+matrix');
    expectNoZigZag(s, 'pir+matrix');
    expect(touchingNodes(s)).toEqual([]);
    // The moved PIR's wires start at its moved pins and leave through lanes at pin level.
    const u1 = s.components.find((c) => c.id === 'U1')!;
    for (const w of s.wires) {
      const t = u1.terminals.find((x) => x.x === w.points[0]!.x && x.z === w.points[0]!.z);
      if (!t) continue;
      expect(Math.abs(w.points[1]!.y - t.y)).toBeLessThan(0.5);
    }
  });

  it('dense module wiring and every curated example: through no body, no zig-zag, nothing touching', () => {
    const doc = denseMixedCircuit();
    const s = deriveScene(doc);
    expectNoWireThroughBodies(doc, s, 'dense mixed');
    expectNoZigZag(s, 'dense mixed');
    expect(touchingNodes(s)).toEqual([]);
    for (const [id, d] of Object.entries(EXAMPLE_DOCUMENTS)) {
      const e = deriveScene(d);
      expectNoWireThroughBodies(d, e, id);
      expectNoZigZag(e, id);
      expect(touchingNodes(e), id).toEqual([]);
      // Bends are smooth: no corner tighter than 2.5 mm where the router chose it.
      for (const w of e.wires) for (const r of w.radii ?? []) expect(r).toBeGreaterThanOrEqual(2.5);
    }
  });

  it('fan-out: wires leaving one side of a module turn at different distances (no shared lane)', () => {
    // Four neighbouring matrix pins on the front edge, all wired to parts on one side.
    let doc = place(newDoc(), 'display.led_matrix_8x8', 300, 0).doc; // DS1
    for (const [i, y] of [180, 220, 260, 300].entries()) {
      doc = place(doc, 'component.resistor', 100, y).doc; // R1..R4
      void i;
    }
    const front = ['r5', 'r7', 'c2', 'c3']; // matrix pins 1..4 (front edge, left to right)
    front.forEach((pin, i) => {
      doc = must(
        addWire(
          doc,
          { kind: 'terminal', component: 'DS1', terminal: pin },
          { kind: 'terminal', component: `R${i + 1}`, terminal: 'b' },
        ),
      ).doc;
    });
    const s = deriveScene(doc);
    expect(touchingNodes(s)).toEqual([]);
    expectNoWireThroughBodies(doc, s, 'fan-out');
    // Where each lane turns (its first plan corner): all at different distances from the edge.
    const turns = s.wires
      .filter((w) => doc.layout.wires.find((x) => x.id === w.id)!.from.kind === 'terminal')
      .map((w) => w.points[1]!.z);
    expect(new Set(turns.map((z) => z.toFixed(2))).size).toBe(turns.length);
  });

  it('the fresh routes are what every example and fixture shows (no fallback to the old router)', () => {
    const docs: [string, ProjectDocument][] = [
      ...Object.entries(EXAMPLE_DOCUMENTS),
      ['parts bench', partsBench()],
      ['dense bench', denseBench()],
      ['pir+matrix', pirMatrixCircuit()],
      ['esp32+pir', esp32ModuleCircuit()],
      ['dense mixed', denseMixedCircuit()],
    ];
    for (const [id, d] of docs) {
      const s = deriveScene(d);
      expect(s, id).toEqual(deriveSceneVariant(d, true, 'fresh'));
      expect(touchingNodes(s), id).toEqual([]);
    }
  });

  it('determinism across the fixtures', () => {
    for (const make of [pirMatrixCircuit, esp32ModuleCircuit, denseMixedCircuit])
      expect(deriveScene(make())).toEqual(deriveScene(make()));
  });
});

describe('3D wire heights: a raised body is decided on the final profile (rt2, PSU post)', () => {
  // A binding post sticking out at post height (bottom 3.1, top 5.3 mm), a wire running along the
  // bench right beside its tip. On the bench the wire passes UNDER the post; a terminal it passes
  // near lifts it to that terminal's clearance height, i.e. into the post's height band.
  const post: Obstacle = {
    part: 'P:other',
    x0: -2,
    x1: 0,
    z0: -1.1,
    z1: 1.1,
    bottom: 3.1,
    top: 5.3,
  };
  const input = {
    id: 'W',
    node: 'n1',
    plan: [
      { x: 0.45, y: -20 },
      { x: 0.45, y: 20 },
    ],
    head: [],
    tail: [],
    startY: FLOOR,
    endY: FLOOR,
    parts: [null, null] as [null, null],
    ownEnds: [
      { x: 0.45, y: -20 },
      { x: 0.45, y: 20 },
    ],
  };
  const axisClear = (pts: { x: number; y: number; z: number }[], o: Obstacle) => {
    let m = Infinity;
    for (let i = 1; i < pts.length; i++)
      for (let k = 0; k <= 40; k++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        const p = {
          x: a.x + ((b.x - a.x) * k) / 40,
          y: a.y + ((b.y - a.y) * k) / 40,
          z: a.z + ((b.z - a.z) * k) / 40,
        };
        const dx = Math.max(o.x0 - p.x, 0, p.x - o.x1);
        const dz = Math.max(o.z0 - p.z, 0, p.z - o.z1);
        const dy = Math.max(o.bottom - p.y, 0, p.y - o.top);
        m = Math.min(m, Math.hypot(dx, dy, dz));
      }
    return m;
  };
  it('alone, the wire stays on the bench and passes under the post (no needless rise)', () => {
    const r = routeWires([input], [post], []).get('W')!;
    expect(Math.max(...r.points.map((p) => p.y))).toBeCloseTo(FLOOR, 6);
    expect(axisClear(r.points, post)).toBeGreaterThanOrEqual(WIRE_RADIUS + 0.3 - 1e-9);
  });
  it('lifted by a terminal beside the post, it goes OVER the post with clearance, never into it', () => {
    const r = routeWires([input], [post], [{ x: 0.45, z: 0, h: 4.2 }]).get('W')!;
    expect(axisClear(r.points, post)).toBeGreaterThanOrEqual(WIRE_RADIUS + 0.3 - 1e-9);
    expect(Math.max(...r.points.map((p) => p.y))).toBeGreaterThanOrEqual(
      post.top + CLEARANCE - 1e-6,
    );
  });
});
