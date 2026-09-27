import { expect, type Download, type Page } from '@playwright/test';
import { createPackage, serializePackage, type Point, type ProjectDocument } from '@tbi-lab/domain';

/** Every stored project document, read straight from the real IndexedDB. */
export async function storedProjects(page: Page): Promise<ProjectDocument[]> {
  return page.evaluate(
    () =>
      new Promise<ProjectDocument[]>((resolve, reject) => {
        const req = indexedDB.open('tbi-lab');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const get = db.transaction('projects', 'readonly').objectStore('projects').getAll();
          get.onsuccess = () => {
            db.close();
            resolve(get.result as ProjectDocument[]);
          };
          get.onerror = () => reject(get.error);
        };
      }),
  );
}

export async function storedProject(page: Page): Promise<ProjectDocument> {
  const all = await storedProjects(page);
  expect(all).toHaveLength(1);
  return all[0]!;
}

/**
 * The save indicator currently reads "saved".
 *
 * NOT proof that a mutation just made has persisted: immediately after an edit the DOM can
 * still show the previous "saved" state because the app has not rendered its pending
 * "saving" state yet (CI run 35828605417). To prove a specific change is durable, use
 * `waitForStoredProject` with a predicate describing that change.
 */
export async function waitSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
}

/**
 * Poll the REAL IndexedDB until the single stored project satisfies `predicate` (bounded by
 * Playwright's expect timeout), and return that document. This checks the durability claim
 * itself rather than the UI indicator.
 */
export async function waitForStoredProject(
  page: Page,
  predicate: (doc: ProjectDocument) => boolean,
  what: string,
  /** When several projects are stored, the name of the one the test is working on. */
  projectName?: string,
): Promise<ProjectDocument> {
  let match: ProjectDocument | undefined;
  await expect
    .poll(
      async () => {
        const all = (await storedProjects(page)).filter(
          (p) => projectName === undefined || p.name === projectName,
        );
        match = all.length === 1 && predicate(all[0]!) ? all[0] : undefined;
        return match !== undefined;
      },
      { message: `stored project: ${what}` },
    )
    .toBe(true);
  return match!;
}

export async function createProject(page: Page, name?: string): Promise<void> {
  await page.goto('/');
  // The app reopens the last project; go back to the project home to create a new one.
  const home = page.getByTestId('new-project-name');
  await expect(home.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await home.isVisible())) await goToProjects(page);
  if (name !== undefined) await page.getByTestId('new-project-name').fill(name);
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  // The new project is durable (not merely "the indicator says saved").
  const expected = name ?? (await page.getByTestId('project-name').inputValue());
  await expect
    .poll(async () => (await storedProjects(page)).some((p) => p.name === expected.trim()), {
      message: `project "${expected}" stored`,
    })
    .toBe(true);
  await waitSaved(page);
}

/** Map a schematic world point to page coordinates using the live viewBox. */
export async function toScreen(page: Page, p: Point): Promise<Point> {
  return page.getByTestId('canvas').evaluate((svg, pt) => {
    const el = svg as SVGSVGElement;
    const vb = el.viewBox.baseVal;
    const r = el.getBoundingClientRect();
    return {
      x: r.left + ((pt.x - vb.x) * r.width) / vb.width,
      y: r.top + ((pt.y - vb.y) * r.height) / vb.height,
    };
  }, p);
}

export async function clickWorld(page: Page, p: Point, modifiers: 'Shift'[] = []): Promise<void> {
  const s = await toScreen(page, p);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.click(s.x, s.y);
  for (const m of modifiers) await page.keyboard.up(m);
}

export async function place(page: Page, type: string, at: Point): Promise<void> {
  await page.getByTestId(`palette-${type}`).click();
  await clickWorld(page, at);
}

export function terminal(page: Page, component: string, term: string) {
  return page.locator(
    `[data-hit="terminal"][data-component="${component}"][data-terminal="${term}"]`,
  );
}

/** Click one terminal, then another: the click-click wiring gesture. */
export async function wire(
  page: Page,
  from: [string, string],
  to: [string, string],
): Promise<void> {
  await terminal(page, ...from)
    .locator('.terminal-hit')
    .click();
  await terminal(page, ...to)
    .locator('.terminal-hit')
    .click();
}

export function component(page: Page, id: string) {
  return page.locator(`[data-hit="component"][data-id="${id}"]`);
}

/**
 * Import a project document through the real import control and open it in the editor. Used
 * for fixtures whose wires carry explicit stored geometry, e.g. a project drawn before new wires
 * were auto-routed around terminals and bodies: its stored geometry is kept as is.
 */
export async function openImported(page: Page, doc: ProjectDocument): Promise<void> {
  const text = serializePackage(
    createPackage(doc, { appVersion: '0.1.0', exportedAt: '2026-09-26T00:00:00.000Z' }),
  );
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) {
    await goToProjects(page);
  }
  await page.getByTestId('import-file').setInputFiles({
    name: 'fixture.tbilab',
    mimeType: 'application/json',
    buffer: Buffer.from(text, 'utf8'),
  });
  await expect(page.getByTestId('canvas')).toBeVisible();
}

/** Open the editor's application menu (projects, files, account). */
export async function openAppMenu(page: Page): Promise<void> {
  const button = page.getByTestId('app-menu-button');
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  await expect(page.getByTestId('app-menu')).toBeVisible();
}

/** From the editor, back to the Projects screen through the application menu. */
export async function goToProjects(page: Page): Promise<void> {
  await openAppMenu(page);
  await page.getByTestId('menu-projects').click();
  await expect(page.getByTestId('example-list')).toBeVisible();
}

/** Export the open project through the application menu; resolves with the download. */
export async function exportFromMenu(page: Page): Promise<Download> {
  await openAppMenu(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-current').click(),
  ]);
  return download;
}
