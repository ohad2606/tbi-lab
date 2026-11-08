/**
 * Sprint 13 OS-04 (Owner Smoke, P0): component bodies may not overlap, by one rule for the Circuit
 * view and the 3D view derived from it (app/src/geometry/overlap.ts), enforced for every edit that
 * adds, moves or rotates a part (AppStore.apply). Acceptance:
 * (a) a part dropped onto another is refused, the layout unchanged, the reason named;
 * (b) a placement whose SYMBOLS are apart but whose real bodies collide (3D) is refused too;
 * (c) parts meant to touch (terminal to terminal) are not overlaps;
 * (d) every layout the gate accepts needs no 3D separation (consistent views);
 * (e) overlaps already in an opened project do not block unrelated edits.
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  createProject,
  moveSelection,
  emptySelection,
  type ComponentTypeId,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { EXAMPLES_WITH_DOCUMENTS as EXAMPLES } from '../src/examples/documents.js';
import { bodyOverlaps } from '../src/geometry/overlap.js';
import { ProjectStore } from '../src/persistence/store.js';
import { AppStore, type Preferences } from '../src/state/app.js';
import { deriveScene } from '../src/views/scene3d/scene.js';

function docWith(parts: [ComponentTypeId, number, number][]): {
  doc: ProjectDocument;
  ids: string[];
} {
  let doc = createProject({ projectId: 'prj_os04', deviceId: 'd', name: 'OS-04', appVersion: '0' });
  const ids: string[] = [];
  for (const [type, x, y] of parts) {
    const r = addComponent(doc, type, { x, y });
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
    ids.push(r.id);
  }
  return { doc, ids };
}

const prefs = (): Preferences => {
  const d: Record<string, string> = {};
  return { get: (k) => d[k] ?? null, set: (k, v) => void (d[k] = v) };
};

async function store(doc: ProjectDocument) {
  const app = new AppStore({
    storage: await ProjectStore.open(new IDBFactory()),
    prefs: prefs(),
    languages: ['en'],
    newId: () => 'x1',
    autosaveDebounceMs: 1,
  });
  await app.init();
  await app.newProject('OS-04');
  // Load the whole document as a state (not a placement edit), as opening a project does.
  app.apply({ ok: true, doc: { ...doc, projectId: app.state.doc!.projectId } }, undefined, {
    restore: true,
  });
  return app;
}

describe('OS-04: one overlap rule for the Circuit and 3D views', () => {
  it('two parts at one place overlap in both views', () => {
    const { doc, ids } = docWith([
      ['component.resistor', 400, 400],
      ['component.resistor', 400, 400],
    ]);
    // Their terminals coincide too: still an overlap (the joint exemption is physical only).
    expect(bodyOverlaps(doc)).toEqual([{ a: ids[0], b: ids[1], in: 'circuit' }]);
  });

  it('symbols apart but real bodies colliding: an overlap in 3D (the LCD module is 80 x 36 mm)', () => {
    // The LCD symbol is 232 layout units wide; its module is 504 units (80 mm) wide.
    const { doc, ids } = docWith([
      ['display.lcd1602_i2c', 400, 400],
      ['display.lcd1602_i2c', 400 + 260, 400],
    ]);
    expect(bodyOverlaps(doc)).toEqual([{ a: ids[0], b: ids[1], in: '3d' }]);
    const far = docWith([
      ['display.lcd1602_i2c', 400, 400],
      ['display.lcd1602_i2c', 400 + 560, 400],
    ]);
    expect(bodyOverlaps(far.doc)).toEqual([]);
  });

  it('parts whose terminals touch (a direct joint) are not an overlap', () => {
    // Two resistors in series: one's b terminal (x + 40) on the other's a terminal (x - 40).
    const { doc } = docWith([
      ['component.resistor', 400, 400],
      ['component.resistor', 480, 400],
    ]);
    expect(bodyOverlaps(doc)).toEqual([]);
  });

  it('every curated example is free of overlaps', () => {
    for (const e of EXAMPLES) expect(bodyOverlaps(e.document as ProjectDocument), e.id).toEqual([]);
  });
});

describe('OS-04: the edit gate', () => {
  it('a part moved onto another is refused, the layout unchanged and the reason named', async () => {
    const { doc, ids } = docWith([
      ['component.resistor', 400, 400],
      ['component.led', 800, 400],
    ]);
    const app = await store(doc);
    const before = structuredClone(app.state.doc!.layout);
    const onto = moveSelection(
      app.state.doc!,
      { ...emptySelection(), components: [ids[1]!] },
      {
        x: -400,
        y: 0,
      },
    );
    expect(app.apply(onto)).toBe(false);
    expect(app.state.doc!.layout).toEqual(before);
    expect(app.state.notice).toMatchObject({
      key: 'edit.overlap.circuit',
      params: { a: `\u2066${ids[0]}\u2069`, b: `\u2066${ids[1]}\u2069` }, // isolated LTR (Hebrew)
    });
    // A free place is accepted.
    const away = moveSelection(
      app.state.doc!,
      { ...emptySelection(), components: [ids[1]!] },
      {
        x: 0,
        y: 200,
      },
    );
    expect(app.apply(away)).toBe(true);
  });

  it('adding a part on top of another is refused; next to it is accepted', async () => {
    const { doc } = docWith([['display.lcd1602_i2c', 400, 400]]);
    const app = await store(doc);
    expect(app.apply(addComponent(app.state.doc!, 'display.lcd1602_i2c', { x: 640, y: 400 }))).toBe(
      false,
    );
    expect(app.state.notice?.key).toBe('edit.overlap.3d');
    expect(app.apply(addComponent(app.state.doc!, 'display.lcd1602_i2c', { x: 400, y: 700 }))).toBe(
      true,
    );
  });

  it('undo can always go back, even into an overlap the project already had', async () => {
    const { doc, ids } = docWith([
      ['component.resistor', 400, 400],
      ['component.resistor', 400, 400],
    ]);
    const app = await store(doc);
    const apart = moveSelection(
      app.state.doc!,
      { ...emptySelection(), components: [ids[1]!] },
      {
        x: 0,
        y: 200,
      },
    );
    expect(app.apply(apart)).toBe(true);
    expect(app.undo()).toBe(true);
    expect(app.state.doc!.layout.components[ids[1]!]).toMatchObject({ x: 400, y: 400 });
    expect(app.redo()).toBe(true);
  });

  it('an existing overlap in an opened project does not block an unrelated edit', async () => {
    const { doc, ids } = docWith([
      ['component.resistor', 400, 400],
      ['component.resistor', 400, 400],
      ['component.led', 1000, 400],
    ]);
    const app = await store(doc);
    const move = moveSelection(
      app.state.doc!,
      { ...emptySelection(), components: [ids[2]!] },
      {
        x: 0,
        y: 100,
      },
    );
    expect(app.apply(move)).toBe(true);
  });

  it('a layout the gate accepts needs no 3D separation: the views agree', async () => {
    const { doc } = docWith([['board.esp32_devkitc_wroom32', 400, 400]]);
    const app = await store(doc);
    const types: ComponentTypeId[] = [
      'display.lcd1602_i2c',
      'sensor.hc_sr04',
      'sensor.pir_hc_sr501',
      'component.relay',
      'component.resistor',
      'component.led',
    ];
    // Try every type at a grid of places around the board; keep only what the gate accepts.
    let accepted = 0;
    for (const type of types)
      for (let y = 0; y <= 1000; y += 120)
        for (let x = 0; x <= 1200; x += 160) {
          if (app.apply(addComponent(app.state.doc!, type, { x, y }))) accepted++;
        }
    expect(accepted).toBeGreaterThan(5);
    const scene = deriveScene(app.state.doc!);
    expect(scene.separation.unresolved).toEqual([]);
    expect(scene.separation.moved).toEqual([]);
  });
});
