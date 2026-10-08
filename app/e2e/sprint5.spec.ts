/**
 * Sprint 5 acceptance (Product Alpha) in real Chromium: project library, portable export and
 * import, the six examples against the production engine, error UX, localization and races.
 * Durability is always proven on the REAL IndexedDB, never on the "saved" indicator.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  createSnapshot,
  parsePackage,
  projectHash,
  type ProjectDocument,
  type ProjectPackage,
} from '@tbi-lab/domain';
import { EngineSession, type SolveSuccess } from '@tbi-lab/engine';
import { getLocale } from '../src/i18n/i18n.js';
import { formatResult } from '../src/sim/format.js';
import { run, setValue } from './circuits.js';
import {
  component,
  createProject,
  exportFromMenu,
  goToProjects,
  storedProjects,
  scannedText,
} from './helpers.js';

const en = getLocale('en');
const A = (v: number) => formatResult(en, v, 'ampere');
const V = (v: number) => formatResult(en, v, 'volt');
const select = (page: Page, id: string) => component(page, id).locator('.component-hit').click();
const plain = (s: string | null) => (s ?? '').replace(/[‎‏⁦-⁩]/g, '');

test.beforeEach(({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

/** The id of the project the app has open (its own last-project preference). */
const openProjectId = (page: Page) =>
  page.evaluate(() => localStorage.getItem('tbi-lab.lastProject') ?? '');

async function stored(page: Page, projectId: string): Promise<ProjectDocument | undefined> {
  return (await storedProjects(page)).find((p) => p.projectId === projectId);
}

async function waitStored(
  page: Page,
  projectId: string,
  predicate: (d: ProjectDocument) => boolean,
  what: string,
): Promise<ProjectDocument> {
  let match: ProjectDocument | undefined;
  await expect
    .poll(
      async () => {
        const d = await stored(page, projectId);
        match = d && predicate(d) ? d : undefined;
        return !!match;
      },
      { message: `stored ${projectId}: ${what}` },
    )
    .toBe(true);
  return match!;
}

async function goLibrary(page: Page) {
  await goToProjects(page);
  await expect(page.getByTestId('example-list')).toBeVisible();
}

const row = (page: Page, projectId: string) => page.getByTestId(`project-${projectId}`);

async function exportCurrent(page: Page): Promise<string> {
  const download = await exportFromMenu(page);
  expect(download.suggestedFilename()).toMatch(/\.tbilab$/);
  return readFileSync((await download.path())!, 'utf8');
}

async function importText(page: Page, text: string, name = 'project.tbilab') {
  await page.getByTestId('import-file').setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(text, 'utf8'),
  });
}

/** Load the app and show the library, whatever it reopened. */
async function startInLibrary(page: Page) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goLibrary(page);
}

async function openExample(page: Page, id: string): Promise<string> {
  const before = await openProjectId(page);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect.poll(() => openProjectId(page)).not.toBe(before);
  const projectId = await openProjectId(page);
  await waitStored(page, projectId, () => true, `example ${id} stored`);
  return projectId;
}

function truth(doc: ProjectDocument, pressed: string[] = []): SolveSuccess {
  const s = new EngineSession(createSnapshot(doc));
  for (const id of pressed) s.setMomentary(id, true);
  const o = s.solve();
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  return o;
}

const reading = (page: Page, name: string) =>
  page.getByTestId(`probe-reading-${name}`).textContent().then(plain);

// ------------------------------------------------------------------------------------------

test('A1-A3: library create, rename, duplicate, delete (with confirmation) survive a restart', async ({
  page,
}) => {
  await createProject(page, 'Alpha');
  const alpha = await openProjectId(page);
  await createProject(page, 'Beta');
  const beta = await openProjectId(page);
  await goLibrary(page);

  // Rename from the library: same identity, a new revision, stored before the list updates.
  const betaBefore = (await stored(page, beta))!;
  await row(page, beta).getByTestId('rename-project').click();
  await row(page, beta).getByTestId('rename-input').fill('Beta — בטא');
  await row(page, beta).getByTestId('rename-save').click();
  const renamed = await waitStored(page, beta, (d) => d.name === 'Beta — בטא', 'renamed');
  expect(renamed.revision.localRevision).toBe(betaBefore.revision.localRevision + 1);
  await expect(row(page, beta)).toHaveAttribute('data-name', 'Beta — בטא');

  // Duplicate: a new, independent project with identical engineering content.
  await row(page, alpha).getByTestId('duplicate-project').click();
  await expect(page.getByTestId('notice')).toHaveAttribute('data-key', 'library.duplicated');
  const copy = (await storedProjects(page)).find((p) => p.name === 'Alpha (copy)')!;
  expect(copy.projectId).not.toBe(alpha);
  expect(copy.components).toEqual((await stored(page, alpha))!.components);

  // Delete asks first. Escape and "Keep project" both keep it.
  await row(page, alpha).getByTestId('delete-project').click();
  await expect(page.getByTestId('delete-dialog')).toBeVisible();
  await expect(page.getByTestId('delete-cancel')).toBeFocused(); // the safe choice
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('delete-dialog')).toHaveCount(0);
  expect(await stored(page, alpha)).toBeDefined();
  await row(page, alpha).getByTestId('delete-project').click();
  await page.getByTestId('delete-confirm').click();
  await expect
    .poll(async () => (await storedProjects(page)).map((p) => p.projectId).sort())
    .toEqual([beta, copy.projectId].sort());
  await expect(row(page, alpha)).toHaveCount(0);

  // A full reload (the app restarts from IndexedDB) shows exactly the same library.
  await page.reload();
  const home = page.getByTestId('example-list');
  // Wait for the app to render before choosing a branch (an immediate isVisible() can run
  // before the restarted app shows anything; seen once in the full run of 0bc0e98).
  await expect(home.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await home.isVisible())) await goLibrary(page);
  await expect(row(page, beta)).toHaveAttribute('data-name', 'Beta — בטא');
  await expect(row(page, copy.projectId)).toBeVisible();
  await expect(row(page, alpha)).toHaveCount(0);
});

test('A1/A3: the library works from the keyboard alone, including the delete dialog', async ({
  page,
}) => {
  await createProject(page, 'Keyboard');
  const id = await openProjectId(page);
  await goLibrary(page);
  await row(page, id).getByTestId('open-project').focus();
  await page.keyboard.press('Tab'); // Rename
  await page.keyboard.press('Tab'); // Duplicate
  await page.keyboard.press('Tab'); // Export
  await page.keyboard.press('Tab'); // Delete
  await expect(row(page, id).getByTestId('delete-project')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('delete-cancel')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('delete-confirm')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await storedProjects(page)).length).toBe(0);
  // Open a project with the keyboard.
  await page.getByTestId('open-example-ohms-law').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('canvas')).toBeVisible();
});

test('A4-A6: export -> delete -> import restores the exact project; no runtime state exported', async ({
  page,
}) => {
  await startInLibrary(page);
  const id = await openExample(page, 'cc-mode');
  await run(page);
  await page.getByTestId('actuator-SW1').click(); // a persistent, live toggle edit
  const edited = await waitStored(
    page,
    id,
    (d) => d.components.find((c) => c.id === 'SW1')!.params.closed === true,
    'SW1 closed',
  );
  // Export while running, with suggested probes on the canvas.
  const text = await exportCurrent(page);
  const pkg = JSON.parse(text) as ProjectPackage;
  expect(pkg.format).toBe('tbi-lab.package');
  expect(pkg.formatVersion).toBe(2);
  expect([pkg.source, pkg.firmware, pkg.toolchain]).toEqual([null, null, null]);
  expect(pkg.project).toEqual(edited);
  expect(pkg.integrity.project).toBe(projectHash(edited));
  for (const word of ['probe', 'pressed', 'outcome', 'result', 'history', 'selection']) {
    expect(text.toLowerCase()).not.toContain(`"${word}`);
  }
  await page.getByTestId('sim-stop').click();

  await goLibrary(page);
  await row(page, id).getByTestId('delete-project').click();
  await page.getByTestId('delete-confirm').click();
  await expect.poll(() => stored(page, id)).toBeUndefined();

  await importText(page, text, 'cc.tbilab');
  await expect(page.getByTestId('notice')).toHaveAttribute('data-key', 'import.done');
  await expect(page.getByTestId('canvas')).toBeVisible();
  expect(await stored(page, id)).toEqual(edited); // byte-for-byte the same engineering project
  await expect(component(page, 'SW1')).toHaveAttribute('data-closed', 'true');
});

test('A7: malformed, damaged, future and oversized files are refused before anything is written', async ({
  page,
}) => {
  await createProject(page, 'Keeper');
  const text = await exportCurrent(page);
  await goLibrary(page);
  const before = JSON.stringify(await storedProjects(page));
  const good = JSON.parse(text) as Record<string, unknown> & { project: Record<string, unknown> };
  const cases: [string, string][] = [
    ['{ this is not json', 'import.error.not_package'],
    [JSON.stringify({ hello: 'world' }), 'import.error.not_package'],
    [JSON.stringify({ ...good, formatVersion: 3 }), 'import.error.newer'],
    [
      JSON.stringify({ ...good, project: { ...good.project, name: 'Changed' } }),
      'import.error.damaged',
    ],
    [text.replace('"schemaVersion": 3', '"schemaVersion": 4'), 'import.error.damaged'],
  ];
  for (const [body, key] of cases) {
    await importText(page, body);
    await expect(page.getByTestId('notice')).toHaveAttribute('data-key', key);
    const shown = await page.getByTestId('notice').innerText();
    expect(shown).not.toMatch(/Error|stack|at \w+ \(|\/home\/|undefined/);
    expect(shown).toContain('Nothing was imported');
    await page.getByTestId('notice').getByRole('button').click();
  }
  // A future schema with a matching hash is refused as "newer", not as damaged.
  const future = structuredClone(good) as unknown as {
    project: ProjectDocument;
    integrity: { project: string };
  };
  future.project.schemaVersion = 4;
  future.integrity.project = projectHash(future.project);
  await importText(page, JSON.stringify(future));
  await expect(page.getByTestId('notice')).toHaveAttribute('data-key', 'import.error.newer');
  // Over the size limit: refused without reading.
  await importText(page, ' '.repeat(2 * 1024 * 1024 + 10));
  await expect(page.getByTestId('notice')).toHaveAttribute('data-key', 'import.error.too_large');
  expect(JSON.stringify(await storedProjects(page))).toBe(before);
  await expect(page.getByTestId('example-list')).toBeVisible(); // still in the library
});

test('A8: importing a project that already exists creates an independent copy and says so', async ({
  page,
}) => {
  await startInLibrary(page);
  const id = await openExample(page, 'ohms-law');
  const text = await exportCurrent(page);
  await setValue(page, 'R1', 'resistance', '2k');
  const local = await waitStored(
    page,
    id,
    (d) =>
      (d.components.find((c) => c.id === 'R1')!.params.resistance as { value: number }).value ===
      2000,
    'R1 = 2k',
  );
  await goLibrary(page);
  await importText(page, text);
  // Same id AND same name as the local project: a copy with a copy-style name (Product Alpha
  // maintenance: no two projects may read the same).
  await expect(page.getByTestId('notice')).toHaveAttribute('data-key', 'import.doneCopyRenamed');
  const copyId = await openProjectId(page);
  expect(copyId).not.toBe(id);
  expect(await stored(page, id)).toEqual(local); // never overwritten
  const copy = (await stored(page, copyId))!;
  expect(copy.components).toEqual(
    parsePackage(text).ok ? JSON.parse(text).project.components : null,
  );
  expect(copy.name).toBe(`${local.name} (copy)`);
});

test('A9/A14: a Hebrew-created, Hebrew-exported project imports in English unchanged', async ({
  page,
}) => {
  await createProject(page, 'placeholder');
  await page.getByTestId('language-select').selectOption('he');
  await goLibrary(page);
  const id = await openExample(page, 'voltage-divider');
  await page.getByTestId('project-name').fill('מחלק מתח שלי — Lab ✓');
  await page.getByTestId('project-name').press('Enter');
  await setValue(page, 'R2', 'resistance', '4.7k');
  const hebrewDoc = await waitStored(
    page,
    id,
    (d) =>
      d.name === 'מחלק מתח שלי — Lab ✓' &&
      (d.components.find((c) => c.id === 'R2')!.params.resistance as { value: number }).value ===
        4700,
    'Hebrew edits stored',
  );
  const fromHebrew = await exportCurrent(page);
  await page.getByTestId('language-select').selectOption('en');
  expect(await stored(page, id)).toEqual(hebrewDoc); // the language switch wrote nothing
  const fromEnglish = await exportCurrent(page);
  const [h, e] = [JSON.parse(fromHebrew), JSON.parse(fromEnglish)];
  expect(e.project).toEqual(h.project);
  expect(e.integrity.project).toBe(h.integrity.project); // locale-independent hash

  await goLibrary(page);
  await row(page, id).getByTestId('delete-project').click();
  await page.getByTestId('delete-confirm').click();
  await expect.poll(() => stored(page, id)).toBeUndefined();
  await importText(page, fromHebrew);
  await expect(page.getByTestId('notice')).toHaveAttribute('data-key', 'import.done');
  expect(await stored(page, id)).toEqual(hebrewDoc);
  await expect(page.getByTestId('project-name')).toHaveValue('מחלק מתח שלי — Lab ✓');
});

test('A10/A11: every example opens as a new project, runs, and shows the engine values', async ({
  page,
}) => {
  await createProject(page, 'start');
  await goLibrary(page);
  const seen = new Set<string>();
  const expectPsu = async (r: SolveSuccess) => {
    await select(page, 'PSU1');
    await expect(page.getByTestId('psu-mode')).toHaveAttribute(
      'data-mode',
      r.components.PSU1!.mode!,
    );
    expect(plain(await page.getByTestId('psu-measured-current').textContent())).toBe(
      A(r.components.PSU1!.current!),
    );
    expect(plain(await page.getByTestId('psu-measured-voltage').textContent())).toBe(
      V(r.components.PSU1!.voltage!),
    );
  };

  for (const id of ['ohms-law', 'voltage-divider', 'led-current', 'diode-polarity']) {
    const projectId = await openExample(page, id);
    expect(seen.has(projectId)).toBe(false);
    seen.add(projectId);
    const doc = (await stored(page, projectId))!;
    await run(page);
    await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
    const r = truth(doc);
    const probes: Record<string, () => [string, number]> = {
      'ohms-law': () => ['I(R1)', r.components.R1!.current!],
      'voltage-divider': () => ['V(R2.a)', r.components.R2!.terminals.a!],
      'led-current': () => ['I(D1)', r.components.D1!.current!],
      'diode-polarity': () => ['I(D2)', r.components.D2!.current!],
    };
    const [name, value] = probes[id]!();
    const kind = name.startsWith('I') ? A(value) : V(value);
    expect(await reading(page, name.slice(2, -1))).toBe(`${name} = ${kind}`);
    await expectPsu(r);
    await page.getByTestId('sim-stop').click();
    await goLibrary(page);
  }

  // Push button: released, held, released again, each the engine's value on the stored doc.
  const pb = await openExample(page, 'push-button');
  const pbDoc = (await stored(page, pb))!;
  await run(page);
  expect(await reading(page, 'D1')).toBe(`I(D1) = ${A(truth(pbDoc).components.D1!.current!)}`);
  const box = (await page.getByTestId('actuator-SW1').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const held = truth(pbDoc, ['SW1']).components.D1!.current!;
  await expect(page.getByTestId('probe-reading-D1')).toHaveText(new RegExp(A(held)));
  await page.mouse.up();
  await expect(page.getByTestId('probe-reading-D1')).toHaveText('I(D1) = 0 A');
  expect(await stored(page, pb)).toEqual(pbDoc); // pressing never touched the project
  await page.getByTestId('sim-stop').click();
  await goLibrary(page);

  // CC mode: CV with SW1 open; closing SW1 while running goes to CC (not an error).
  const cc = await openExample(page, 'cc-mode');
  await run(page);
  await expectPsu(truth((await stored(page, cc))!));
  await page.getByTestId('actuator-SW1').click();
  const closed = await waitStored(
    page,
    cc,
    (d) => d.components.find((c) => c.id === 'SW1')!.params.closed === true,
    'SW1 closed',
  );
  const ccTruth = truth(closed);
  expect(ccTruth.components.PSU1!.mode).toBe('cc');
  await expectPsu(ccTruth); // re-selects PSU1: the panel shows CC, from the engine
  await expect(page.getByTestId('sim-error')).toHaveCount(0);
});

test('A12: a failing save and a crashed worker are explained, and the project stays safe', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if ((window as unknown as { __failSaves?: boolean }).__failSaves) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      return put.apply(this, args);
    };
  });
  const id = await (async () => {
    await createProject(page, 'Fragile');
    return openProjectId(page);
  })();
  await page.evaluate(() => ((window as unknown as { __failSaves: boolean }).__failSaves = true));
  await page.getByTestId('project-name').fill('Fragile 2');
  await page.getByTestId('project-name').press('Enter');
  await expect(page.getByTestId('save-error')).toBeVisible();
  await expect(page.getByTestId('save-error')).toContainText('storage is full');
  await expect(page.getByTestId('save-error')).not.toContainText(/DOMException|Quota|stack/);
  expect((await stored(page, id))!.name).toBe('Fragile'); // nothing half-written
  await expect(page.getByTestId('project-name')).toHaveValue('Fragile 2'); // work kept
  await page.evaluate(() => ((window as unknown as { __failSaves: boolean }).__failSaves = false));
  await page.getByTestId('save-error').getByRole('button').click();
  await waitStored(page, id, (d) => d.name === 'Fragile 2', 'saved after retry');
  await expect(page.getByTestId('save-error')).toHaveCount(0);

  // The engine worker fails to load: a calm, localized message; the project is untouched.
  await page.getByTestId('language-select').selectOption('he');
  await page.route(/\/assets\/worker-[\w-]+\.js$/, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: 'throw new Error("boom")' }),
  );
  const before = JSON.stringify(await stored(page, id));
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-error')).toHaveAttribute('data-code', 'worker_crashed');
  const message = await page.getByTestId('sim-error').innerText();
  expect(message).not.toMatch(/boom|Error|stack|\.js/);
  expect(message).toMatch(/[֐-׿]/);
  expect(JSON.stringify(await stored(page, id))).toBe(before);
});

test('A13/A15: new Sprint 5 surfaces are Hebrew (technical tokens only), RTL chrome, LTR canvas', async ({
  page,
}) => {
  await createProject(page, 'פרויקט ראשון');
  const id = await openProjectId(page);
  await page.getByTestId('language-select').selectOption('he');
  await goLibrary(page);
  expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
  const allowed = [
    /^TBI$/,
    /^Lab$/,
    /^English$/,
    /^tbilab$/,
    /^(ESP32|DevKitC|GPIO\d+)$/, // Classic ESP32 technical tokens: MCU, board, pin names (Sprint 6)
    /^(RGB|NPN|LDR|PIR|NC|NO|COM|RC|GL5528|N3904|HC|SR501|F)$/, // Sprint 10: part numbers and standard acronyms (technical tokens)
    /^(HIGH|LOW|ADC|Flyback|lx)$/, // Sprint 11: logic levels, ADC, flyback (kept in English by the glossary rule, CLAUDE.md) and the lux symbol
    /^(PSU|R|GND|D|SW)\d+$/,
    /^(GND|LED|DC|CV|CC|OFF|MB)$/,
    /^N4148$/,
    /^[VIRa]$/,
    /^k$/,
  ];
  const words = async () => {
    const text = (await scannedText(page)).replace(
      /(?<![A-Za-z])[kmMGµunp]?[ΩVA](?![A-Za-z])/g,
      ' ',
    );
    return [
      ...new Set(
        (text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).filter(
          (w) => !allowed.some((re) => re.test(w)),
        ),
      ),
    ];
  };
  expect(await words(), 'library').toEqual([]);
  await row(page, id).getByTestId('delete-project').click();
  expect(await words(), 'delete dialog').toEqual([]);
  await page.getByTestId('delete-cancel').click();
  await row(page, id).getByTestId('rename-project').click();
  expect(await words(), 'rename').toEqual([]);
  await page.keyboard.press('Escape');
  await importText(page, 'not a project');
  await expect(page.getByTestId('notice')).toBeVisible();
  expect(await words(), 'import error').toEqual([]);
  await openExample(page, 'cc-mode');
  expect(await words(), 'editor').toEqual([]);
  expect(await page.getByTestId('canvas').evaluate((el) => getComputedStyle(el).direction)).toBe(
    'ltr',
  );
  // Engineering text stays LTR inside RTL chrome.
  expect(
    await page.getByTestId('probe-reading-R2').evaluate((el) => getComputedStyle(el).direction),
  ).toBe('ltr');
});

test('A16: races — rename+navigate, duplicate+open, delete after pending edit, export after edit, locale during autosave, example+run, import+reload', async ({
  page,
}) => {
  // Rename in the editor, then leave at once: the rename is not lost.
  await createProject(page, 'Race');
  const id = await openProjectId(page);
  await page.getByTestId('project-name').fill('Race renamed');
  await page.getByTestId('project-name').press('Enter');
  await goLibrary(page);
  await waitStored(page, id, (d) => d.name === 'Race renamed', 'rename before navigation');
  await expect(row(page, id)).toHaveAttribute('data-name', 'Race renamed');

  // Duplicate, then open the copy immediately.
  await row(page, id).getByTestId('duplicate-project').click();
  const copyRow = page.locator('[data-name="Race renamed (copy)"]');
  await copyRow.getByTestId('open-project').click();
  await expect(page.getByTestId('project-name')).toHaveValue('Race renamed (copy)');
  const copyId = await openProjectId(page);
  expect(copyId).not.toBe(id);

  // Edit, then export at once: the export contains the edit.
  await setValue(page, 'PSU1', 'setpointVoltage', '7');
  const exported = JSON.parse(await exportCurrent(page)) as ProjectPackage;
  expect(
    (
      exported.project.components.find((c) => c.id === 'PSU1')!.params.setpointVoltage as {
        value: number;
      }
    ).value,
  ).toBe(7);

  // Switch language repeatedly while an edit is being autosaved: exactly one new revision.
  const r0 = (await stored(page, copyId))!.revision.localRevision;
  await setValue(page, 'PSU1', 'setpointVoltage', '8');
  for (const l of ['he', 'en', 'he', 'en'])
    await page.getByTestId('language-select').selectOption(l);
  const after = await waitStored(
    page,
    copyId,
    (d) => (d.components[0]!.params.setpointVoltage as { value: number }).value === 8,
    'setpoint 8',
  );
  expect(after.revision.localRevision).toBe(r0 + 1);

  // Edit, leave, delete at once: the pending save never brings the project back.
  await setValue(page, 'PSU1', 'setpointVoltage', '9');
  await goLibrary(page);
  await row(page, copyId).getByTestId('delete-project').click();
  await page.getByTestId('delete-confirm').click();
  await expect.poll(() => stored(page, copyId)).toBeUndefined();
  await page.waitForTimeout(700); // past the autosave debounce: proves absence, not a race fix
  expect(await stored(page, copyId)).toBeUndefined();

  // Create an example and run it immediately.
  await page.getByTestId('open-example-led-current').click();
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  const ledId = await openProjectId(page);
  const r = truth((await stored(page, ledId))!);
  await expect(page.getByTestId('probe-reading-D1')).toHaveText(
    `I(D1) = ${A(r.components.D1!.current!)}`,
  );
  await page.getByTestId('sim-stop').click();

  // Import, then reload straight away: the project is either fully there or not at all —
  // here it is there, because import reports success only after the write committed.
  const text = await exportCurrent(page);
  await goLibrary(page);
  await row(page, ledId).getByTestId('delete-project').click();
  await page.getByTestId('delete-confirm').click();
  await expect.poll(() => stored(page, ledId)).toBeUndefined();
  await importText(page, text);
  await expect(page.getByTestId('notice')).toHaveAttribute('data-key', 'import.done');
  await page.reload();
  expect(await stored(page, ledId)).toEqual(JSON.parse(text).project);
});

test('A20: a new user goes from example to edit, run, probe, export, import and language switch', async ({
  page,
}) => {
  await page.goto('/');
  const home = page.getByTestId('example-list');
  await expect(home.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await home.isVisible())) await goLibrary(page);
  const id = await openExample(page, 'led-current');
  await setValue(page, 'R1', 'resistance', '330');
  const doc = await waitStored(
    page,
    id,
    (d) =>
      (d.components.find((c) => c.id === 'R1')!.params.resistance as { value: number }).value ===
      330,
    'R1 = 330',
  );
  await run(page);
  const r = truth(doc);
  expect(await reading(page, 'D1')).toBe(`I(D1) = ${A(r.components.D1!.current!)}`);
  const file = await exportCurrent(page);
  await page.getByTestId('sim-stop').click();
  await goLibrary(page);
  await row(page, id).getByTestId('delete-project').click();
  await page.getByTestId('delete-confirm').click();
  await expect.poll(() => stored(page, id)).toBeUndefined();
  await importText(page, file);
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.getByTestId('language-select').selectOption('he');
  await run(page);
  expect(await reading(page, 'D1')).toBe(`I(D1) = ${A(r.components.D1!.current!)}`);
  expect(await stored(page, id)).toEqual(doc);
});
