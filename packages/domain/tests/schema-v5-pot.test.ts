/**
 * Sprint POT-UNITS: schema v5 (identity 4 -> 5) adds `component.potentiometer` and the unit
 * `percent`. Checked here:
 * - 4 -> 5 is the identity and deterministic; v2/v3/v4 documents still open (the full chain);
 * - a v5 document with a potentiometer validates, and its parameters are range-checked;
 * - a v5 file opened by a v4 build is `newer` (refused by name), never `invalid`;
 * - export -> import of a project with a potentiometer round-trips exactly;
 * - the wiper position is a live parameter (0 … 100 %), anything else is refused.
 */
import { describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  addComponent,
  addWire,
  createPackage,
  createProject,
  liveControlProblem,
  liveParamKeys,
  openDocument,
  parsePackage,
  projectHash,
  serializePackage,
  setParam,
  validateProject,
  type ProjectDocument,
} from '../src/index.js';

const meta = { appVersion: 'pot', exportedAt: '2026-10-30T00:00:00.000Z' };

function potProject(): ProjectDocument {
  let doc = createProject({
    projectId: 'prj_pot',
    deviceId: 'dev_pot',
    name: 'Pot',
    appVersion: 'pot',
    clock: { now: () => new Date('2026-10-30T00:00:00.000Z') },
  });
  const r = addComponent(doc, 'component.potentiometer', { x: 200, y: 0 });
  if (!r.ok) throw new Error(r.error);
  doc = r.doc;
  const step = <T extends { ok: boolean; doc?: ProjectDocument }>(x: T) => {
    if (!x.ok || !x.doc) throw new Error(JSON.stringify(x));
    doc = x.doc;
  };
  step(setParam(doc, r.id, 'resistance', { value: 5000, unit: 'ohm' }));
  step(setParam(doc, r.id, 'position', { value: 37.5, unit: 'percent' }));
  step(
    addWire(
      doc,
      { kind: 'terminal', component: 'PSU1', terminal: 'positive' },
      { kind: 'terminal', component: r.id, terminal: 'a' },
    ),
  );
  return doc;
}

describe('schema v5 (Sprint POT-UNITS)', () => {
  it('is 5; 4 -> 5 is the identity and deterministic', () => {
    expect(SCHEMA_VERSION).toBe(6); // Sprint 26: v6 (5 -> 6 is the identity)
    const doc = potProject();
    const v4 = { ...JSON.parse(JSON.stringify(doc)), schemaVersion: 4 };
    // A v4 document cannot hold a potentiometer; the identity is checked on any content.
    const before = JSON.stringify(v4);
    expect(MIGRATIONS[4]!(JSON.parse(before))).toEqual(JSON.parse(before));
    expect(JSON.stringify(v4)).toBe(before);
  });

  it('older documents (v2, v3, v4) open through the chain with every value unchanged', () => {
    const base = createProject({
      projectId: 'prj_old',
      deviceId: 'd',
      name: 'Old',
      appVersion: 'old',
      clock: { now: () => new Date('2026-09-01T00:00:00.000Z') },
    });
    const r = addComponent(base, 'component.resistor', { x: 100, y: 0 });
    if (!r.ok) throw new Error(r.error);
    const s = setParam(r.doc, r.id, 'resistance', { value: 5000, unit: 'ohm' });
    if (!s.ok) throw new Error(s.error);
    for (const v of [4, 3]) {
      const old = { ...JSON.parse(JSON.stringify(s.doc)), schemaVersion: v };
      const o = openDocument(old);
      expect(o.status).toBe('ok');
      if (o.status !== 'ok') return;
      expect(o.migratedFrom).toBe(v);
      expect(o.doc.schemaVersion).toBe(6); // through the chain, now to v6
      expect({ ...o.doc, schemaVersion: v }).toEqual(old);
    }
  });

  it('a document with a potentiometer validates; its parameters are range-checked', () => {
    const doc = potProject();
    expect(validateProject(doc)).toEqual([]);
    const rv = doc.components.find((c) => c.type === 'component.potentiometer')!;
    expect(rv.params).toEqual({
      model: 'model.potentiometer.bourns_ptv09a_linear',
      resistance: { value: 5000, unit: 'ohm' },
      position: { value: 37.5, unit: 'percent' },
    });
    const bad = (key: string, v: unknown) => {
      const d = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
      (d.components.find((c) => c.id === rv.id)!.params as Record<string, unknown>)[key] = v;
      return validateProject(d).map((i) => i.code);
    };
    expect(bad('position', { value: 101, unit: 'percent' })).toContain('bad_param');
    expect(bad('position', { value: 50, unit: 'percent_rh' })).toContain('bad_param');
    expect(bad('resistance', { value: 500, unit: 'ohm' })).toContain('bad_param');
    expect(bad('resistance', { value: 2e6, unit: 'ohm' })).toContain('bad_param');
    expect(bad('position', { value: 1e-13, unit: 'percent' })).toEqual(['off_grid_param']);
    expect(bad('position', { value: 12.345, unit: 'percent' })).toEqual(['off_grid_param']);
    expect(bad('position', { value: 99.99, unit: 'percent' })).toEqual([]);
    expect(setParam(doc, rv.id, 'position', { value: 1e-13, unit: 'percent' })).toEqual({
      ok: false,
      error: 'off_grid',
    });
  });

  it('a v4 build opens a v5 file as `newer` (by name), never as invalid', () => {
    const doc = potProject();
    const asV4Build = openDocument(JSON.parse(JSON.stringify(doc)), MIGRATIONS, 4);
    expect(asV4Build.status).toBe('newer');
  });

  it('export -> import of a project with a potentiometer round-trips exactly', () => {
    const doc = potProject();
    const text = serializePackage(createPackage(doc, meta));
    const back = parsePackage(text);
    if (!back.ok) throw new Error(JSON.stringify(back.error));
    expect(back.doc).toEqual(doc);
    expect(projectHash(back.doc)).toBe(projectHash(doc));
    expect(serializePackage(createPackage(back.doc, meta))).toBe(text);
  });

  it('the wiper position is the live parameter, bounded 0 … 100 %', () => {
    expect(liveParamKeys('component.potentiometer')).toEqual(['position']);
    expect(liveControlProblem('component.potentiometer', { params: { position: 0 } })).toBeNull();
    expect(liveControlProblem('component.potentiometer', { params: { position: 100 } })).toBeNull();
    // Review M2: the 0.01 % grid, refused by name.
    expect(liveControlProblem('component.potentiometer', { params: { position: 1e-13 } })).toEqual({
      reason: 'invalid_value',
      key: 'position',
      detail: 'off_grid',
    });
    expect(
      liveControlProblem('component.potentiometer', { params: { position: 33.33 } }),
    ).toBeNull();
    for (const v of [-1, 100.5, Number.NaN])
      expect(
        liveControlProblem('component.potentiometer', { params: { position: v } }),
      ).not.toBeNull();
    // The total resistance is structural: not a live parameter.
    expect(
      liveControlProblem('component.potentiometer', { params: { resistance: 1000 } }),
    ).not.toBeNull();
  });
});
