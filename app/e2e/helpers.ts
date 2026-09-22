import { expect, type Page } from '@playwright/test';
import type { Point, ProjectDocument } from '@tbi-lab/domain';

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

export async function waitSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
}

export async function createProject(page: Page, name?: string): Promise<void> {
  await page.goto('/');
  if (name !== undefined) await page.getByTestId('new-project-name').fill(name);
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
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
