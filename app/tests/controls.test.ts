/**
 * The shared physical-control actions (controls.ts): which parts are controls, and their one
 * state (the document's switch position, the session's pressed set).
 */
import { describe, expect, it } from 'vitest';
import { setParam } from '@tbi-lab/domain';
import { place } from '../../packages/domain/tests/circuits.js';
import { must, newDoc } from '../../packages/domain/tests/helpers.js';
import { controlKind, controlState } from '../src/ui/controls.js';

describe('physical controls', () => {
  it('the toggle switch toggles, the push button is momentary; a sensor is not a physical control', () => {
    expect(controlKind('component.toggle_switch')).toBe('toggle');
    expect(controlKind('component.push_button')).toBe('momentary');
    expect(controlKind('component.resistor')).toBeNull();
    // The PIR's motion is an environment toggle in the Circuit view, never a 3D actuator.
    expect(controlKind('sensor.pir_hc_sr501')).toBe('toggle');
    expect(controlKind('sensor.pir_hc_sr501', true)).toBeNull();
  });

  it('state comes from the document (switch) and the session (button)', () => {
    let doc = place(newDoc(), 'component.toggle_switch', 100, 0).doc; // SW1
    doc = place(doc, 'component.push_button', 200, 0).doc; // SW2
    expect(controlState(doc, [], 'SW1')).toEqual({ kind: 'toggle', on: false });
    const closed = must(setParam(doc, 'SW1', 'closed', true)).doc;
    expect(controlState(closed, [], 'SW1')).toEqual({ kind: 'toggle', on: true });
    expect(controlState(doc, [], 'SW2')).toEqual({ kind: 'momentary', on: false });
    expect(controlState(doc, ['SW2'], 'SW2')).toEqual({ kind: 'momentary', on: true });
  });
});
