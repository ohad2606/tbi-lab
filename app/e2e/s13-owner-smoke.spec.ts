/**
 * Sprint 13 Owner Smoke findings (docs/sprints/SPRINT-13-OWNER-SMOKE.md), in the browser:
 * - OS-07: the sensor property inspector has no horizontal overflow (EN/HE, two window widths),
 *   and the workspace keeps its width;
 * - OS-06: the HC-SR04 distance is edited in plain metres (no "500m m"), its slider moves in
 *   monotonic 5 mm steps and the canvas shows the distance live;
 * - OS-03: dragging the LDR's light slider updates the simulation DURING the drag (bounded rate),
 *   and the released value is the one that stays;
 * - OS-04: a part dropped onto another is refused with its reason; the layout is unchanged.
 */
import { expect, test, type Page } from '@playwright/test';
import { component, goToProjects, storedProject, waitSaved } from './helpers.js';

/** A typed or shown quantity (`1.2k`, `500m`, `30`) as a number. */
const num = (s: string) => {
  const m = /^([\d.]+)([pnuµmkMG]?)$/.exec(s.trim());
  const f: Record<string, number> = {
    '': 1,
    p: 1e-12,
    n: 1e-9,
    u: 1e-6,
    µ: 1e-6,
    m: 1e-3,
    k: 1e3,
    M: 1e6,
    G: 1e9,
  };
  return m ? Number(m[1]) * f[m[2]!]! : NaN;
};

async function openExample(page: Page, id: string) {
  await page.goto('/');
  await expect(page.getByTestId('example-list').or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await page.getByTestId('example-list').isVisible())) await goToProjects(page);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
}

/** Horizontal overflow of the inspector (px), and the widest descendant beyond it, if any. */
async function inspectorOverflow(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('.inspector') as HTMLElement;
    const box = el.getBoundingClientRect();
    let worst = { by: 0, what: '' };
    for (const d of el.querySelectorAll<HTMLElement>('*')) {
      const r = d.getBoundingClientRect();
      if (r.width === 0) continue;
      const by = Math.max(r.right - box.right, box.left - r.left);
      if (by > worst.by)
        worst = { by, what: `${d.tagName}.${d.className} ${d.textContent?.slice(0, 40)}` };
    }
    return { scroll: el.scrollWidth - el.clientWidth, worst };
  });
}

/**
 * Reproduced 2026-10-12: the model <select> sized itself to its longest option (35-107 px past
 * the panel: PIR, LCD, DHT22, EN and HE, at every width), and a running simulation's "stop to
 * change" note did not wrap in a checkbox row (PIR motion). The HC-SR04 is included as checked.
 */
const SENSORS: [example: string, id: string, run: boolean][] = [
  ['esp32-motion-relay', 'U2', false],
  ['esp32-lcd-hello', 'DS1', false],
  ['esp32-thermo-hygrometer', 'U2', false],
  ['esp32-distance-alarm', 'U2', false],
  ['pir-alarm', 'U1', true],
  ['light-sensor', 'LDR1', true],
];
for (const width of [1400, 1024])
  for (const lang of ['en', 'he'])
    test(`OS-07: sensor inspectors without horizontal overflow (${lang}, ${width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 860 });
      for (const [example, id, run] of SENSORS) {
        await openExample(page, example);
        if (lang !== 'en') await page.getByTestId('language-select').selectOption(lang);
        const canvas = page.getByTestId('canvas');
        const before = (await canvas.boundingBox())!.width;
        if (run) {
          await page.getByTestId('sim-run').click();
          await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
        }
        await component(page, id).focus();
        await expect(page.locator('.inspector')).toBeVisible();
        const o = await inspectorOverflow(page);
        expect(o.scroll, `${example} ${id}: ${JSON.stringify(o.worst)}`).toBeLessThanOrEqual(0);
        expect(o.worst.by, `${example} ${id}: ${JSON.stringify(o.worst)}`).toBeLessThanOrEqual(1);
        // The main workspace keeps its width whatever is selected.
        expect((await canvas.boundingBox())!.width).toBeCloseTo(before, 0);
        if (run) await page.getByTestId('sim-stop').click();
        if (lang !== 'en') await page.getByTestId('language-select').selectOption('en');
      }
    });

test('OS-06: HC-SR04 distance in plain metres; slider in 5 mm steps; the canvas shows it', async ({
  page,
}) => {
  await openExample(page, 'esp32-distance-alarm');
  await component(page, 'U2').focus();
  const field = page.getByTestId('param-U2-distance');
  const slider = page.getByTestId('param-U2-distance-slider');
  await expect(field).not.toHaveValue(/m$/);
  await field.fill('0.3');
  await field.press('Enter');
  await expect(field).toHaveValue('0.3');
  await expect(page.locator('.value-label', { hasText: '300 mm' })).toHaveCount(1);
  // Keyboard steps: each moves the value by exactly 5 mm, monotonically.
  const values: number[] = [];
  for (let i = 0; i < 4; i++) {
    await slider.press('ArrowRight');
    values.push(Number(await field.inputValue()));
  }
  expect(values).toEqual([0.305, 0.31, 0.315, 0.32]);
  await expect(page.locator('.value-label', { hasText: '320 mm' })).toHaveCount(1);
});

test('OS-03: dragging the light slider updates the circuit during the drag; the release value stays', async ({
  page,
}) => {
  await openExample(page, 'light-sensor');
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  await component(page, 'LDR1').focus();
  const slider = page.getByTestId('param-LDR1-illuminance-slider');
  const field = page.getByTestId('param-LDR1-illuminance');
  const status = page.getByTestId('sim-status');
  const box = (await slider.boundingBox())!;
  const y = box.y + box.height / 2;
  const solvesAt = async () => Number(await status.getAttribute('data-solves'));
  await page.mouse.move(box.x + 4, y);
  await page.mouse.down();
  const start = await solvesAt();
  const t0 = Date.now();
  const seen: string[] = [];
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(box.x + 4 + ((box.width - 8) * i) / 20, y);
    await page.waitForTimeout(40);
    seen.push(await field.inputValue());
  }
  // Still pressed: the simulation has already re-solved with intermediate light levels.
  await expect.poll(solvesAt).toBeGreaterThan(start);
  const during = await solvesAt();
  const elapsed = Date.now() - t0;
  await page.mouse.up();
  // Bounded: at most one commit per 100 ms of dragging (plus the first, sent at once), whatever
  // the pointer rate (here 20 moves).
  expect(during - start).toBeLessThanOrEqual(Math.floor(elapsed / 100) + 1);
  expect(during - start).toBeLessThan(20);
  // The field followed the drag monotonically, and the released value is the stored one.
  const nums = seen.map(num);
  for (const n of nums) expect(n).not.toBeNaN();
  for (let i = 1; i < nums.length; i++) expect(nums[i]!).toBeGreaterThanOrEqual(nums[i - 1]!);
  // The release value (the right end: 10 000 lx) is the one stored.
  await expect(field).toHaveValue('10k');
  await waitSaved(page);
  await expect
    .poll(async () => {
      const v = (await storedProject(page)).components.find((c) => c.id === 'LDR1')!.params
        .illuminance as { value: number };
      return v.value;
    })
    .toBe(10_000);
  await page.getByTestId('sim-stop').click();
});

test('OS-04: a part dropped onto another is refused with its reason; nothing moves', async ({
  page,
}) => {
  await openExample(page, 'esp32-distance-alarm');
  await waitSaved(page);
  const layoutBefore = (await storedProject(page)).layout.components;
  const target = (await component(page, 'U2').boundingBox())!;
  const moving = component(page, 'R1');
  const from = (await moving.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('notice')).toContainText('would overlap');
  // The project's layout is unchanged (the selection outline changes the drawn box, not this).
  await waitSaved(page);
  expect((await storedProject(page)).layout.components).toEqual(layoutBefore);
});
