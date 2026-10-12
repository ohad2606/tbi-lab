// Sprint 13 DEV live acceptance: the DEPLOYED frontend through the gate's internal origin, the
// deployed build service, Session Host and Runtime v2 (real QEMU). OS-01..OS-10, P2-P4, version.
//   vite-node live-s13.ts <base> <shots dir> <user prefix> <expected commit>
import { readFileSync } from 'node:fs';
import { chromium, type Page } from '@playwright/test';
import {
  addComponent,
  addWire,
  createPackage,
  createProject,
  deleteSelection,
  emptySelection,
  serializePackage,
  setProgramText,
  type ProjectDocument,
  type WireTarget,
} from '@tbi-lab/domain';

const [BASE, OUT, WHO, COMMIT] = process.argv.slice(2) as [string, string, string, string];
const REPO = '/home/ubuntu/projects/tbi-lab-s13';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const mk = (user: string) => b.newContext({ viewport: { width: 1400, height: 860 }, extraHTTPHeaders: { 'x-forwarded-user': user } });
let n = 0, f = 0;
const check = (name: string, ok: boolean, d = '') => { n++; if (!ok) f++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d ? '  — ' + d : ''}`); };
const until = async (p: Page, fn: () => Promise<boolean>, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn().catch(() => false)) return true; await p.waitForTimeout(200); } return false; };
const T = (p: Page, id: string) => p.getByTestId(id);
const C = (p: Page, id: string) => p.locator(`[data-hit="component"][data-id="${id}"]`);
const attr = (p: Page, id: string, a: string) => T(p, id).getAttribute(a).catch(() => null);
const level = (p: Page, g: number) => p.locator(`[data-testid="pin-level-${g}"]`).getAttribute('data-level').catch(() => null);
const ONLY = process.env.STEPS?.split(',');
const step = async (name: string, fn: () => Promise<void>) => { if (ONLY && !ONLY.includes(name)) return; try { await fn(); } catch (e) { await page.screenshot({ path: `${OUT}/fail-${name.replace(/\W/g, '_')}.png` }).catch(() => {}); console.log('DEBUG', name, page.url(), String(e).split('\n').slice(0, 6).join(' | ')); check(name, false, String(e).split('\n')[0]); } };
const projects = async (p: Page) => {
  await p.goto(BASE); await T(p, 'example-list').or(T(p, 'canvas')).first().waitFor({ timeout: 30000 });
  if (!(await T(p, 'example-list').isVisible())) { await T(p, 'app-menu-button').click(); await T(p, 'menu-projects').click(); }
};
const open = async (p: Page, id: string) => { await projects(p); await T(p, `open-example-${id}`).click(); await T(p, 'canvas').waitFor(); };
const importDoc = async (p: Page, doc: ProjectDocument) => {
  await projects(p);
  const text = serializePackage(createPackage(doc, { appVersion: '0.10-dev', exportedAt: '2026-10-12T00:00:00.000Z' }));
  await T(p, 'import-file').setInputFiles({ name: 'live.tbilab', mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') });
  await T(p, 'canvas').waitFor();
};
const build = async (p: Page, id: string) => {
  await T(p, 'view-code').click(); await T(p, 'build-button').click();
  check(`${id}: Build -> current`, await until(p, async () => (await attr(p, 'build-phase', 'data-phase')) === 'current', 300000));
  await T(p, 'view-circuit').click();
};
const run = async (p: Page, id: string) => {
  await T(p, 'sim-run').click();
  check(`${id}: Run -> running (mcu)`, await until(p, async () => (await attr(p, 'sim-status', 'data-status')) === 'running' && (await attr(p, 'sim-status', 'data-engine')) === 'mcu', 90000));
};
const stop = async (p: Page, id: string) => {
  await T(p, 'sim-stop').click();
  check(`${id}: Stop -> stopped`, await until(p, async () => (await attr(p, 'sim-status', 'data-status')) === 'stopped', 60000));
};
const drag = async (p: Page, id: string, toLeft: boolean, moves = 30, ms = 1500) => {
  const box = (await T(p, id).boundingBox())!; const y = box.y + box.height / 2;
  const x0 = toLeft ? box.x + box.width - 3 : box.x + 3; const x1 = toLeft ? box.x + 3 : box.x + box.width - 3;
  await p.mouse.move(x0, y); await p.mouse.down();
  for (let i = 1; i <= moves; i++) { await p.mouse.move(x0 + ((x1 - x0) * i) / moves, y); await p.waitForTimeout(ms / moves); }
  await p.mouse.up();
};
const at = (component: string, terminal: string): WireTarget => ({ kind: 'terminal', component, terminal });
const lcdExample = () => JSON.parse(readFileSync(`${REPO}/app/src/examples/data/esp32-lcd-hello.json`, 'utf8')) as ProjectDocument;

const ctx = await mk(`${WHO}-a`);
const page = await ctx.newPage();
const errors: string[] = []; page.on('pageerror', (e) => errors.push(String(e)));

await step('version', async () => {
  await projects(page);
  check('deployed frontend commit', (await T(page, 'app-version').getAttribute('data-commit')) === COMMIT, String(await T(page, 'app-version').getAttribute('data-commit')));
});

await step('OS-08', async () => {
  await open(page, 'esp32-blink');
  // A unique source: an earlier build of the example's exact text (any user's) is legitimately
  // recovered by the build-service lookup, which would make Run available at once.
  await T(page, 'view-code').click(); await T(page, 'code-text').click(); await page.keyboard.press('Control+End'); await page.keyboard.type(`\n// live ${Date.now()}`);
  await T(page, 'view-circuit').click();
  check('OS-08: no build -> Run unavailable (build required)', (await T(page, 'sim-run').isDisabled()) && (await attr(page, 'sim-run', 'data-blocked')) === 'run.blocked.buildRequired');
  await T(page, 'view-code').click(); await T(page, 'build-button').click();
  check('OS-08: during the build -> Run unavailable (building)', await until(page, async () => (await attr(page, 'sim-run', 'data-blocked')) === 'run.blocked.building', 30000));
  check('OS-08: built -> Run available', await until(page, async () => (await attr(page, 'build-phase', 'data-phase')) === 'current' && !(await T(page, 'sim-run').isDisabled()), 300000));
  await T(page, 'view-circuit').click();
  await run(page, 'esp32-blink'); await stop(page, 'esp32-blink');
  await T(page, 'view-code').click(); await T(page, 'code-text').click(); await page.keyboard.press('Control+End'); await page.keyboard.type('\n// edit');
  check('OS-08: an edit -> Run unavailable again (stale)', await until(page, async () => (await attr(page, 'sim-run', 'data-blocked')) === 'run.blocked.buildRequired', 10000));
  await T(page, 'view-circuit').click();
});

await step('OS-10', async () => {
  for (const lang of ['en', 'he']) {
    await open(page, 'voltage-divider');
    await T(page, 'language-select').selectOption(lang);
    const tile = T(page, 'palette-component.resistor');
    const look = (id: string) => T(page, `palette-${id}`).evaluate((el) => getComputedStyle(el).backgroundColor);
    const resting = await look('component.led');
    await T(page, 'palette-component.led').hover(); const hover = await look('component.led');
    await tile.click(); await page.mouse.move(5, 5); const armed = await look('component.resistor');
    check(`OS-10 (${lang}): armed tile pressed, check mark, fill distinct from resting and hover`, (await tile.getAttribute('aria-pressed')) === 'true' && (await tile.getByTestId('palette-check').count()) === 1 && armed !== resting && armed !== hover);
    const r1 = (await C(page, 'R1').boundingBox())!; await page.mouse.move(r1.x + r1.width / 2, r1.y + r1.height / 2);
    check(`OS-10 (${lang}): preview invalid over a part`, await until(page, async () => (await attr(page, 'placement-ghost', 'data-valid')) === 'false', 5000));
    await page.keyboard.press('Escape');
    check(`OS-10 (${lang}): Escape disarms`, (await tile.getAttribute('aria-pressed')) === 'false' && (await tile.getByTestId('palette-check').count()) === 0);
    await page.screenshot({ path: `${OUT}/os10-${lang}.png` });
    await T(page, 'language-select').selectOption('en');
  }
});

await step('OS-07', async () => {
  for (const lang of ['en', 'he']) {
    await open(page, 'esp32-motion-relay'); await T(page, 'language-select').selectOption(lang);
    await C(page, 'U2').focus();
    const o = await page.evaluate(() => { const el = document.querySelector('.inspector') as HTMLElement; return el.scrollWidth - el.clientWidth; });
    check(`OS-07 (${lang}): PIR inspector without horizontal overflow`, o <= 0, `${o}px`);
    await T(page, 'language-select').selectOption('en');
  }
});

await step('OS-01/OS-04', async () => {
  await open(page, 'voltage-divider');
  await C(page, 'R1').focus(); const field = T(page, 'param-R1-resistance');
  await field.fill('4k7'); await field.press('Enter');
  check('OS-01: 4k7 -> 4.7 kΩ on the part', await until(page, async () => ((await T(page, 'value-R1').textContent()) ?? '').includes('4.7 kΩ'), 5000));
  const from = (await C(page, 'R1').boundingBox())!; const to = (await C(page, 'R2').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 }); await page.mouse.up();
  check('OS-04: dropping a part onto another is refused with the reason', await until(page, async () => ((await T(page, 'notice').textContent()) ?? '').includes('would overlap'), 5000));
});

await step('OS-06/OS-03 live', async () => {
  const id = 'esp32-distance-alarm';
  await open(page, id); await C(page, 'U2').focus();
  check('OS-06: distance in plain metres', (await T(page, 'param-U2-distance').inputValue()) === '0.5');
  await build(page, id); await run(page, id);
  await C(page, 'U2').focus();
  await drag(page, 'param-U2-distance-slider', true);
  const s = T(page, 'param-U2-distance-slider'); for (let i = 0; i < 18; i++) await s.press('ArrowRight');
  check('OS-06: 0.10 m reached by 5 mm steps', (await T(page, 'param-U2-distance').inputValue()) === '0.1');
  check('OS-06/OS-03: under the live session the alarm LED lights', await until(page, async () => (await level(page, 2)) === '1', 60000));
  check('OS-03: session still running after the drag (no rate refusal)', (await attr(page, 'sim-status', 'data-status')) === 'running');
  await stop(page, id);
});

await step('OS-09', async () => {
  let doc = lcdExample();
  const ends = (w: ProjectDocument['layout']['wires'][number], c: string, t: string) => [w.from, w.to].some((e) => e.kind === 'terminal' && e.component === c && e.terminal === t);
  const del = deleteSelection(doc, { ...emptySelection(), wires: [doc.layout.wires.find((w) => ends(w, 'DS1', 'vcc'))!.id, doc.layout.wires.find((w) => ends(w, 'DS1', 'sda'))!.id] });
  if (!del.ok) throw new Error(del.error); doc = del.doc;
  for (const [a, c] of [[at('PSU1', 'positive'), at('DS1', 'sda')], [at('R1', 'b'), at('DS1', 'vcc')]] as const) { const r = addWire(doc, a, c); if (!r.ok) throw new Error(r.error); doc = r.doc; }
  await importDoc(page, { ...doc, name: 'Live OS-09 swap' });
  await build(page, 'OS-09'); await run(page, 'OS-09');
  await C(page, 'U1').focus();
  const w = page.getByTestId('mcu-warnings').locator('li[data-code="i2c_wiring"]');
  check('OS-09: miswiring named (GPIO21, SDA, VCC)', await until(page, async () => { const t = (await w.textContent()) ?? ''; return ['GPIO21', 'SDA', 'VCC'].every((x) => t.includes(x)); }, 60000));
  check('OS-09: SDA absolute-maximum row', (await page.getByTestId('rating-DS1').locator('li[data-code="voltage"]').count()) === 1);
  await page.screenshot({ path: `${OUT}/os09.png` });
  await stop(page, 'OS-09');
});

await step('P2/P3', async () => {
  let doc = createProject({ projectId: `prj_live${Date.now()}`, deviceId: 'd', name: 'Live pin short', appVersion: '0' });
  const bd = addComponent(doc, 'board.esp32_devkitc_wroom32', { x: 400, y: 400 }); if (!bd.ok) throw new Error('board'); doc = bd.doc;
  const g = addComponent(doc, 'component.ground', { x: 700, y: 700 }); if (!g.ok) throw new Error('gnd'); doc = g.doc;
  for (const t of ['gnd', 'gpio2']) { const r = addWire(doc, at(bd.id, t), at(g.id, 'ref')); if (!r.ok) throw new Error(t); doc = r.doc; }
  const sk = setProgramText(doc, bd.id, readFileSync(`${REPO}/runtime/firmware/arduino/TbiGpioProof/TbiGpioProof.ino`, 'utf8')); if (!sk.ok) throw new Error('sketch');
  await importDoc(page, sk.doc);
  await build(page, 'P2/P3'); await run(page, 'P2/P3');
  const row = page.locator('[data-code="gpio_short_ground"]');
  check('P2/P3: short named, current not known, no value', await until(page, async () => (await row.getAttribute('data-unreliable')) === 'true' && ((await row.textContent()) ?? '').includes('current not known'), 60000));
  await stop(page, 'P2/P3');
});

await step('P4', async () => {
  const r = setProgramText(lcdExample(), 'U1', '#include "driver/gpio.h"\nvoid setup() {\n  pinMode(5, OUTPUT);\n  gpio_set_drive_capability(GPIO_NUM_5, GPIO_DRIVE_CAP_3);\n}\nvoid loop() { delay(1000); }\n');
  if (!r.ok) throw new Error(r.error);
  await importDoc(page, { ...r.doc, name: 'Live P4' });
  await build(page, 'P4');
  await T(page, 'view-code').click();
  check('P4: build lists drive_strength as unsupported', (await T(page, 'build-features').locator('li[data-feature="drive_strength"]').count()) === 1);
  await T(page, 'view-circuit').click(); await T(page, 'sim-run').click();
  check('P4: Run refused naming it', await until(page, async () => (await attr(page, 'sim-error', 'data-code')) === 'mcu_unsupported_features', 30000));
});

await step('OS-02 (informational)', async () => {
  await open(page, 'ohms-law');
  const t0 = Date.now(); await T(page, 'view-3d').click();
  const ok = await until(page, async () => /firstFrame/.test((await attr(page, 'view3d', 'data-open-ms')) ?? ''), 120000);
  check('OS-02: 3D first frame reached (timing informational: software rendering, no GPU)', ok, `${Date.now() - t0} ms; tier ${await attr(page, 'view3d', 'data-quality')}`);
  await T(page, 'view-circuit').click();
});

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await ctx.close(); await b.close();
console.log(`\n${n - f}/${n} passed`);
process.exit(f ? 1 : 0);
