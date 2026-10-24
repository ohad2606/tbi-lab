/**
 * Product Alpha maintenance: browser acceptance for
 *   1. unambiguous project names (create / rename / duplicate / import),
 *   2. the parallel-PSU "not yet supported" diagnostic,
 *   3. one stateful Run/Stop control without layout shift,
 *   4. new supplies with the output enabled,
 *   5. the Projects-screen branding.
 * Persistence is checked in the real IndexedDB with polled predicates, never with sleeps.
 */
import { expect, test, type Page } from '@playwright/test';
import { SCHEMA_VERSION } from '@tbi-lab/domain';
import { drawLoop, link, run, setValue } from './circuits.js';
import {
  component,
  createProject,
  exportFromMenu,
  goToProjects,
  place,
  storedProjects,
  waitForStoredProject,
} from './helpers.js';

const names = async (page: Page) => (await storedProjects(page)).map((p) => p.name).sort();

async function goLibrary(page: Page) {
  await goToProjects(page);
  await expect(page.getByTestId('example-list')).toBeVisible();
}

async function setLocale(page: Page, code: string) {
  await page.getByTestId('language-select').selectOption(code);
  await expect(page.locator('html')).toHaveAttribute('lang', code);
}

const row = (page: Page, name: string) => page.locator(`.project-row[data-name="${name}"]`);

test.describe('1. project names', () => {
  test('create: a whitespace/case/Unicode-equivalent name is refused inline and nothing is created', async ({
    page,
  }) => {
    await createProject(page, 'Café Bench');
    await goLibrary(page);
    const field = page.getByTestId('new-project-name');
    for (const typed of ['  café bench ', 'CAFÉ  BENCH']) {
      await field.fill(typed);
      await page.getByTestId('create-project').click();
      const error = page.getByTestId('name-conflict');
      await expect(error).toBeVisible();
      await expect(error).toContainText('already exists');
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByTestId('canvas')).toHaveCount(0);
    }
    expect(await names(page)).toEqual(['Café Bench']);
    // Typing clears the message; the suggested default name never conflicts.
    await field.fill('Other bench');
    await expect(page.getByTestId('name-conflict')).toHaveCount(0);
  });

  test('rename: a conflicting name is refused inline, the project is unchanged; Hebrew message', async ({
    page,
  }) => {
    await createProject(page, 'Alpha');
    await goLibrary(page);
    await page.getByTestId('new-project-name').fill('Beta');
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('canvas')).toBeVisible();
    const beta = await waitForStoredProject(page, () => true, 'Beta stored', 'Beta');
    await goLibrary(page);
    await setLocale(page, 'he');
    await row(page, 'Beta').getByTestId('rename-project').click();
    await page.getByTestId('rename-input').fill(' alpha ');
    await page.getByTestId('rename-save').click();
    await expect(page.getByTestId('name-conflict')).toContainText('כבר קיים פרויקט בשם');
    const after = (await storedProjects(page)).find((p) => p.projectId === beta.projectId)!;
    expect(after).toEqual(beta); // same name, same revision
  });

  test('duplicate: deterministic copy numbering in English and Hebrew', async ({ page }) => {
    await createProject(page, 'Project');
    await goLibrary(page);
    for (const expected of ['Project (copy)', 'Project (copy 2)']) {
      await row(page, 'Project').getByTestId('duplicate-project').click();
      await expect(row(page, expected)).toBeVisible();
    }
    await setLocale(page, 'he');
    await row(page, 'Project').getByTestId('duplicate-project').click();
    await expect(row(page, 'Project (עותק)')).toBeVisible();
    await expect
      .poll(() => names(page))
      .toEqual(['Project', 'Project (copy 2)', 'Project (copy)', 'Project (עותק)'].sort());
  });

  test('import: importing an existing project again gets a copy-style name and says so', async ({
    page,
  }) => {
    await createProject(page, 'Bench');
    const download = await exportFromMenu(page);
    const text = await (
      await import('node:fs')
    ).promises.readFile((await download.path())!, 'utf8');
    await goLibrary(page);
    await page.getByTestId('import-file').setInputFiles({
      name: 'bench.tbilab',
      mimeType: 'application/json',
      buffer: Buffer.from(text, 'utf8'),
    });
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(page.getByTestId('notice')).toHaveAttribute('data-key', 'import.doneCopyRenamed');
    await expect(page.getByTestId('notice')).toContainText('Bench (copy)');
    await expect.poll(() => names(page)).toEqual(['Bench', 'Bench (copy)']);
  });
});

/** PSU1 and PSU2 outputs joined directly (+ to +, - to GND), with R1 as the load. */
async function drawParallelSupplies(page: Page) {
  await createProject(page, 'Parallel');
  await place(page, 'instrument.lab_psu', { x: -120, y: -140 });
  await place(page, 'component.resistor', { x: 60, y: 0 });
  await link(page, ['PSU1', 'positive'], ['R1', 'a']);
  await link(page, ['R1', 'b'], ['GND1', 'ref']);
  await link(page, ['PSU1', 'negative'], ['GND1', 'ref']);
  await link(page, ['PSU2', 'positive'], ['PSU1', 'positive']);
  await link(page, ['PSU2', 'negative'], ['PSU1', 'negative']);
  await setValue(page, 'PSU2', 'setpointVoltage', '3');
  await waitForStoredProject(
    page,
    (d) =>
      d.layout.wires.length === 5 &&
      (d.components.find((c) => c.id === 'PSU2')?.params.setpointVoltage as { value: number })
        ?.value === 3,
    'parallel supplies drawn',
  );
}

test('2. directly paralleled supplies: a clear "not yet supported" diagnosis, in English and Hebrew', async ({
  page,
}) => {
  await drawParallelSupplies(page);
  const bytes = JSON.stringify(await storedProjects(page));
  await run(page);
  const error = page.getByTestId('sim-error');
  await expect(error).toHaveAttribute('data-code', 'psu_parallel');
  const structured = page.getByTestId('sim-error-structured');
  await expect(structured.locator('.banner-title')).toHaveText(
    'Parallel power supplies are not yet supported',
  );
  // Component ids are isolated LTR runs (U+2066..U+2069) so they read correctly in any direction.
  const plain = async () => (await structured.innerText()).replace(/[\u2066-\u2069]/g, '');
  expect(await plain()).toContain('PSU1 and PSU2 are directly connected in parallel.');
  expect(await plain()).toContain('cannot determine a unique current sharing');
  await expect(structured.locator('.banner-hint')).toHaveText(
    'Use one supply, or separate the outputs with circuit elements.',
  );
  expect(await error.innerText()).not.toMatch(/singular|solver|matrix/i);
  await setLocale(page, 'he');
  await expect(structured.locator('.banner-title')).toHaveText('ספקי כוח במקביל עדיין אינם נתמכים');
  await expect(structured).toContainText('מחוברים ישירות במקביל');
  expect(await plain()).toContain('PSU1 ו-PSU2 מחוברים ישירות במקביל.'); // Intl list, Hebrew
  // No values were invented and nothing was written.
  await expect(page.getByTestId('sim-results')).toHaveCount(0);
  expect(JSON.stringify(await storedProjects(page))).toBe(bytes);
});

test.describe('3. one Run/Stop control', () => {
  /**
   * Geometry of the controls whose stability IS the Run/Stop requirement: the single control,
   * its status pill, and its immediate neighbours Undo and Redo. The save indicator is not one of
   * them: its label ("Saving…" / "All changes saved") changes width on its own (accepted backlog)
   * and, the toolbar being end-aligned, would move these neighbours. So every snapshot records the
   * save indicator's state and label too, and snapshots are only compared when that label is the
   * same settled "saved" label in both.
   */
  const layout = (page: Page) =>
    page.evaluate(() => {
      const box = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10);
      };
      const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);
      const save = q('save-state') as HTMLElement | null;
      return {
        save: `${save?.dataset.state}:${save?.textContent}`,
        controls: {
          toggle: box(document.querySelector('.sim-controls button')),
          status: box(q('sim-status')),
          undo: box(q('undo')),
          redo: box(q('redo')),
        },
      };
    });

  /**
   * The layout once everything that changes independently has settled: the simulation is in
   * `status`, the save indicator reads "saved", the stored project's revision no longer changes
   * (durable in IndexedDB) and two consecutive reads agree. Polled, never slept.
   */
  async function settled(page: Page, status: 'stopped' | 'running') {
    await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', status);
    let previous = '';
    let result: Awaited<ReturnType<typeof layout>> | undefined;
    await expect
      .poll(
        async () => {
          const l = await layout(page);
          const revs = (await storedProjects(page)).map((d) => d.revision.localRevision).join(',');
          const key = JSON.stringify([l, revs]);
          const steady = key === previous && l.save.startsWith('saved:');
          previous = key;
          result = l;
          return steady;
        },
        { message: `toolbar settled (${status}, save state "saved", project durable)` },
      )
      .toBe(true);
    return result!;
  }

  for (const [locale, runText, stopText] of [
    ['en', 'Run', 'Stop'],
    ['he', 'הרצה', 'עצירה'],
  ] as const) {
    test(`${locale}: Run -> Stop -> Run on the same button, keyboard-operable, no layout shift`, async ({
      page,
    }) => {
      await drawLoop(page, { ohms: '1k' }, 'Toggle'); // a runnable circuit: Run really runs
      await setLocale(page, locale);
      const controls = page.locator('.sim-controls button');
      await expect(controls).toHaveCount(1);
      const button = page.getByRole('button', { name: runText, exact: true });
      await expect(button).toHaveAttribute('data-action', 'run');
      await expect(page.getByRole('button', { name: stopText, exact: true })).toHaveCount(0);
      const stopped = await settled(page, 'stopped');

      // Run -> Stop: same element, same place and size; the neighbours do not move.
      await button.click();
      const stop = page.getByRole('button', { name: stopText, exact: true });
      await expect(stop).toHaveAttribute('data-action', 'stop');
      await expect(page.getByRole('button', { name: runText, exact: true })).toHaveCount(0);
      await expect(controls).toHaveCount(1);
      const running = await settled(page, 'running');
      expect(running.save).toBe(stopped.save); // same settled save label: it cannot explain a shift
      expect(running.controls).toEqual(stopped.controls);

      // Stop -> Run by keyboard: focus stays on the control, nothing moves.
      await stop.focus();
      await page.keyboard.press('Enter');
      await expect(controls.first()).toBeFocused();
      await expect(controls.first()).toHaveAccessibleName(runText);
      const stoppedAgain = await settled(page, 'stopped');
      expect(stoppedAgain.save).toBe(stopped.save);
      expect(stoppedAgain.controls).toEqual(stopped.controls);

      // Run -> Stop by keyboard (Space), then back.
      await page.keyboard.press('Space');
      await expect(controls.first()).toHaveAccessibleName(stopText);
      await expect(controls.first()).toBeFocused();
      expect((await settled(page, 'running')).controls).toEqual(stopped.controls);
      await page.keyboard.press('Enter');
      await expect(controls.first()).toHaveAttribute('data-action', 'run');
      await expect(controls).toHaveCount(1);
    });
  }

  test('state is not conveyed by colour alone: icon and text change together', async ({ page }) => {
    await drawLoop(page, { ohms: '1k' }, 'Faces');
    const button = page.locator('.sim-controls button');
    const visibleFace = () =>
      button.evaluate((b) => {
        const face = [...b.querySelectorAll<HTMLElement>('.sim-toggle-face')].find(
          (f) => getComputedStyle(f).visibility === 'visible',
        )!;
        return { text: face.textContent, icon: face.querySelector('svg > *')!.tagName };
      });
    expect(await visibleFace()).toEqual({ text: 'Run', icon: 'path' });
    await button.click();
    await expect(button).toHaveAttribute('data-action', 'stop');
    expect(await visibleFace()).toEqual({ text: 'Stop', icon: 'rect' });
  });
});

test('4. a new supply has its output on: the first Run of a simple circuit needs no Output click', async ({
  page,
}) => {
  await createProject(page, 'First run');
  await component(page, 'PSU1').locator('.component-hit').click();
  await expect(page.getByTestId('param-PSU1-outputEnabled')).toBeChecked();
  await place(page, 'component.resistor', { x: 60, y: 0 });
  await link(page, ['PSU1', 'positive'], ['R1', 'a']);
  await link(page, ['R1', 'b'], ['GND1', 'ref']);
  await link(page, ['PSU1', 'negative'], ['GND1', 'ref']);
  const doc = await waitForStoredProject(page, (d) => d.layout.wires.length === 3, 'loop drawn');
  expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
  expect(doc.components[0]!.params.outputEnabled).toBe(true);
  await run(page);
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId('result-PSU1')).toHaveText(/ · CV$/);
  // A supply placed from the palette is on as well.
  await page.getByTestId('sim-stop').click();
  await place(page, 'instrument.lab_psu', { x: -120, y: -160 });
  await component(page, 'PSU2').locator('.component-hit').click();
  await expect(page.getByTestId('param-PSU2-outputEnabled')).toBeChecked();
});

test('5. Projects screen: the full TBI Lab logo, transparent and prominent, in both locales', async ({
  page,
}) => {
  await createProject(page, 'Brand');
  await goLibrary(page);
  const logo = page.locator('.brand-hero-logo');
  for (const [locale, alt, title] of [
    ['en', /^TBI Lab: Think/, 'Projects'],
    ['he', /^TBI Lab: חושבים/, 'פרויקטים'],
  ] as const) {
    await setLocale(page, locale);
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute('alt', alt);
    await expect(page.locator('.brand-hero h1')).toHaveText(title);
    const info = await logo.evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const corner = g.getImageData(0, 0, 1, 1).data[3];
      const r = img.getBoundingClientRect();
      return {
        src: img.currentSrc,
        natural: [img.naturalWidth, img.naturalHeight],
        height: Math.round(r.height),
        width: Math.round(r.width),
        cornerAlpha: corner,
      };
    });
    expect(info.src).toMatch(/tbi-lab-logo/);
    expect(info.natural).toEqual([520, 300]);
    expect(info.height).toBe(150); // was 100 px before this pass
    expect(info.width).toBeGreaterThan(info.height * 1.6); // the elongated logo, not the round mark
    expect(info.cornerAlpha).toBe(0); // real transparency over the navy band
  }
  // The logo sits on the leading side in both directions (flex follows the text direction).
  const side = async () => {
    const [l, h] = await Promise.all([
      logo.boundingBox(),
      page.locator('.brand-hero h1').boundingBox(),
    ]);
    return l!.x < h!.x ? 'left' : 'right';
  };
  expect(await side()).toBe('right'); // Hebrew (current)
  await setLocale(page, 'en');
  expect(await side()).toBe('left');
});
