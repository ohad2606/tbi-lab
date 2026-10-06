/**
 * 3D/domain consistency (Sprint 10 high-fidelity proof set): the BUILT models (real geometry, not
 * only the scene description) agree with the netlist.
 * - Connected: a wire ends exactly at the parts' anchors (the resistor's lead end, the LED's real
 *   leg, the ESP32 pin's jumper housing), and each anchor lies on the model's own lead geometry.
 * - Disconnected: parts whose 2D terminals touch WITHOUT a connection never touch in 3D.
 * - Direct contact: the joint sits on one anchor and its solder link ends on the other.
 * The models are built in Node: a minimal canvas stands in for the browser's (textures are
 * presentation; geometry does not depend on them), and the ESP32's glTF asset is parsed from the
 * committed file, exactly as the browser parses it.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { connectivity, moveSelection, type ProjectDocument } from '@tbi-lab/domain';
import { place, wire } from '../../packages/domain/tests/circuits.js';
import { must, newDoc } from '../../packages/domain/tests/helpers.js';
import { deriveScene, type SceneDescription } from '../src/views/scene3d/scene.js';
import { buildComponent, createMaterials, OwnedResources } from '../src/views/scene3d/models.js';

// ---- a canvas good enough for texture drawing code (draws nothing) ---------------------------
function fakeCanvas() {
  const ctx = new Proxy(
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
  );
  return { width: 0, height: 0, getContext: () => ctx, style: {} };
}

beforeAll(async () => {
  (globalThis as { document?: unknown }).document ??= {
    createElement: () => fakeCanvas(),
    createElementNS: () => fakeCanvas(),
  };
  // The committed ESP32 asset, parsed and registered as the browser does (library.ts).
  const bytes = readFileSync(
    new URL('../src/views/scene3d/assets/esp32-devkitc-v4.glb', import.meta.url),
  );
  const gltf = await new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    '',
  );
  const lib = await import('../src/views/scene3d/assets/library.js');
  lib.registerTemplateForTests('board.esp32_devkitc', gltf.scene);
});

/** Build every component of a scene; return world-space meshes per component id. */
function build(scene: SceneDescription, tier: 'full' | 'reduced' = 'full') {
  const m = createMaterials();
  const own = new OwnedResources(null, tier);
  const out = new Map<string, THREE.Object3D>();
  const root = new THREE.Group();
  for (const c of scene.components) {
    const o = buildComponent(c, m, own);
    root.add(o);
    out.set(c.id, o);
  }
  root.updateMatrixWorld(true);
  return out;
}

/** World-space vertices of the meshes under `o` that satisfy `pick`. */
function vertices(o: THREE.Object3D, pick: (m: THREE.Mesh) => boolean = () => true) {
  const pts: THREE.Vector3[] = [];
  o.traverse((x) => {
    const mesh = x as THREE.Mesh;
    if (!mesh.isMesh || !pick(mesh)) return;
    const pos = mesh.geometry.attributes.position!;
    for (let i = 0; i < pos.count; i++)
      pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
  });
  return pts;
}
const nearest = (pts: THREE.Vector3[], p: { x: number; y: number; z: number }) =>
  Math.min(...pts.map((v) => v.distanceTo(new THREE.Vector3(p.x, p.y, p.z))));
/** Whether p lies inside the world bounding box of the meshes picked (grown by `pad`). */
function inside(
  o: THREE.Object3D,
  p: { x: number; y: number; z: number },
  pick: (m: THREE.Mesh) => boolean,
  pad = 0,
) {
  const box = new THREE.Box3();
  o.traverse((x) => {
    const mesh = x as THREE.Mesh;
    if (mesh.isMesh && pick(mesh)) box.expandByObject(mesh);
  });
  return box.expandByScalar(pad).containsPoint(new THREE.Vector3(p.x, p.y, p.z));
}
const term = (s: SceneDescription, c: string, t: string) =>
  s.components.find((x) => x.id === c)!.terminals.find((x) => x.id === t)!;
const isLead = (m: THREE.Mesh) => m.userData.lead === true;
const isLeg = (which: string) => (m: THREE.Mesh) => m.userData.leg === which;

describe('3D models agree with the netlist (anchors)', () => {
  it('connected resistor -> LED: the wire ends on the resistor lead and on the LED anode leg', () => {
    let doc: ProjectDocument = place(newDoc(), 'component.resistor', 100, 200).doc; // R1
    doc = place(doc, 'component.led', 300, 200).doc; // D1
    doc = wire(doc, ['R1', 'b'], ['D1', 'anode']);
    const s = deriveScene(doc);
    const w = s.wires[0]!;
    const rb = term(s, 'R1', 'b');
    const la = term(s, 'D1', 'anode');
    expect(w.points[0]).toEqual({ x: rb.x, y: rb.y, z: rb.z });
    expect(w.points.at(-1)).toEqual({ x: la.x, y: la.y, z: la.z });
    const parts = build(s);
    // The resistor's anchor is on its formed lead: within the lead radius of its surface.
    expect(nearest(vertices(parts.get('R1')!, isLead), rb)).toBeLessThanOrEqual(0.3);
    // The LED's anchor is inside its anode leg (the real leg, 1.27 mm from the body axis).
    expect(inside(parts.get('D1')!, la, isLeg('anode'), 1e-6)).toBe(true);
    expect(inside(parts.get('D1')!, la, isLeg('cathode'), 1e-6)).toBe(false);
    expect(connectivity(doc).nodeOf.get('R1:b')).toBe(connectivity(doc).nodeOf.get('D1:anode'));
  });

  it('disconnected but touching in 2D: the resistor and the LED do not touch in 3D', () => {
    let doc: ProjectDocument = place(newDoc(), 'component.resistor', 100, 200).doc;
    doc = place(doc, 'component.led', 180, 200).doc; // D1.anode on R1.b: a contact...
    // ...moved off and back by a document that does not connect them (made elsewhere).
    const apart = must(
      moveSelection(doc, { components: ['D1'], wires: [], junctions: [] }, { x: 60, y: 0 }),
    ).doc;
    apart.layout.components.D1!.x = 180;
    const g = connectivity(apart);
    expect(g.nodeOf.get('R1:b') ?? null).not.toBe(g.nodeOf.get('D1:anode') ?? 'x');
    const s = deriveScene(apart);
    expect(s.joints.map((j) => j.kind)).toEqual(['open']);
    const parts = build(s);
    const r = vertices(parts.get('R1')!);
    const d = vertices(parts.get('D1')!);
    let min = Infinity;
    for (const a of d) for (const b of r) min = Math.min(min, a.distanceTo(b));
    expect(min).toBeGreaterThan(0.5); // a visible gap, never touching geometry
  });

  it('direct contact: the joint is on the LED leg and its solder link ends on the resistor lead', () => {
    let doc: ProjectDocument = place(newDoc(), 'component.resistor', 100, 200).doc;
    doc = place(doc, 'component.led', 180, 200).doc; // D1.anode on R1.b: connected
    const s = deriveScene(doc);
    const j = s.joints[0]!;
    expect(j.kind).toBe('contact');
    const parts = build(s);
    expect(inside(parts.get('D1')!, j, isLeg('anode'), 1e-6)).toBe(true);
    expect(j.links).toHaveLength(1);
    expect(nearest(vertices(parts.get('R1')!, isLead), j.links![0]!)).toBeLessThanOrEqual(0.3);
  });

  it('ESP32 pin wiring: the wire ends on the wired pin housing of the glTF board; others get none', () => {
    let doc: ProjectDocument = place(newDoc(), 'board.esp32_devkitc_wroom32', 300, 0).doc; // U1
    doc = place(doc, 'component.resistor', 600, 100).doc; // R1
    doc = wire(doc, ['U1', 'gpio2'], ['R1', 'a']);
    const s = deriveScene(doc);
    const p = term(s, 'U1', 'gpio2');
    const w = s.wires[0]!;
    expect(w.points[0]).toEqual({ x: p.x, y: p.y, z: p.z });
    const board = build(s).get('U1')!;
    expect(board.userData.asset).toBe('esp32-devkitc-v4.glb'); // the high-fidelity asset
    const housings: THREE.Mesh[] = [];
    board.traverse((o) => o.userData.jumper && housings.push(o as THREE.Mesh));
    expect(housings.map((h) => h.userData.jumper)).toEqual(['gpio2']);
    // The anchor is the housing's top centre (its body: the latch window's detail stands proud of
    // one face), and the pin is under it.
    const body = housings[0]!.children.find((o) => o.userData.dupontBody)!;
    const box = new THREE.Box3().setFromObject(body);
    expect(box.max.y).toBeCloseTo(p.y, 6);
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(p.x, 6);
    expect((box.min.z + box.max.z) / 2).toBeCloseTo(p.z, 6);
    // The header pin under it runs up through the housing's base (its own column of vertices).
    const pins = board.getObjectByName('header_pins')!;
    const column = vertices(pins).filter(
      (v) => Math.abs(v.x - p.x) < 0.4 && Math.abs(v.z - p.z) < 0.4,
    );
    expect(column.length).toBeGreaterThan(0);
    expect(Math.min(...column.map((v) => v.y))).toBeLessThan(box.min.y);
    expect(Math.max(...column.map((v) => v.y))).toBeGreaterThan(box.min.y);
  });

  it('both quality tiers build the same geometry: tiers change materials, never parts or anchors', () => {
    let doc: ProjectDocument = place(newDoc(), 'board.esp32_devkitc_wroom32', 300, 0).doc;
    doc = place(doc, 'component.resistor', 600, 100).doc;
    doc = place(doc, 'component.led', 700, 100).doc;
    doc = place(doc, 'component.diode', 600, 200).doc;
    doc = place(doc, 'component.push_button', 400, 300).doc;
    doc = place(doc, 'component.toggle_switch', 600, 300).doc;
    doc = wire(doc, ['U1', 'gpio2'], ['R1', 'a']);
    const s = deriveScene(doc);
    const full = build(s, 'full');
    const reduced = build(s, 'reduced');
    for (const c of s.components) {
      const a = vertices(full.get(c.id)!);
      const b = vertices(reduced.get(c.id)!);
      expect(b.length, c.id).toBe(a.length);
      expect(
        b.every((v, i) => v.distanceTo(a[i]!) < 1e-9),
        c.id,
      ).toBe(true);
    }
  });
});
