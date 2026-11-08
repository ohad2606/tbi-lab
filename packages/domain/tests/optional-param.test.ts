/**
 * Sprint 19B (F2): an OPTIONAL enum parameter (the resistor's `powerRating`): absent means its
 * default, it is stored only when set to another value, and documents without it stay valid and
 * unchanged (no schema change, no rollback effect on existing projects).
 */
import { describe, expect, it } from 'vitest';
import { CATALOG, defaultParams, paramValue, setParam, validateProject } from '../src/index.js';
import { must, newDoc } from './helpers.js';
import { place } from './circuits.js';

describe('optional parameters (resistor powerRating)', () => {
  const def = CATALOG['component.resistor'].params.find((p) => p.key === 'powerRating')!;

  it('a new resistor does not store it; its effective value is the ¼ W default; the document is valid', () => {
    expect(defaultParams(CATALOG['component.resistor'])).toEqual({
      resistance: { value: 1000, unit: 'ohm' },
    });
    const r = place(newDoc(), 'component.resistor', 0, 0);
    const c = r.doc.components.find((x) => x.id === r.id)!;
    expect('powerRating' in c.params).toBe(false);
    expect(paramValue(c.params, def)).toBe('model.resistor.koa_cf_1_4');
    expect(validateProject(r.doc)).toEqual([]);
  });

  it('stored only when it differs from the default; set back to the default, removed again', () => {
    const r = place(newDoc(), 'component.resistor', 0, 0);
    const half = must(setParam(r.doc, r.id, 'powerRating', 'model.resistor.koa_cfs_1_2')).doc;
    expect(half.components.find((x) => x.id === r.id)!.params.powerRating).toBe(
      'model.resistor.koa_cfs_1_2',
    );
    expect(validateProject(half)).toEqual([]);
    const back = must(setParam(half, r.id, 'powerRating', 'model.resistor.koa_cf_1_4')).doc;
    expect('powerRating' in back.components.find((x) => x.id === r.id)!.params).toBe(false);
    expect(setParam(back, r.id, 'powerRating', 'model.resistor.nope')).toMatchObject({
      ok: false,
      error: 'out_of_range',
    });
  });
});
