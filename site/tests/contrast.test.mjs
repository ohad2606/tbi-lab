import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'site.css'), 'utf8');
const root = css.match(/:root\s*{([^}]*)}/)[1];
const tok = Object.fromEntries(
  [...root.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2]]),
);

const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function lum(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function ratio(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground token, background token, minimum ratio, what]
const TEXT = [
  ['ink', 'bg', 4.5, 'body text'],
  ['ink', 'surface', 4.5, 'text on surface'],
  ['muted', 'bg', 4.5, 'muted text on card'],
  ['muted', 'surface', 4.5, 'muted text on surface'],
  ['link', 'bg', 4.5, 'link on white'],
  ['link', 'surface', 4.5, 'link on surface (footer)'],
  ['hero-text', 'hero-bg', 4.5, 'hero heading'],
  ['hero-muted', 'hero-bg', 4.5, 'hero value line'],
  ['accent', 'hero-bg', 4.5, 'hero eyebrow'],
  ['on-accent', 'accent', 4.5, 'primary button text'],
  ['bg', 'ink', 4.5, 'skip link'],
];
const UI = [
  ['border', 'bg', 3, 'card/header border on white'],
  ['border', 'surface', 3, 'card border on surface'],
  ['link', 'bg', 3, 'card accent stripe'],
  ['focus', 'bg', 3, 'focus ring on white'],
  ['focus', 'surface', 3, 'focus ring on surface'],
  ['focus-dark', 'hero-bg', 3, 'focus ring in hero'],
  ['accent', 'hero-bg', 3, 'dashed/primary button edge in hero'],
  ['ink', 'bg', 3, 'button edge on white band'],
];

describe('colour tokens', () => {
  it('parses the tokens', () => {
    expect(Object.keys(tok).length).toBeGreaterThanOrEqual(12);
  });
  it.each([...TEXT, ...UI])('%s on %s >= %s (%s)', (fg, bg, min) => {
    expect(ratio(tok[fg], tok[bg])).toBeGreaterThanOrEqual(min);
  });
  it('hover fills keep white text above 4.5:1', () => {
    expect(ratio('#ffffff', '#1a2d4d')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(tok['on-accent'], '#ffd96e')).toBeGreaterThanOrEqual(4.5);
  });
});
