/**
 * Sprint 20 schema v3 -> v4 (owner-approved DP-rt2-1; s20r). v4 adds no field: it marks documents
 * that may carry automatic wires (`Wire.auto`), so builds before it refuse such a file BY NAME and
 * open such a stored project read-only. Checked here, through the real store:
 *  - the 3 -> 4 migration is the identity, for v3 documents with and without `auto`, and
 *    deterministic; connectivity and every value are preserved;
 *  - opening a stored v3 project does NOT rewrite it: the stored record stays byte-for-byte as it
 *    was until the project is saved in this build (its first edit), which stores it as v4;
 *  - export, import, duplication, autosave, undo/redo and reopening;
 *  - a newer (v5) stored project opens read-only and is never written; a v5 file is refused as
 *    "made by a newer version", never as damaged or invalid.
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  addComponent,
  connectivity,
  createPackage,
  openDocument,
  parsePackage,
  projectHash,
  serializePackage,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { ProjectStore } from '../src/persistence/store.js';
import { AppStore, type Preferences } from '../src/state/app.js';
import { routeAutomatic } from '../src/ui/routing.js';
import { ownerBench } from './support/ownerBench.js';

const prefs = (): Preferences => {
  const d: Record<string, string> = {};
  return { get: (k) => d[k] ?? null, set: (k, v) => void (d[k] = v) };
};
let ids = 0;
async function setup() {
  const storage = await ProjectStore.open(new IDBFactory());
  const app = new AppStore({
    storage,
    prefs: prefs(),
    languages: ['en'],
    newId: () => `v4n${++ids}`,
    autosaveDebounceMs: 1,
    routeLayout: routeAutomatic,
  });
  await app.init();
  return { storage, app };
}
const settle = () => new Promise((r) => setTimeout(r, 60));
/** A project as a v3 build stored it (the same content, schemaVersion 3). */
const asV3 = (doc: ProjectDocument): ProjectDocument =>
  ({ ...JSON.parse(JSON.stringify(doc)), schemaVersion: 3 }) as ProjectDocument;
const nets = (doc: ProjectDocument) => {
  const g = connectivity(doc);
  return JSON.stringify([...g.nodeOf].sort(([a], [b]) => (a < b ? -1 : 1)));
};

describe('schema v4 (s20r)', () => {
  it('is 4; 3 -> 4 is the identity, with and without automatic wires, and deterministic', () => {
    // Sprint POT-UNITS bumped the current version to 5 (identity 4 -> 5); the 3 -> 4 step is unchanged.
    expect(SCHEMA_VERSION).toBe(5);
    const withAuto = ownerBench().doc;
    expect(withAuto.layout.wires.every((w) => w.auto)).toBe(true);
    const manual = JSON.parse(JSON.stringify(withAuto)) as ProjectDocument;
    for (const w of manual.layout.wires) delete w.auto;
    for (const doc of [withAuto, manual]) {
      const v3 = asV3(doc);
      const before = JSON.stringify(v3);
      expect(MIGRATIONS[3]!(JSON.parse(before))).toEqual(JSON.parse(before));
      const a = openDocument(JSON.parse(before));
      const b = openDocument(JSON.parse(before));
      expect(a).toEqual(b);
      if (a.status !== 'ok') throw new Error(a.status);
      expect(a.migratedFrom).toBe(3);
      expect(JSON.stringify(v3)).toBe(before); // the input is not mutated
      // Everything but the version is exactly the v3 content (createdWith keeps its history).
      expect({ ...a.doc, schemaVersion: 3 }).toEqual(v3);
      expect(a.doc.createdWith.schemaVersion).toBe(doc.createdWith.schemaVersion);
      expect(nets(a.doc)).toBe(nets(doc));
    }
  });

  it('a v3 file imports as v4 with the same circuit; v4 export/import round-trips exactly', () => {
    const doc = ownerBench().doc;
    const v3pkg = JSON.parse(serializePackage(createPackage(doc, meta))) as {
      project: ProjectDocument;
      integrity: { project: string };
    };
    v3pkg.project = asV3(v3pkg.project);
    v3pkg.integrity.project = projectHash(v3pkg.project);
    const r = parsePackage(JSON.stringify(v3pkg));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(nets(r.doc)).toBe(nets(doc));
    const again = parsePackage(serializePackage(createPackage(r.doc, meta)));
    expect(again.ok && again.doc).toEqual(r.doc);
  });

  it('a v5 file is refused as newer (never damaged or invalid), and nothing is imported', async () => {
    const { storage, app } = await setup();
    const pkg = JSON.parse(serializePackage(createPackage(ownerBench().doc, meta))) as {
      project: ProjectDocument;
      integrity: { project: string };
    };
    pkg.project.schemaVersion = SCHEMA_VERSION + 1;
    pkg.integrity.project = projectHash(pkg.project);
    const text = JSON.stringify(pkg);
    expect(parsePackage(text)).toEqual({
      ok: false,
      error: { code: 'newer_schema', version: SCHEMA_VERSION + 1 },
    });
    const before = await storage.list();
    expect(await app.importPackage(text)).toBe(false);
    expect(app.state.notice?.key).toBe('import.error.newer');
    expect(await storage.list()).toEqual(before);
  });

  it('opening a stored v3 project never rewrites it; its first save in this build stores v4', async () => {
    const { storage, app } = await setup();
    const v3 = asV3({ ...ownerBench().doc, projectId: 'prj_v3stored' });
    await storage.save(v3);
    const stored = JSON.stringify(await storage.load('prj_v3stored'));
    await app.openProject('prj_v3stored');
    await settle();
    expect(app.state.doc!.schemaVersion).toBe(SCHEMA_VERSION);
    expect(app.state.readOnly).toBeNull();
    expect(app.state.notice?.key).not.toBe('open.routesAdjusted'); // canonical already
    // Opened, nothing edited: the stored record is byte-for-byte what the v3 build wrote.
    expect(JSON.stringify(await storage.load('prj_v3stored'))).toBe(stored);
    // Undo has nothing to undo (opening is not an edit).
    app.undo();
    expect(JSON.stringify({ ...app.state.doc!, schemaVersion: 3, revision: v3.revision })).toBe(
      JSON.stringify(v3),
    );
    // The first edit saves the project in this build: as v4, same circuit plus the edit.
    expect(app.apply(addComponent(app.state.doc!, 'component.resistor', { x: 400, y: 300 }))).toBe(
      true,
    );
    await app.flush();
    const saved = (await storage.load('prj_v3stored')) as ProjectDocument;
    expect(saved.schemaVersion).toBe(SCHEMA_VERSION);
    expect((await storage.list()).find((e) => e.projectId === 'prj_v3stored')!.schemaVersion).toBe(
      SCHEMA_VERSION,
    );
    // Undo / redo of that edit, autosaved; reopening gives the same document.
    app.undo();
    await app.flush();
    expect(nets((await storage.load('prj_v3stored')) as ProjectDocument)).toBe(nets(v3));
    app.redo();
    await app.flush();
    const last = JSON.stringify(app.state.doc);
    await app.openProject('prj_v3stored');
    expect(JSON.stringify(app.state.doc)).toBe(last);
  });

  it('a stored v3 project whose routes need adjusting: shown adjusted, NOT stored, until a genuine edit', async () => {
    // Owner decision (round 2): the open-time "routes adjusted" change is not persisted either.
    const { storage, app } = await setup();
    const fresh = ownerBench().doc;
    const stale = asV3({ ...fresh, projectId: 'prj_v3stale' });
    stale.layout.wires.find((w) => w.id === 'W2')!.vertices = [
      { x: -80, y: -200 },
      { x: 160, y: -200 },
    ];
    await storage.save(stale);
    const stored = JSON.stringify(await storage.load('prj_v3stale'));
    await app.openProject('prj_v3stale');
    await settle();
    expect(app.state.notice?.key).toBe('open.routesAdjusted');
    // Shown: the canonical routes; netlist as stored.
    expect(app.state.doc!.layout.wires).toEqual(fresh.layout.wires);
    expect(nets(app.state.doc!)).toBe(nets(stale));
    await app.flush();
    expect(JSON.stringify(await storage.load('prj_v3stale'))).toBe(stored); // v3, untouched
    // Leaving without an edit (another project opened) still writes nothing.
    await app.newProject('Other');
    await app.flush();
    expect(JSON.stringify(await storage.load('prj_v3stale'))).toBe(stored);
    // Reopened and edited: stored as v4 with the adjusted routes.
    await app.openProject('prj_v3stale');
    expect(app.rename('Edited')).toBe(true);
    await app.flush();
    const saved = (await storage.load('prj_v3stale')) as ProjectDocument;
    expect(saved.schemaVersion).toBe(SCHEMA_VERSION);
    expect(saved.layout.wires).toEqual(fresh.layout.wires);
    expect(nets(saved)).toBe(nets(stale));
  });

  it('duplicating or exporting a stored v3 project leaves it untouched; the copy and the file are v4', async () => {
    const { storage, app } = await setup();
    const v3 = asV3({ ...ownerBench().doc, projectId: 'prj_v3dup' });
    await storage.save(v3);
    const stored = JSON.stringify(await storage.load('prj_v3dup'));
    const copy = await app.duplicate('prj_v3dup');
    expect(copy).not.toBeNull();
    expect(((await storage.load(copy!)) as ProjectDocument).schemaVersion).toBe(SCHEMA_VERSION);
    expect(nets((await storage.load(copy!)) as ProjectDocument)).toBe(nets(v3));
    const file = await app.exportProject('prj_v3dup');
    const back = parsePackage(file!.text);
    expect(back.ok && back.doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(JSON.stringify(await storage.load('prj_v3dup'))).toBe(stored);
  });

  it('a stored v5 project opens read-only and is never written', async () => {
    const { storage, app } = await setup();
    const v5 = {
      ...ownerBench().doc,
      projectId: 'prj_v5stored',
      schemaVersion: SCHEMA_VERSION + 1,
    };
    await storage.save(v5 as ProjectDocument);
    const stored = JSON.stringify(await storage.load('prj_v5stored'));
    await app.openProject('prj_v5stored');
    expect(app.state.readOnly).toEqual({ schemaVersion: SCHEMA_VERSION + 1 });
    expect(app.apply(addComponent(app.state.doc!, 'component.resistor', { x: 400, y: 300 }))).toBe(
      false,
    );
    await settle();
    expect(JSON.stringify(await storage.load('prj_v5stored'))).toBe(stored);
  });
});

const meta = { appVersion: 's20r', exportedAt: '2026-10-23T00:00:00.000Z' };
