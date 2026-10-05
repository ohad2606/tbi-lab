import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  addComponent,
  createSnapshot,
  setParam,
  validateProject,
} from '../src/index.js';
import { must, newDoc } from './helpers.js';

describe('LED component type (Sprint 3, additive)', () => {
  it('places with a language-neutral model token and a D reference', () => {
    const r = must(addComponent(newDoc(), 'component.led', { x: 0, y: 0 }));
    expect(r.id).toBe('D1');
    expect(r.doc.components.at(-1)).toEqual({
      id: 'D1',
      type: 'component.led',
      typeVersion: 1,
      params: { model: 'model.led.vishay_tlhr5400' },
    });
    expect(validateProject(r.doc)).toEqual([]);
  });

  it('accepts only curated model tokens', () => {
    const doc = must(addComponent(newDoc(), 'component.led', { x: 0, y: 0 })).doc;
    expect(setParam(doc, 'D1', 'model', 'model.led.unknown')).toEqual({
      ok: false,
      error: 'out_of_range',
    });
    expect(setParam(doc, 'D1', 'model', true)).toEqual({ ok: false, error: 'param_type' });
    const bad = JSON.parse(JSON.stringify(doc));
    bad.components.at(-1).params.model = 'Red LED';
    expect(validateProject(bad).map((i) => i.code)).toContain('bad_param');
  });

  it('Sprint 2 documents stay valid unchanged (the schema change is additive)', () => {
    expect(validateProject(newDoc())).toEqual([]);
    expect(newDoc().schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe('createSnapshot', () => {
  it('carries the netlist and revision, and nothing from the layout', () => {
    const doc = newDoc();
    const snap = createSnapshot(doc);
    expect(snap).toMatchObject({
      format: 'tbi-lab.snapshot',
      projectId: doc.projectId,
      projectRevision: 1,
    });
    expect(Object.keys(snap).sort()).toEqual(
      [
        'components',
        'connections',
        'format',
        'nets',
        'projectId',
        'projectRevision',
        'schemaVersion',
        'snapshotId',
      ].sort(),
    );
    expect(snap.snapshotId).toMatch(/^snap_[0-9a-f]{16}$/);
  });

  it('Sprint 10: the approved yellow and green cards are curated tokens; nothing else is', () => {
    let doc = must(addComponent(newDoc(), 'component.led', { x: 0, y: 0 })).doc;
    for (const model of ['model.led.vishay_tlhy5400', 'model.led.vishay_tlhg4900']) {
      doc = must(setParam(doc, 'D1', 'model', model)).doc;
      expect(doc.components.at(-1)!.params.model).toBe(model);
      expect(validateProject(doc)).toEqual([]);
      expect(createSnapshot(doc).components.at(-1)!.params.model).toBe(model);
    }
    // The default (and every existing project) stays the red part.
    expect(
      must(addComponent(newDoc(), 'component.led', { x: 0, y: 0 })).doc.components.at(-1)!.params
        .model,
    ).toBe('model.led.vishay_tlhr5400');
    expect(setParam(doc, 'D1', 'model', 'model.led.vishay_tlhb5400')).toEqual({
      ok: false,
      error: 'out_of_range',
    });
  });
});
