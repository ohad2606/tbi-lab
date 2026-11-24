/**
 * K9 + A11Y-CHEAP: structural accessibility rules checked on the sources (no DOM in this suite).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

describe('K9 a11y', () => {
  it('canvas views are role=group (children stay reachable), still labelled', () => {
    for (const f of ['ui/SchematicView.tsx', 'ui/ThreeView.tsx']) {
      const s = src(f);
      expect(s, f).not.toContain('role="img"');
      expect(s, f).toMatch(/role="group"\s+aria-label=\{t\('(schematic|view3d)\.aria'/);
    }
  });

  it('the simulated-time readout is not inside a live region', () => {
    const s = src('ui/SimControls.tsx');
    const status = s.indexOf('role="status"');
    const time = s.indexOf('data-testid="sim-time"');
    expect(time).toBeGreaterThan(-1);
    // The status span closes before the clock: the clock precedes the live span in the source.
    expect(time).toBeLessThan(status);
    const m = src('ui/McuTerminal.tsx');
    const live = m.slice(m.indexOf('data-testid="mcu-terminal-state"'));
    const stateSpan = live.slice(0, live.indexOf('{seconds !== null'));
    expect(stateSpan).not.toContain('simTime');
    expect(m.indexOf('mcu-terminal-time')).toBeGreaterThan(m.indexOf('{seconds !== null'));
    expect(m).toContain('data-testid="mcu-terminal-time"');
  });

  it('skip link is first in the app shell and targets a focusable main', () => {
    const app = src('ui/App.tsx');
    expect(app.indexOf('skip-link')).toBeGreaterThan(-1);
    expect(app.indexOf('skip-link')).toBeLessThan(
      app.indexOf('<EnvironmentNotes />', app.indexOf('class="app"')),
    );
    expect(app).toContain('href="#main"');
    const ed = src('ui/Editor.tsx');
    expect(ed).toMatch(/<main[^>]*id="main"[^>]*tabIndex=\{-1\}/);
    expect(ed).toMatch(/<h1 class="visually-hidden"/);
    for (const m of [en, he]) {
      expect(m['a11y.skipToMain']).toBeTruthy();
      expect(m['editor.heading']).toBeTruthy();
    }
    expect(src('styles.css')).toMatch(/\.skip-link:focus/);
  });

  it('reduced motion covers every animation and transition', () => {
    const css = src('styles.css');
    const blocks = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) ?? [];
    const all = blocks.join('\n');
    expect(all).toContain('.build-icon.spinning');
    expect(all).toContain('.mcu-terminal-chevron');
    const uses = (css.match(/^\s*(?:animation|transition)[a-z-]*:.*$/gm) ?? []).filter(
      (l) => !/:\s*none/.test(l),
    );
    expect(uses.length).toBe(2);
  });
});
