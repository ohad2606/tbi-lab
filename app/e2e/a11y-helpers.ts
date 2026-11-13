/**
 * Accessibility test helpers (a11y-audit branch): axe-core scans at the WCAG 2.2 AA tag set, a
 * compact result format, and the known-violations baseline (app/e2e/a11y-baseline.json) whose
 * entries carry the gap-register ID they are tracked under.
 *
 * axe-core finds only part of the WCAG failures (roughly a third to a half of success criteria
 * can be tested automatically at all, and then only partly). A green scan is NOT a conformance
 * claim; it is a regression gate. Manual and assistive-technology testing remain required.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export interface CompactViolation {
  id: string;
  impact: string | null | undefined;
  help: string;
  tags: string[];
  nodes: { target: string; summary: string }[];
}

/** Where scans write their JSON (unset: nowhere). */
export const OUT_DIR = process.env.TBI_A11Y_OUT;

/** Run axe on the page (optionally limited to a selector) and return compact violations. */
export async function scan(
  page: Page,
  options: { include?: string; exclude?: string[] } = {},
): Promise<CompactViolation[]> {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (options.include) builder = builder.include(options.include);
  for (const x of options.exclude ?? []) builder = builder.exclude(x);
  const result = await builder.analyze();
  return result.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    tags: v.tags.filter((t) => t.startsWith('wcag')),
    nodes: v.nodes.map((n) => ({
      target: n.target.map(String).join(' >> '),
      summary: (n.failureSummary ?? '').split('\n').slice(0, 3).join(' | ').slice(0, 300),
    })),
  }));
}

export function writeJson(name: string, value: unknown): void {
  if (!OUT_DIR) return;
  const file = join(OUT_DIR, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 1));
}

interface BaselineEntry {
  /** Gap-register ID (docs: accessibility assessment), e.g. "A11Y-007". */
  gap: string;
  rule: string;
  /** Screen key as used by the spec, or "*" for every screen. */
  screen: string;
  /** Substring of the axe target selector, or "*" for any node. */
  target: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE: BaselineEntry[] = (
  JSON.parse(readFileSync(join(here, 'a11y-baseline.json'), 'utf8')) as {
    entries: BaselineEntry[];
  }
).entries;

/** Violation nodes NOT covered by the baseline: these fail the gate. */
export function unbaselined(screen: string, violations: CompactViolation[]): string[] {
  const out: string[] = [];
  for (const v of violations)
    for (const n of v.nodes) {
      const known = BASELINE.some(
        (b) =>
          b.rule === v.id &&
          (b.screen === '*' || b.screen === screen) &&
          (b.target === '*' || n.target.includes(b.target)),
      );
      if (!known) out.push(`${v.id} [${v.impact}] ${n.target} :: ${n.summary}`);
    }
  return out;
}
