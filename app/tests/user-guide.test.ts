/**
 * TBI-020 slice 3: the beginner user guide (docs/product/USER-GUIDE.{en,he}.md) lists every
 * shortcut of the registry (as an HTML comment marker `shortcut:<id>`) and both languages have
 * the same structure (same heading count and level order, same number of shortcut lines).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHORTCUTS } from '../src/ui/shortcuts.js';

const read = (lang: 'en' | 'he') =>
  readFileSync(
    fileURLToPath(new URL(`../../docs/product/USER-GUIDE.${lang}.md`, import.meta.url)),
    'utf8',
  );
const headings = (md: string) => md.split('\n').filter((l) => /^#{1,6} /.test(l));

describe('user guide', () => {
  for (const lang of ['en', 'he'] as const) {
    it(`${lang}: contains every shortcut id of the registry, and nothing else`, () => {
      const md = read(lang);
      for (const s of SHORTCUTS) expect(md, s.id).toContain(`<!-- shortcut:${s.id} -->`);
      const ids = [...md.matchAll(/<!-- shortcut:(\w+) -->/g)].map((m) => m[1]);
      expect(ids.sort()).toEqual(SHORTCUTS.map((s) => s.id).sort());
    });

    it(`${lang}: has one h1 and no skipped heading level`, () => {
      const levels = headings(read(lang)).map((h) => h.indexOf(' '));
      expect(levels.filter((l) => l === 1)).toHaveLength(1);
      levels.forEach((l, i) => i > 0 && expect(l - levels[i - 1]!).toBeLessThanOrEqual(1));
    });
  }

  it('Hebrew and English have the same headings structure', () => {
    const en = headings(read('en'));
    const he = headings(read('he'));
    expect(he.length).toBe(en.length);
    expect(he.map((h) => h.indexOf(' '))).toEqual(en.map((h) => h.indexOf(' ')));
  });
});
