// OS-11 / OS-12 live acceptance on DEV: the DEPLOYED frontend through the gate's internal origin
// (identity header as the gate sets it), the deployed backends. Prints PASS/FAIL lines.
//   vite-node live-os11-os12.ts <base> <shots dir> <user prefix> <expected commit>
import { chromium, type Page } from '@playwright/test';
const [BASE, OUT, WHO, COMMIT] = process.argv.slice(2) as [string, string, string, string];
const b = await chromium.launch();
let n = 0,
  f = 0;
const check = (name: string, ok: boolean, d = '') => {
  n++;
  if (!ok) f++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d ? '  — ' + d : ''}`);
};
const T = (p: Page, id: string) => p.getByTestId(id);
const cards = (p: Page) => T(p, 'example-list').locator('li.example');
const projects = async (p: Page) => {
  await p.goto(BASE);
  await T(p, 'example-search').or(T(p, 'canvas')).first().waitFor({ timeout: 30000 });
  if (!(await T(p, 'example-search').isVisible())) {
    await T(p, 'app-menu-button').click();
    await T(p, 'menu-projects').click();
  }
  await T(p, 'example-search').waitFor();
};
const ctx = await b.newContext({
  viewport: { width: 1400, height: 860 },
  extraHTTPHeaders: { 'x-forwarded-user': `${WHO}-a` },
});
const page = await ctx.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
const accepts: Record<string, string[]> = {};
page.on('request', (r) => {
  const u = new URL(r.url());
  const key = u.pathname.startsWith('/runtime/')
    ? '/runtime/*'
    : u.pathname.startsWith('/build/')
      ? '/build/*'
      : u.pathname === '/version.json'
        ? '/version.json'
        : null;
  if (key && r.resourceType() === 'fetch' && !r.headers()['x-live-tool'])
    (accepts[key] ??= []).push(r.headers()['accept'] ?? '');
});

// ---- Version and OS-12.
await projects(page);
// The tool's own read is marked so it is not counted as an app request.
const served = await page.evaluate(
  async () => (await (await fetch('/version.json', { headers: { 'x-live-tool': '1' } })).json()) as { commit: string },
);
check('deployed frontend commit', served.commit === COMMIT, served.commit);
const total = await cards(page).count();
check('OS-12 all examples listed', total === 22, String(total));
await T(page, 'example-search').fill('ESP32 LCD');
check('OS-12 "ESP32 LCD" -> exactly the LCD example', (await cards(page).count()) === 1 && (await T(page, 'example-esp32-lcd-hello').isVisible()));
for (const [q, id] of [
  ['LDR', 'example-light-sensor'],
  ['PIR', 'example-pir-alarm'],
  ['hcsr04', 'example-esp32-distance-alarm'],
  ['I2C', 'example-esp32-lcd-hello'],
  ['ממסר', 'example-relay-load'],
] as const) {
  await T(page, 'example-search').fill(q);
  check(`OS-12 alias "${q}"`, await T(page, id).isVisible());
}
await T(page, 'example-search').fill('');
await T(page, 'example-search').press('Tab');
const basicFocused = await T(page, 'example-category-basic').evaluate((e) => e === document.activeElement);
await page.keyboard.press('Space');
check('OS-12 keyboard: Tab to a category, Space toggles', basicFocused && (await T(page, 'example-category-basic').getAttribute('aria-pressed')) === 'true');
const basicCount = await cards(page).count();
await T(page, 'example-category-controllers').click();
check('OS-12 a second category widens (OR)', (await cards(page).count()) > basicCount);
await T(page, 'example-category-controllers').click();
await T(page, 'example-search').fill('ESP32');
check('OS-12 words AND categories -> empty state', (await cards(page).count()) === 0 && (await T(page, 'example-empty').isVisible()));
await T(page, 'example-clear').click();
check('OS-12 Clear filters restores all and focuses search', (await cards(page).count()) === total && (await T(page, 'example-search').evaluate((e) => e === document.activeElement)));
await page.screenshot({ path: `${OUT}/os12-en.png` });
await T(page, 'language-select').selectOption('he');
await T(page, 'example-search').fill('חיישן');
const heCount = await cards(page).count();
check('OS-12 Hebrew "חיישן" -> all 7 sensor examples', heCount === 7, String(heCount));
await T(page, 'example-search').fill('ESP32 LCD');
check('OS-12 English words in the Hebrew UI', (await cards(page).count()) === 1);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('OS-12 Hebrew RTL, no horizontal overflow', (await page.evaluate(() => document.documentElement.dir)) === 'rtl' && overflow <= 0, String(overflow));
await page.screenshot({ path: `${OUT}/os12-he.png` });
await T(page, 'language-select').selectOption('en');
await T(page, 'example-search').fill('HC-SR04');
await T(page, 'open-example-esp32-distance-alarm').click();
await T(page, 'canvas').waitFor();
check('OS-12 opening a filtered example opens the editor', await page.locator('[data-hit="component"][data-id="U1"]').isVisible());

// ---- OS-11: what the deployed bundle sends, and the expired sign-in path.
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
await page.waitForTimeout(1500);
const bg = Object.entries(accepts);
check(
  'OS-11 every background request of the deployed app carries application/json',
  bg.length > 0 && bg.every(([, v]) => v.every((a) => a.split(/,\s*/).includes('application/json'))),
  bg.map(([k, v]) => `${k}: ${[...new Set(v)].join(' | ')} ×${v.length}`).join('; '),
);
await T(page, 'project-name').fill('OS-11 live');
await T(page, 'project-name').press('Enter');
await page.route('**/version.json', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
const banner = await T(page, 'signin-expired').waitFor({ timeout: 10000 }).then(() => true, () => false);
check('OS-11 a gate 401 shows the sign-in banner', banner);
await page.unroute('**/version.json');
let navigations = 0;
page.on('framenavigated', (fr) => fr === page.mainFrame() && navigations++);
await T(page, 'signin-again').click();
await T(page, 'canvas').or(T(page, 'example-search')).first().waitFor({ timeout: 30000 });
await page.waitForTimeout(1000);
const kept = await page.evaluate(async () => {
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open('tbi-lab');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const names = await new Promise<string[]>((res) => {
    const q = db.transaction('projects').objectStore('projects').getAll();
    q.onsuccess = () => res((q.result as { name: string }[]).map((x) => x.name));
  });
  return names;
}).catch((e) => [String(e)]);
check('OS-11 Sign in again: one navigation, project saved', navigations === 1 && kept.includes('OS-11 live'), `navigations=${navigations}`);
check('OS-11 banner gone after the reload', (await T(page, 'signin-expired').count()) === 0);
check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
await b.close();
console.log(`\n${n - f}/${n} passed`);
process.exit(f ? 1 : 0);
