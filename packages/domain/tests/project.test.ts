import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  addComponent,
  deleteSelection,
  emptySelection,
  stampRevision,
  validateProject,
} from '../src/index.js';
import { fixedClock, must, newDoc } from './helpers.js';

describe('createProject', () => {
  it('produces a valid schema v2 document with a PSU and a ground, unwired', () => {
    const doc = newDoc();
    expect(validateProject(doc)).toEqual([]);
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(doc.components.map((c) => [c.id, c.type])).toEqual([
      ['PSU1', 'instrument.lab_psu'],
      ['GND1', 'component.ground'],
    ]);
    expect(doc.components[0]!.params).toEqual({
      setpointVoltage: { value: 5, unit: 'volt' },
      currentLimit: { value: 0.1, unit: 'ampere' },
      // A new supply is ready to power the circuit (Product Alpha maintenance).
      outputEnabled: true,
    });
    expect(doc.nets).toEqual([]);
    expect(doc.revision).toEqual({
      localRevision: 1,
      cloudRevision: null,
      baseRevision: null,
      updatedAt: '2026-09-22T12:00:00.000Z',
      deviceId: 'device-test',
    });
  });

  it('contains no localized text and no locale in its identity', () => {
    const json = JSON.stringify(newDoc());
    expect(json).not.toMatch(/[֐-׿]/); // no Hebrew
    expect(json).not.toMatch(/Resistor|Ground|Lab power supply/);
    expect(newDoc().projectId).not.toMatch(/en|he/);
  });
});

describe('reference designators', () => {
  it('are assigned per prefix and never reused after delete', () => {
    let doc = newDoc();
    const r1 = must(addComponent(doc, 'component.resistor', { x: 0, y: 0 }));
    const r2 = must(addComponent(r1.doc, 'component.resistor', { x: 100, y: 0 }));
    expect([r1.id, r2.id]).toEqual(['R1', 'R2']);
    doc = must(deleteSelection(r2.doc, { ...emptySelection(), components: ['R2'] })).doc;
    const r3 = must(addComponent(doc, 'component.resistor', { x: 100, y: 0 }));
    expect(r3.id).toBe('R3');
    const psu2 = must(addComponent(r3.doc, 'instrument.lab_psu', { x: 0, y: 200 }));
    expect(psu2.id).toBe('PSU2');
  });
});

describe('stampRevision', () => {
  it('advances localRevision and updatedAt without touching sync fields', () => {
    const doc = newDoc();
    const later = { now: () => new Date('2026-09-22T12:00:05.000Z') };
    const stamped = stampRevision(doc, 'device-b', later);
    expect(stamped.revision).toEqual({
      localRevision: 2,
      cloudRevision: null,
      baseRevision: null,
      updatedAt: '2026-09-22T12:00:05.000Z',
      deviceId: 'device-b',
    });
    expect(doc.revision.localRevision).toBe(1); // input untouched
    expect(stampRevision(doc, 'd', fixedClock).revision.localRevision).toBe(2);
  });
});
