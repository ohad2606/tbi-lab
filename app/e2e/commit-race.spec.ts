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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { component, createProject, place, storedProject, waitSaved } from './helpers.js';

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
  await waitSaved(page);
  await component(page, 'R1').locator('.component-hit').click();
  return page.getByTestId('param-R1-resistance');
}

const resistance = async (page: Page) =>
  (await storedProject(page)).components.find((c) => c.id === 'R1')!.params.resistance;

for (const how of ['enter', 'blur'] as const) {
  test(`a valid value committed immediately by ${how} is applied and persisted`, async ({
    page,
  }) => {
    const field = await resistorBench(page);
    await typeAndCommitNow(field, '4k7', how);
    await expect(page.getByTestId('value-R1')).toHaveText('4.7 kΩ');
    await waitSaved(page);
    expect(await resistance(page)).toEqual({ value: 4700, unit: 'ohm' });
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
  await waitSaved(page);
  expect((await storedProject(page)).components[0]!.params.setpointVoltage).toEqual({
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
  await waitSaved(page);
  expect((await storedProject(page)).name).toBe('New name');
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
  await waitSaved(page);
  expect((await storedProject(page)).name).toBe('מעגל מהיר');
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
    await waitSaved(page);
    expect(await resistance(page)).toEqual({ value: 4700, unit: 'ohm' });
    await context.close();

    context = await chromium.launchPersistentContext(profile, { baseURL: baseURL!, viewport });
    page = context.pages()[0] ?? (await context.newPage());
    await page.goto('/');
    await expect(page.getByTestId('value-R1')).toHaveText('4.7 kΩ');
    expect(await resistance(page)).toEqual({ value: 4700, unit: 'ohm' });
    await context.close();
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
