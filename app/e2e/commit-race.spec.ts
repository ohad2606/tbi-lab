/**
 * Regression for the CI failure on b79e42f (GitHub Actions run 35789744836): a value typed and
 * committed (Enter or Blur) before the UI framework flushed its pending state render was lost,
 * because the commit read component state instead of the input's actual value.
 *
 * These tests remove timing luck entirely: the new value, the `input` event and the commit
 * (Enter keydown or blur) are dispatched synchronously in ONE task, so no render can run in
 * between. No sleeps or waits are involved.
 */
import { chromium, expect, test, type Locator, type Page } from '@playwright/test';
import type { ProjectDocument } from '@tbi-lab/domain';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  component,
  createProject,
  place,
  reopenFromLibrary,
  storedProject,
  waitForStoredProject,
  waitSaved,
} from './helpers.js';

type Commit = 'enter' | 'blur';

/** Type a value and commit it in the same task: the fastest possible user/event sequence. */
async function typeAndCommitNow(field: Locator, value: string, how: Commit): Promise<void> {
  await field.evaluate(
    (el, [v, h]) => {
      const input = el as HTMLInputElement;
      input.focus();
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (h === 'enter') {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      } else {
        input.blur();
      }
    },
    [value, how] as const,
  );
}

async function resistorBench(page: Page): Promise<Locator> {
  await createProject(page, 'Commit race');
  await place(page, 'component.resistor', { x: 0, y: 0 });
  await waitForStoredProject(page, (d) => d.components.some((c) => c.id === 'R1'), 'R1 placed');
  await waitSaved(page);
  await component(page, 'R1').locator('.component-hit').click();
  return page.getByTestId('param-R1-resistance');
}

const is4k7 = (d: ProjectDocument) =>
  JSON.stringify(d.components.find((c) => c.id === 'R1')?.params.resistance) ===
  JSON.stringify({ value: 4700, unit: 'ohm' });

const resistance = async (page: Page) =>
  (await storedProject(page)).components.find((c) => c.id === 'R1')!.params.resistance;

for (const how of ['enter', 'blur'] as const) {
  test(`a valid value committed immediately by ${how} is applied and persisted`, async ({
    page,
  }) => {
    const field = await resistorBench(page);
    await typeAndCommitNow(field, '4k7', how);
    await expect(page.getByTestId('value-R1')).toHaveText('4.7 kΩ');
    await waitForStoredProject(page, is4k7, 'R1 = 4.7 kΩ');
  });

  test(`an invalid localized value committed immediately by ${how} shows the Hebrew error`, async ({
    page,
  }) => {
    const field = await resistorBench(page);
    await page.getByTestId('language-select').selectOption('he');
    const before = (await storedProject(page)).revision.localRevision;
    await typeAndCommitNow(field, '1,5k', how);
    await expect(page.getByTestId('param-R1-resistance-error')).toContainText('נקודה');
    await waitSaved(page);
    expect(await resistance(page)).toEqual({ value: 1000, unit: 'ohm' });
    expect((await storedProject(page)).revision.localRevision).toBe(before);
  });
}

test('the PSU setpoint committed immediately by Enter persists (the CI A5 case)', async ({
  page,
}) => {
  await createProject(page, 'PSU commit');
  await component(page, 'PSU1').locator('.component-hit').click();
  await typeAndCommitNow(page.getByTestId('param-PSU1-setpointVoltage'), '3.3', 'enter');
  const stored = await waitForStoredProject(
    page,
    (d) => (d.components[0]!.params.setpointVoltage as { value: number }).value === 3.3,
    'PSU1 setpoint = 3.3 V',
  );
  expect(stored.components[0]!.params.setpointVoltage).toEqual({
    value: 3.3,
    unit: 'volt',
  });
});

test('the project name committed immediately by Enter persists; Escape still cancels', async ({
  page,
}) => {
  await createProject(page, 'Old name');
  const name = page.getByTestId('project-name');
  await typeAndCommitNow(name, 'New name', 'enter');
  await waitForStoredProject(page, (d) => d.name === 'New name', 'renamed');
  await name.evaluate((el) => {
    const input = el as HTMLInputElement;
    input.focus();
    input.value = 'Discarded';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await expect(name).toHaveValue('New name');
  await waitSaved(page);
  expect((await storedProject(page)).name).toBe('New name');
});

test('a new project name submitted immediately by Enter is the one created', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-project-name').evaluate((el) => {
    const input = el as HTMLInputElement;
    input.focus();
    input.value = 'מעגל מהיר';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form!.requestSubmit();
  });
  await expect(page.getByTestId('project-name')).toHaveValue('מעגל מהיר');
  await waitForStoredProject(page, (d) => d.name === 'מעגל מהיר', 'project created');
});

test('a value committed immediately survives a full browser restart (the CI A7 case)', async ({
  baseURL,
}) => {
  const profile = await mkdtemp(join(tmpdir(), 'tbi-lab-commit-race-'));
  const viewport = { width: 1400, height: 860 };
  try {
    let context = await chromium.launchPersistentContext(profile, { baseURL: baseURL!, viewport });
    let page = context.pages()[0] ?? (await context.newPage());
    const field = await resistorBench(page);
    await typeAndCommitNow(field, '4k7', 'enter');
    await waitForStoredProject(page, is4k7, 'R1 = 4.7 kΩ before the restart');
    await context.close();

    context = await chromium.launchPersistentContext(profile, { baseURL: baseURL!, viewport });
    page = context.pages()[0] ?? (await context.newPage());
    await page.goto('/');
    await reopenFromLibrary(page); // the app opens on Projects (S6)
    await expect(page.getByTestId('value-R1')).toHaveText('4.7 kΩ');
    expect(await resistance(page)).toEqual({ value: 4700, unit: 'ohm' });
    await context.close();
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

/**
 * Second CI finding (run 35828605417): with Hebrew active BEFORE the editor opens, an invalid
 * value entered right after the field appeared lost its error. Cause: the field's mount-time
 * effect (run after paint) reset draft and error, wiping what was typed meanwhile.
 */
async function hebrewEditorWithR1(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('language-select').selectOption('he');
  await page.getByTestId('create-project').click();
  await waitForStoredProject(page, (d) => d.components.length === 2, 'project created');
}

/** Two animation frames: long enough for post-paint effects to have run. No fixed delay. */
const nextFrames = (page: Page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

test('Hebrew active first: invalid value typed the instant the field mounts keeps its error', async ({
  page,
}) => {
  await hebrewEditorWithR1(page);
  // Arm: as soon as the resistance field is inserted, type and press Enter in the same task,
  // before any post-paint effect of the new field can run.
  await page.evaluate(() => {
    const obs = new MutationObserver(() => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="param-R1-resistance"]');
      if (!input) return;
      obs.disconnect();
      input.focus();
      input.value = '1,5k';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      (window as unknown as { __typed: boolean }).__typed = true;
    });
    obs.observe(document.body, { childList: true, subtree: true });
  });
  await place(page, 'component.resistor', { x: 0, y: 0 });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __typed?: boolean }).__typed))
    .toBe(true);
  await nextFrames(page);
  await expect(page.getByTestId('param-R1-resistance-error')).toContainText('נקודה');
  await expect(page.getByTestId('param-R1-resistance')).toHaveValue('1,5k');
});

test('Hebrew active first: invalid value, immediate real Enter, localized error remains visible', async ({
  page,
}) => {
  await hebrewEditorWithR1(page);
  await place(page, 'component.resistor', { x: 0, y: 0 });
  await waitForStoredProject(page, (d) => d.components.some((c) => c.id === 'R1'), 'R1 placed');
  await component(page, 'R1').locator('.component-hit').click();
  const field = page.getByTestId('param-R1-resistance');
  // Real keyboard, no wait for the field's initial value to render first.
  await field.fill('1,5k');
  await field.press('Enter');
  const error = page.getByTestId('param-R1-resistance-error');
  await expect(error).toContainText('נקודה');
  await nextFrames(page);
  await expect(error).toContainText('נקודה');
  await expect(field).toHaveValue('1,5k');
  expect(await resistance(page)).toEqual({ value: 1000, unit: 'ohm' });
});
