/**
 * Sprint 9: the 3D scene description — a deterministic function of the project document. No
 * WebGL here (the renderer is exercised in the browser suite).
 */
import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  GROUND_NODE,
  connectivity,
  deleteSelection,
  moveSelection,
  rotateComponents,
  setParam,
  terminalPosition,
} from '@tbi-lab/domain';
import { mixedCircuit, place, wire } from '../../packages/domain/tests/circuits.js';
import { must } from '../../packages/domain/tests/helpers.js';
import { EXAMPLES } from '../src/examples/catalog.js';
import { MODEL_FOR, SCALE, deriveScene, resistorBands } from '../src/views/scene3d/scene.js';

describe('3D scene description', () => {
  it('has one part per component, at its 2D layout position, with the right model', () => {
    const { doc } = mixedCircuit();
    const scene = deriveScene(doc);
    expect(scene.components.map((c) => c.id)).toEqual(doc.components.map((c) => c.id));
    for (const c of scene.components) {
      const p = doc.layout.components[c.id]!;
      expect([c.x, c.z]).toEqual([p.x * SCALE, p.y * SCALE]);
      expect(c.model).toBe(MODEL_FOR[c.type]);
      // Terminals sit exactly where the circuit view has them (plan view).
      for (const t of c.terminals) {
        const at = terminalPosition(doc, c.id, t.id)!;
        expect([t.x, t.z]).toEqual([at.x * SCALE, at.y * SCALE]);
      }
    }
    // Every catalog type has a dedicated model (none falls back to the generic box).
    for (const type of Object.keys(CATALOG))
      expect(MODEL_FOR[type as keyof typeof CATALOG]).toBeDefined();
  });

  it('wires follow the 2D routes, lifted above the plane and coloured by electrical node', () => {
    const { doc } = mixedCircuit();
    const scene = deriveScene(doc);
    const g = connectivity(doc);
    expect(scene.wires.map((w) => w.id)).toEqual(doc.layout.wires.map((w) => w.id));
    for (const w of scene.wires) {
      expect(w.points.every((p) => p.y > 0)).toBe(true);
      const node = g.nodes.find((n) => n.id === w.node)!;
      if (node.id === GROUND_NODE) expect(w.color).toBe('#202326');
      else if (node.kind === 'supply') expect(w.color).toBe('#d32f2f');
      else expect(['#202326', '#d32f2f']).not.toContain(w.color);
    }
    // Wires of one node share a colour; different signal nodes get different colours.
    const colorOf = new Map<string, Set<string>>();
    for (const w of scene.wires) {
      if (!colorOf.has(w.node!)) colorOf.set(w.node!, new Set());
      colorOf.get(w.node!)!.add(w.color);
    }
    for (const set of colorOf.values()) expect(set.size).toBe(1);
    const signalColors = [...colorOf.entries()]
      .filter(([n]) => g.nodes.find((x) => x.id === n)?.kind === 'signal')
      .map(([, s]) => [...s][0]);
    expect(new Set(signalColors).size).toBe(signalColors.length);
  });

  it('follows edits: add, delete, move, rotate, reconnect; values change visual detail only', () => {
    const { doc, ids } = mixedCircuit();
    const before = deriveScene(doc);
    const added = place(doc, 'component.diode', 600, 300);
    const s1 = deriveScene(added.doc);
    expect(s1.components.map((c) => c.id)).toContain(added.id);
    const removed = must(
      deleteSelection(doc, { components: [ids.led!], wires: [], junctions: [] }),
    ).doc;
    const s2 = deriveScene(removed);
    expect(s2.components.some((c) => c.id === ids.led)).toBe(false);
    expect(s2.wires.length).toBeLessThan(before.wires.length);
    const moved = must(
      moveSelection(doc, { components: [ids.rled!], wires: [], junctions: [] }, { x: 0, y: 200 }),
    ).doc;
    expect(deriveScene(moved).components.find((c) => c.id === ids.rled)!.z).toBe(
      before.components.find((c) => c.id === ids.rled)!.z + 200 * SCALE,
    );
    const rotated = must(rotateComponents(doc, [ids.rled!])).doc;
    const r = deriveScene(rotated).components.find((c) => c.id === ids.rled)!;
    expect(r.rotation).toBe(90);
    expect(r.rotationY).toBeCloseTo(-Math.PI / 2);
    // Reconnect: wire the LED cathode also to GPIO2 → that wire takes the ground colour.
    const rewired = wire(doc, [ids.u!, 'gpio2'], [ids.led!, 'cathode']);
    const s3 = deriveScene(rewired);
    expect(s3.wires.at(-1)!.color).toBe('#202326');
    // A design value is visual detail only (bands), never placement.
    const valued = must(setParam(doc, ids.rled!, 'resistance', { value: 4700, unit: 'ohm' })).doc;
    const s4 = deriveScene(valued);
    const rv = s4.components.find((c) => c.id === ids.rled)!;
    expect(rv.visual.bands).toEqual(['yellow', 'violet', 'red', 'gold']);
    expect({ ...rv, visual: {} }).toEqual({
      ...before.components.find((c) => c.id === ids.rled)!,
      visual: {},
    });
  });

  it('a toggle switch shows its persisted position', () => {
    const { doc } = mixedCircuit();
    const t = place(doc, 'component.toggle_switch', 600, 0);
    expect(deriveScene(t.doc).components.find((c) => c.id === t.id)!.visual.closed).toBe(false);
    const closed = must(setParam(t.doc, t.id, 'closed', true)).doc;
    expect(deriveScene(closed).components.find((c) => c.id === t.id)!.visual.closed).toBe(true);
  });

  it('is deterministic and never touches the document', () => {
    for (const e of EXAMPLES) {
      const snapshot = JSON.stringify(e.document);
      const a = deriveScene(e.document);
      expect(JSON.stringify(deriveScene(e.document))).toBe(JSON.stringify(a));
      expect(JSON.stringify(e.document)).toBe(snapshot);
      expect(a.components).toHaveLength(e.document.components.length);
      // The content lies on the base plane.
      for (const c of a.components) {
        expect(c.x).toBeGreaterThan(a.base.minX);
        expect(c.x).toBeLessThan(a.base.maxX);
        expect(c.z).toBeGreaterThan(a.base.minZ);
        expect(c.z).toBeLessThan(a.base.maxZ);
      }
    }
  });

  it('resistor colour code: 4 bands when two digits are exact, 5 when three are, none otherwise', () => {
    expect(resistorBands(220)).toEqual(['red', 'red', 'brown', 'gold']);
    expect(resistorBands(1000)).toEqual(['brown', 'black', 'red', 'gold']);
    expect(resistorBands(10_000)).toEqual(['brown', 'black', 'orange', 'gold']);
    expect(resistorBands(4.7)).toEqual(['yellow', 'violet', 'gold', 'gold']);
    expect(resistorBands(0.47)).toEqual(['yellow', 'violet', 'silver', 'gold']);
    expect(resistorBands(4750)).toEqual(['yellow', 'violet', 'green', 'brown', 'brown']);
    expect(resistorBands(1234.5)).toBeNull();
    expect(resistorBands(0)).toBeNull();
  });
});
