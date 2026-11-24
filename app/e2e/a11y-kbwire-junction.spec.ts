/**
 * A11Y-002 keyboard wiring, slice 5 (docs/a11y/keyboard-wiring-design.md sec 2.1 / 7.5):
 * a wire can be ended on an existing wire body (T-connection) or junction with the keyboard only.
 * - the candidate cycle (Tab / arrows) includes "a point on wire W{n}" and "existing junction J{n}",
 *   announced in the page language in the polite live region, with a visible ring (data-kb-candidate);
 * - Enter commits through the same domain call as the pointer (`addWire` with a wire / junction
 *   target): the wire is split, a junction is created, and the pin joins that wire's net;
 * - undo is one step (Ctrl+Z restores the document before the T).
 */
import { expect, test, type Page } from '@playwright/test';
import type { ProjectDocument } from '@tbi-lab/domain';
import { goToProjects, waitForStoredProject } from './helpers.js';

const TEXT = {
  en: {
    wire: /a point on wire W\d+ \(/,
    junction: /existing junction .?J\d+/,
    count: /, (\d+) of (\d+),/,
    nth: (n: number, total: number) => new RegExp(`, ${n} of ${total},`),
    start: /^Wire started from /,
    startOrNone: /^(Wire started from |No other pin)/,
    doneWire: /^Connected .+ to a point on wire W\d+/,
    doneJunction: /^Connected .+ to existing junction .?J\d+/,
  },
  he: {
    wire: /נקודה על חוט \d+ \(/,
    junction: /צומת קיים .?J\d+/,
    count: /, (\d+) מתוך (\d+),/,
    nth: (n: number, total: number) => new RegExp(`, ${n} מתוך ${total},`),
    start: /^התחלת חוט מ-/,
    startOrNone: /^(התחלת חוט מ-|אין פין אחר)/,
    doneWire: /^חובר .+ אל נקודה על חוט \d+/,
    doneJunction: /^חובר .+ אל צומת קיים .?J\d+/,
  },
};

async function openExample(page: Page, lang: 'en' | 'he') {
  await page.addInitScript((l) => localStorage.setItem('tbi-lab.locale', l), lang);
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('open-example-led-current').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
  return waitForStoredProject(page, (d) => d.layout.wires.length > 0, 'example stored');
}

/**
 * From each pin of each part in turn: W, arrows to the pin, Enter to start, then Tab through the
 * whole cycle until the announcement matches `want`. Leaves the mode on that candidate.
 * Returns the source pin, or fails when no pin offers such a target.
 */
async function cycleTo(page: Page, lang: 'en' | 'he', want: RegExp) {
  const t = TEXT[lang];
  const status = page.getByTestId('kbwire-status');
  const parts = page.locator('[data-hit="component"]');
  const n = await parts.count();
  for (let i = 0; i < n; i++) {
    const part = parts.nth(i);
    const id = (await part.getAttribute('data-id'))!;
    const pins = page.locator(`[data-hit="terminal"][data-component="${id}"]`);
    await part.focus();
    await page.keyboard.press('w');
    const count = await pins.count();
    for (let p = 0; p < count; p++) {
      if (p > 0) {
        await part.focus();
        await page.keyboard.press('w');
        for (let k = 0; k < p; k++) await page.keyboard.press('ArrowRight');
      }
      // Every step waits for its own announcement: the live region is cleared and refilled.
      await expect(pins.nth(p)).toBeFocused();
      const terminal = (await pins.nth(p).getAttribute('data-terminal'))!;
      await page.keyboard.press('Enter');
      await expect(status).toHaveText(t.startOrNone);
      if (!t.start.test((await status.textContent()) ?? '')) {
        await page.keyboard.press('Escape'); // no targets from this pin
        continue;
      }
      await page.keyboard.press('Tab');
      await expect(status).toHaveText(t.count);
      const m = t.count.exec((await status.textContent()) ?? '')!;
      let at = Number(m[1]);
      const total = Number(m[2]);
      for (let k = 0; k < total; k++) {
        const text = (await status.textContent()) ?? '';
        if (want.test(text)) return { component: id, terminal };
        await page.keyboard.press('Tab');
        at = (at % total) + 1;
        await expect(status).toHaveText(t.nth(at, total));
      }
      await page.keyboard.press('Escape');
    }
  }
  throw new Error(`no candidate matching ${want}`);
}

const netOf = (d: ProjectDocument, component: string, terminal: string) =>
  d.connections.find((c) => c.component === component && c.terminal === terminal)?.net;

for (const lang of ['en', 'he'] as const) {
  test(`A11Y-002 kbwire s5 (${lang}): end a wire on a wire body and on a junction, keyboard only, one-step undo`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const t = TEXT[lang];
    const before = await openExample(page, lang);
    const status = page.getByTestId('kbwire-status');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');

    // --- T on a wire body ---
    const src = await cycleTo(page, lang, t.wire);
    // The candidate point is visibly ringed (not colour only: dashed + filled ring).
    const point = page.locator('.kb-wire-point[data-kb-candidate="true"]');
    await expect(point).toHaveCount(1);
    await expect(page.locator('[data-kb-candidate="true"]')).toHaveCount(1);
    const splitWire = (await point.getAttribute('data-kb-wire'))!;
    // Slice 6: the whole target wire is outlined (dashed), and nothing else is.
    await expect(page.locator('.wire-group.kb-wire-target')).toHaveCount(1);
    await expect(page.locator('.wire-group.kb-wire-target')).toHaveAttribute('data-id', splitWire);
    const original = before.layout.wires.find((w) => w.id === splitWire)!;
    expect(original).toBeTruthy();
    await page.keyboard.press('Enter');
    await expect(status).toHaveText(t.doneWire);
    const after = await waitForStoredProject(
      page,
      (d) =>
        d.layout.wires.length === before.layout.wires.length + 2 &&
        d.layout.junctions.length === before.layout.junctions.length + 1,
      'wire split with a junction plus the new wire',
    );
    // Same electrical result as the pointer: the pin is now on the split wire's net.
    const end = original.from.kind === 'terminal' ? original.from : original.to;
    if (end.kind !== 'terminal') throw new Error('example wire has no pin end');
    expect(netOf(after, src.component, src.terminal)).toBeTruthy();
    expect(netOf(after, src.component, src.terminal)).toBe(
      netOf(after, end.component, end.terminal),
    );
    const added = after.layout.wires.at(-1)!;
    expect(added.from).toMatchObject({ kind: 'terminal', ...src });
    expect(added.to).toMatchObject({ kind: 'junction' });

    // Undo is one step: back to the example exactly (wires, junctions, nets).
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z');
    const undone = await waitForStoredProject(
      page,
      (d) =>
        d.layout.wires.length === before.layout.wires.length &&
        d.layout.junctions.length === before.layout.junctions.length,
      'undo restores the document before the T',
    );
    expect(undone.connections).toEqual(before.connections);
    await page.keyboard.press('Control+y');
    await waitForStoredProject(
      page,
      (d) => d.layout.junctions.length === before.layout.junctions.length + 1,
      'redo',
    );

    // --- End on the existing junction from another pin ---
    await page.getByTestId('canvas').focus();
    const src2 = await cycleTo(page, lang, t.junction);
    await expect(page.locator('.junction.kb-target[data-kb-candidate="true"]')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(status).toHaveText(t.doneJunction);
    const j = await waitForStoredProject(
      page,
      (d) => d.layout.wires.length === before.layout.wires.length + 3,
      'wire to the junction',
    );
    const last = j.layout.wires.at(-1)!;
    expect(last.from).toMatchObject({ kind: 'terminal', ...src2 });
    expect(last.to).toEqual({
      kind: 'junction',
      junction: added.to.kind === 'junction' ? added.to.junction : '',
    });
    expect(netOf(j, src2.component, src2.terminal)).toBe(netOf(j, end.component, end.terminal));
  });
}

test('A11Y-002 kbwire s5: no T-connection while the simulation runs', async ({ page }) => {
  const before = await openExample(page, 'en');
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  const status = page.getByTestId('kbwire-status');
  const part = page.locator('[data-hit="component"][data-id="R1"]');
  await part.focus();
  for (const key of ['w', 'ArrowRight', 'Enter', 'Tab', 'Tab', 'Enter'])
    await page.keyboard.press(key);
  await expect(status).toHaveText(/unavailable while the simulation runs/);
  await expect(page.locator('[data-kb-candidate="true"]')).toHaveCount(0);
  await page.waitForTimeout(300);
  const stored = await waitForStoredProject(page, () => true, 'stored');
  expect(stored.layout.wires).toHaveLength(before.layout.wires.length);
  expect(stored.layout.junctions).toHaveLength(before.layout.junctions.length);
});
