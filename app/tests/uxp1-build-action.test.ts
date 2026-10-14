/**
 * Alpha UX-P1: the shared Build-action rules (toolbar, Run-blocked notice, code view).
 */
import { describe, expect, it } from 'vitest';
import type { ProjectDocument } from '@tbi-lab/domain';
import { EXAMPLES_WITH_DOCUMENTS as EXAMPLES } from '../src/examples/documents.js';
import {
  buildBlocker,
  onCodeViewRequest,
  programBoardOf,
  requestCodeView,
} from '../src/ui/buildAction.js';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';

const doc = (id: string) =>
  structuredClone(EXAMPLES.find((e) => e.id === id)!.document) as ProjectDocument;

describe('UX-P1 Build action', () => {
  it('the board with a program, exactly as the Code view; none for DC projects', () => {
    expect(programBoardOf(doc('esp32-blink'))).toBe('U1');
    expect(programBoardOf(doc('ohms-law'))).toBeUndefined();
    expect(programBoardOf(null)).toBeUndefined();
    // A program whose board was deleted is not offered.
    const d = doc('esp32-blink');
    d.components = d.components.filter((c) => c.id !== 'U1');
    expect(programBoardOf(d)).toBeUndefined();
  });

  it('unavailable: no service, read-only, while simulating, while an older build runs; else null', () => {
    const base = { available: true, readOnly: false, simulating: false, view: null };
    expect(buildBlocker(base)).toBeNull();
    expect(buildBlocker({ ...base, available: false })).toBe('build.unavailable');
    expect(buildBlocker({ ...base, readOnly: true })).toBe('toolbar.build.readOnly');
    expect(buildBlocker({ ...base, simulating: true })).toBe('build.blockedRunning');
    expect(buildBlocker({ ...base, view: { phase: 'required', olderBuildRunning: true } })).toBe(
      'build.olderRunning',
    );
    // A build in progress is not a "reason": the control shows it as busy instead.
    expect(buildBlocker({ ...base, view: { phase: 'building' } })).toBeNull();
  });

  it('a code-view request reaches every subscriber until it unsubscribes', () => {
    let n = 0;
    const off = onCodeViewRequest(() => n++);
    requestCodeView();
    off();
    requestCodeView();
    expect(n).toBe(1);
  });

  it('the toolbar texts exist in English and Hebrew ("Build" / "בנה קוד")', () => {
    expect(en['toolbar.build']).toBe('Build');
    expect(he['toolbar.build']).toBe('בנה קוד');
    for (const k of [
      'toolbar.build.group',
      'toolbar.build.readOnly',
      'toolbar.build.error',
      'toolbar.build.showProblems',
    ] as const) {
      expect(en[k], k).toBeTruthy();
      expect(he[k], k).toBeTruthy();
      expect(he[k]).not.toBe(en[k]);
    }
  });
});
