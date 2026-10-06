import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  CATALOG_ORDER,
  addComponent,
  addWire,
  checkCircuit,
  createSnapshot,
  deleteSelection,
  emptySelection,
  historyTarget,
  moveSelection,
  rotateComponents,
  setParam,
  stampRevision,
  terminalPosition,
  validateProject,
  type ComponentTypeId,
  type ProjectDocument,
} from '../src/index.js';
import { must, newDoc } from './helpers.js';

const t = (component: string, terminal: string) => ({
  kind: 'terminal' as const,
  component,
  terminal,
});
const place = (doc: ProjectDocument, type: ComponentTypeId, x: number, y: number) =>
  must(addComponent(doc, type, { x, y }));

describe('Sprint 4 catalog: the non-MCU V1 catalog is complete and closed (A16)', () => {
  it('holds exactly the seven original non-MCU types plus the approved Sprint 10 parts', () => {
    const mcu = (t: string) => t.startsWith('board.');
    // Sprint 6 adds the one PM-approved MCU item. The PM-6 revision (product scope §6.0,
    // 2026-10-06) opens the approved families; every type added is listed here explicitly.
    expect(CATALOG_ORDER.filter(mcu)).toEqual(['board.esp32_devkitc_wroom32']);
    expect([...CATALOG_ORDER].filter((t) => !mcu(t)).sort()).toEqual(
      [
        'component.diode',
        'component.ground',
        'component.led',
        'component.push_button',
        'component.resistor',
        'component.toggle_switch',
        'instrument.lab_psu',
        // Sprint 10 (§6.0): lighting, basic components.
        'component.rgb_led',
        'component.photoresistor',
        'component.buzzer',
        'component.relay',
        'component.bjt_npn',
        // Sensors (§6.0).
        'sensor.pir_hc_sr501',
        // Matrices (§6.0).
        'display.led_matrix_8x8',
        // Capacitor: exposed with time-stepped simulation (§6.0).
        'component.capacitor',
      ].sort(),
    );
  });

  it('diode: D reference, anode/cathode, curated datasheet model token', () => {
    const r = place(newDoc(), 'component.diode', 0, 0);
    expect(r.id).toBe('D1');
    expect(r.doc.components.at(-1)!.params).toEqual({ model: 'model.diode.vishay_1n4148' });
    expect(CATALOG['component.diode'].terminals.map((x) => x.id)).toEqual(['anode', 'cathode']);
    expect(validateProject(r.doc)).toEqual([]);
  });

  it('rotation moves the diode terminals but never swaps anode and cathode identity', () => {
    let doc = place(newDoc(), 'component.diode', 0, 0).doc;
    doc = must(addWire(doc, t('PSU1', 'positive'), t('D1', 'anode'))).doc;
    expect(terminalPosition(doc, 'D1', 'anode')).toEqual({ x: -40, y: 0 });
    doc = must(rotateComponents(doc, ['D1'])).doc;
    doc = must(rotateComponents(doc, ['D1'])).doc; // 180°: anode drawn on the right
    expect(terminalPosition(doc, 'D1', 'anode')).toEqual({ x: 40, y: 0 });
    // The wire still ends on the ANODE: polarity is by terminal id, not by drawing position.
    expect(doc.connections.find((c) => c.component === 'D1')).toMatchObject({ terminal: 'anode' });
    expect(
      createSnapshot(doc).connections.some((c) => c.component === 'D1' && c.terminal === 'anode'),
    ).toBe(true);
  });

  it('push button: SW reference, NO parameters (its pressed state is runtime only)', () => {
    const r = place(newDoc(), 'component.push_button', 0, 0);
    expect(r.id).toBe('SW1');
    expect(r.doc.components.at(-1)!.params).toEqual({});
    expect(CATALOG['component.push_button'].momentary).toBe(true);
    expect(JSON.stringify(r.doc)).not.toMatch(/pressed/i);
    expect(validateProject(r.doc)).toEqual([]);
  });

  it('toggle switch: persistent `closed` position, live-capable, shares the SW counter', () => {
    let doc = place(newDoc(), 'component.push_button', 0, 0).doc;
    const r = place(doc, 'component.toggle_switch', 0, 100);
    expect(r.id).toBe('SW2');
    doc = r.doc;
    expect(doc.components.at(-1)!.params).toEqual({ closed: false });
    expect(CATALOG['component.toggle_switch'].params[0]).toMatchObject({
      key: 'closed',
      live: true,
    });
    doc = must(setParam(doc, 'SW2', 'closed', true)).doc;
    expect(doc.components.at(-1)!.params.closed).toBe(true);
    const bad = JSON.parse(JSON.stringify(doc));
    bad.components.at(-1).params.closed = 'yes';
    expect(validateProject(bad).map((i) => i.code)).toContain('bad_param');
    // A push button cannot be given a position.
    expect(setParam(doc, 'SW1', 'closed', true)).toEqual({ ok: false, error: 'unknown_param' });
  });
});

describe('historyTarget: undo/redo identity and revision rules (A10)', () => {
  it('keeps the newest revision and never lowers an id counter', () => {
    const base = newDoc();
    const withR1 = place(base, 'component.resistor', 0, 0).doc;
    const current = stampRevision(stampRevision(withR1, 'd'), 'd');
    const undone = historyTarget(current, base);
    expect(undone.components.map((c) => c.id)).toEqual(['PSU1', 'GND1']);
    expect(undone.idCounters.R).toBe(1); // R1 was issued: it is never reissued
    expect(undone.revision).toEqual(current.revision);
    expect(place(undone, 'component.resistor', 0, 0).id).toBe('R2');
    const redone = historyTarget(undone, withR1);
    expect(redone.components.at(-1)!.id).toBe('R1'); // redo restores the same identity
    expect(validateProject(redone)).toEqual([]);
  });
});

describe('checkCircuit: validation that never changes the circuit (A12, A13)', () => {
  function bench() {
    let doc = place(newDoc(), 'component.resistor', 0, 0).doc;
    doc = must(addWire(doc, t('PSU1', 'positive'), t('R1', 'a'))).doc;
    // A bend at (40,100) keeps the route clear of R1's own terminal a (a straight
    // horizontal-first route from R1.b would be drawn across it, which the check reports).
    doc = must(addWire(doc, t('R1', 'b'), t('GND1', 'ref'), [{ x: 40, y: 100 }])).doc;
    return must(addWire(doc, t('PSU1', 'negative'), t('GND1', 'ref'))).doc;
  }

  it('a correct circuit has no issues', () => {
    expect(checkCircuit(bench())).toEqual([]);
  });

  it("an auto-route drawn back across its own part's other terminal is reported", () => {
    let doc = place(newDoc(), 'component.resistor', 0, 0).doc;
    doc = must(addWire(doc, t('R1', 'b'), t('GND1', 'ref'))).doc; // (40,0) -> (-80,0) -> ... over R1.a
    expect(checkCircuit(doc)).toContainEqual({
      code: 'wire_over_terminal',
      severity: 'warning',
      components: ['R1'],
      terminals: ['a'],
      wire: 'W1',
    });
  });

  it('wholly unwired = info notice; partially wired = warning naming the open terminal', () => {
    let doc = place(bench(), 'component.led', 200, 200).doc;
    doc = place(doc, 'component.resistor', 200, 300).doc;
    doc = must(addWire(doc, t('R1', 'a'), t('R2', 'a'))).doc;
    const issues = checkCircuit(doc);
    expect(issues).toContainEqual({ code: 'not_connected', severity: 'info', components: ['D1'] });
    expect(issues).toContainEqual({
      code: 'partially_wired',
      severity: 'warning',
      components: ['R2'],
      terminals: ['b'],
    });
  });

  it('a connected island with no path to GND is flagged; no ground at all is flagged', () => {
    let doc = place(bench(), 'component.resistor', 200, 200).doc;
    doc = place(doc, 'component.led', 400, 200).doc;
    doc = must(addWire(doc, t('R2', 'b'), t('D1', 'anode'))).doc;
    doc = must(addWire(doc, t('D1', 'cathode'), t('R2', 'a'))).doc;
    expect(checkCircuit(doc)).toContainEqual({
      code: 'floating_island',
      severity: 'warning',
      components: ['R2', 'D1'],
    });
    const noGnd = must(deleteSelection(bench(), { ...emptySelection(), components: ['GND1'] })).doc;
    expect(checkCircuit(noGnd).map((i) => i.code)).toContain('no_ground');
  });

  it('a wire drawn across an unconnected terminal is reported and stays unconnected', () => {
    // R1 at (0,0) wired PSU1+ -> R1.a. Place R9 so its terminal b lies on that wire's route.
    let doc = place(newDoc(), 'component.resistor', 0, 0).doc;
    doc = must(addWire(doc, t('PSU1', 'positive'), t('R1', 'a'))).doc; // (-80,-20)->(-40,-20)->(-40,0)
    doc = place(doc, 'component.resistor', -100, -20).doc; // R2.b at (-60,-20): on the wire
    const issue = checkCircuit(doc).find((i) => i.code === 'wire_over_terminal');
    expect(issue).toMatchObject({ components: ['R2'], terminals: ['b'], wire: 'W1' });
    expect(doc.connections.some((c) => c.component === 'R2')).toBe(false); // no hidden connection
  });

  it('a supply shorted by a wire is flagged', () => {
    const doc = must(addWire(newDoc(), t('PSU1', 'positive'), t('PSU1', 'negative'))).doc;
    expect(checkCircuit(doc)).toContainEqual({
      code: 'psu_shorted_by_wire',
      severity: 'warning',
      components: ['PSU1'],
    });
  });

  it('checks are pure: the document is unchanged', () => {
    const doc = must(
      moveSelection(bench(), { ...emptySelection(), components: ['R1'] }, { x: 20, y: 0 }),
    ).doc;
    const before = JSON.stringify(doc);
    checkCircuit(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
