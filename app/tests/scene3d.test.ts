/**
 * Sprint 9: the 3D scene description — a deterministic function of the project document. No
 * WebGL here (the renderer is exercised in the browser suite).
 */
import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  ESP32_DEVKITC_WROOM32,
  GROUND_NODE,
  connectivity,
  deleteSelection,
  moveSelection,
  rotateComponents,
  setParam,
  terminalPosition,
} from '@tbi-lab/domain';
import { mixedCircuit, place, wire } from '../../packages/domain/tests/circuits.js';
import { must, newDoc } from '../../packages/domain/tests/helpers.js';
import {
  ESP32_ATTACH_HEIGHT,
  ESP32_PIN_TOP,
  LEAD_ATTACH_HEIGHT,
  LED_PACKAGES,
  WIRE,
} from '../src/views/scene3d/physical.js';
import { EXAMPLES_WITH_DOCUMENTS as EXAMPLES } from '../src/examples/documents.js';
import {
  MODEL_FOR,
  SCALE,
  MODEL_HEIGHT,
  WIRE_RADIUS,
  deriveScene,
  realPinZ,
  resistorBands,
} from '../src/views/scene3d/scene.js';

describe('3D scene description', () => {
  it('has one part per component, at its 2D layout position, with the right model', () => {
    const { doc } = mixedCircuit();
    const scene = deriveScene(doc);
    expect(scene.components.map((c) => c.id)).toEqual(doc.components.map((c) => c.id));
    for (const c of scene.components) {
      const p = doc.layout.components[c.id]!;
      expect([c.x, c.z]).toEqual([p.x * SCALE, p.y * SCALE]);
      expect(c.model).toBe(MODEL_FOR[c.type]);
      // Terminals attach where the circuit view has them (plan view, mm). An ESP32 pin attaches
      // on the 2D pin column (the real header row) at its REAL position along the header (2.54 mm
      // pitch; the 2D grid is 3.175 mm).
      for (const t of c.terminals) {
        const at = terminalPosition(doc, c.id, t.id)!;
        if (c.model === 'board.esp32_devkitc') {
          const pin = ESP32_DEVKITC_WROOM32.pins.find(
            (p) =>
              `gpio${p.gpio}` === t.id ||
              (t.id === 'gnd' && p.role === 'ground' && p.header === 'J3' && p.position === 1),
          )!;
          expect(t.x).toBeCloseTo(at.x * SCALE, 9);
          expect(t.z - c.z).toBeCloseTo(realPinZ(pin.position), 9);
          expect(Math.abs(t.x - c.x)).toBeCloseTo(12.7, 9);
          expect([ESP32_ATTACH_HEIGHT, ESP32_PIN_TOP]).toContain(t.y);
        } else {
          expect(t.x).toBeCloseTo(at.x * SCALE, 9);
          expect(t.z).toBeCloseTo(at.y * SCALE, 9);
        }
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
    expect(deriveScene(moved).components.find((c) => c.id === ids.rled)!.z).toBeCloseTo(
      before.components.find((c) => c.id === ids.rled)!.z + 200 * SCALE,
      9,
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

  it('marks where terminals meet: a solder joint for a contact, a gap and an open mark otherwise', () => {
    let doc = place(newDoc(), 'component.resistor', 100, 200).doc;
    doc = place(doc, 'component.led', 180, 200).doc; // D1.anode on R1.b: a contact
    const joined = deriveScene(doc);
    expect(joined.joints).toEqual([
      {
        kind: 'contact',
        x: 140 * SCALE,
        z: 200 * SCALE,
        y: LEAD_ATTACH_HEIGHT,
        terminals: ['D1:anode', 'R1:b'],
        node: joined.components.find((c) => c.id === 'R1')!.terminals[1]!.node,
      },
    ]);
    expect(joined.joints[0]!.node).not.toBeNull();
    expect(joined.wires).toEqual([]); // a contact has no wire to draw
    expect(joined.components.flatMap((c) => c.terminals).some((t) => t.open)).toBe(false);
    // The same parts touching in a document that does not connect them (made elsewhere).
    const apart = must(
      moveSelection(doc, { components: ['D1'], wires: [], junctions: [] }, { x: 60, y: 0 }),
    ).doc;
    apart.layout.components.D1!.x = 180;
    const open = deriveScene(apart);
    expect(open.joints.map((j) => [j.kind, j.terminals, j.node])).toEqual([
      ['open', ['D1:anode', 'R1:b'], null],
    ]);
    const flags = open.components.flatMap((c) =>
      c.terminals.filter((t) => t.open).map((t) => `${c.id}:${t.id}`),
    );
    expect(flags.sort()).toEqual(['D1:anode', 'R1:b']);
  });

  it('wires that cross get different heights; a wire over terminals runs above them all', () => {
    let doc = newDoc();
    for (const [x, y] of [
      [0, -100],
      [200, -100],
      [100, -200],
      [100, 0],
    ] as const)
      doc = place(doc, 'component.resistor', x, y).doc;
    doc = wire(doc, ['R1', 'b'], ['R2', 'a']);
    doc = wire(doc, ['R3', 'b'], ['R4', 'b']);
    const scene = deriveScene(doc);
    const level = (id: string) => scene.wires.find((w) => w.id === id)!.points[1]!.y;
    const [a, b] = doc.layout.wires.map((w) => w.id) as [string, string];
    expect(Math.abs(level(a) - level(b))).toBeGreaterThanOrEqual(WIRE.levelStepMm - 1e-9);
    expect(WIRE.levelStepMm).toBeGreaterThan(2 * WIRE_RADIUS);
    // R1.a → R2.b along y = -100 passes over R1.b and R2.a (and both bodies).
    const over = wire(doc, ['R1', 'a'], ['R2', 'b']);
    const s2 = deriveScene(over);
    const w = s2.wires.find((x) => x.id === over.layout.wires.at(-1)!.id)!;
    // It runs a clearance above the bodies and leads it passes over.
    const clear = MODEL_HEIGHT['resistor.axial'] + WIRE.clearanceMm;
    expect(w.points.slice(1, -1).every((p) => p.y >= clear - 1e-9)).toBe(true);
  });

  it('each LED card shows its datasheet package and colour (presentation only)', () => {
    let doc = place(newDoc(), 'component.led', 100, 200).doc;
    const look = (model: string) => {
      const d = must(setParam(doc, 'D1', 'model', model)).doc;
      return deriveScene(d).components.find((c) => c.id === 'D1')!.visual.led;
    };
    expect(look('model.led.vishay_tlhr5400')).toMatchObject({ package: 't1_34', clear: false });
    expect(look('model.led.vishay_tlhy5400')).toMatchObject({ package: 't1_34', clear: false });
    expect(look('model.led.vishay_tlhg4900')).toMatchObject({ package: 't1', clear: true });
    doc = must(setParam(doc, 'D1', 'model', 'model.led.vishay_tlhg4900')).doc;
    // The 3 mm part is smaller than the 5 mm one; both stand on the same terminals.
    expect(LED_PACKAGES.t1.bodyDiameterMm).toBeLessThan(LED_PACKAGES.t1_34.bodyDiameterMm);
    const terms = deriveScene(doc).components.find((c) => c.id === 'D1')!.terminals;
    expect(terms.map((t) => t.x)).toEqual(
      [(100 - 40) * SCALE, (100 + 40) * SCALE].map((x) => expect.closeTo(x, 9)),
    );
  });
});
