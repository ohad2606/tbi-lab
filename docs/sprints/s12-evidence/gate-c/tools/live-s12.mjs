// Sprint 12 Gate C live acceptance on dev-lab: the DEPLOYED frontend through the gate's internal
// origin, the deployed build service, Session Host and Runtime v2 (real QEMU).
//   node live-s12.mjs <base> <shots dir> <user prefix>
// English: the three S12 examples (R2 HC-SR04, R2 DHT22, R3 I2C LCD) with live part parameters,
// the two S11 examples, the S11 refusals. Hebrew: an S12 example end to end (RTL chrome, LTR serial,
// HE part names). Limits: a second user is refused while a session runs; Stop leaves no session.
import { chromium } from '@playwright/test';
const [, , BASE, OUT, WHO] = process.argv;
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const mk = async (user) => b.newContext({ viewport: { width: 1400, height: 860 }, extraHTTPHeaders: { 'x-forwarded-user': user } });
const ctx = await mk(`${WHO}-a`);
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
let n = 0, f = 0; const check = (name, ok, d = '') => { n++; if (!ok) f++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d ? '  — ' + d : ''}`); };
const until = async (p, fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn().catch(() => false)) return true; await p.waitForTimeout(200); } return false; };
const T = (p, id) => p.getByTestId(id);
const C = (p, id) => p.locator(`[data-hit="component"][data-id="${id}"]`);
const attr = (p, id, a) => T(p, id).getAttribute(a).catch(() => null);
const level = (p, g) => p.locator(`[data-testid="pin-level-${g}"]`).getAttribute('data-level').catch(() => null);
const serial = async (p) => (await T(p, 'mcu-serial-output').textContent().catch(() => '')) ?? '';
const select = (p, id) => C(p, id).locator('.component-hit').click({ force: true });
const ONLY = process.env.STEPS?.split(',');
const step = async (name, fn) => { if (ONLY && !ONLY.includes(name)) return; try { await fn(); } catch (e) { check(name, false, String(e).split('\n')[0]); } };
const open = async (p, id) => {
  await p.goto(BASE); await T(p, 'example-list').or(T(p, 'canvas')).first().waitFor({ timeout: 30000 });
  if (!(await T(p, 'example-list').isVisible())) { await T(p, 'app-menu-button').click(); await T(p, 'menu-projects').click(); }
  await T(p, `open-example-${id}`).click(); await T(p, 'canvas').waitFor();
};
const build = async (p, id) => {
  await T(p, 'view-code').click(); await T(p, 'build-button').click();
  check(`${id}: Build -> current`, await until(p, async () => (await attr(p, 'build-phase', 'data-phase')) === 'current', 300000));
  await T(p, 'view-circuit').click();
};
const run = async (p, id) => {
  await T(p, 'sim-run').click();
  check(`${id}: Run -> running on the board (mcu)`, await until(p, async () => (await attr(p, 'sim-status', 'data-status')) === 'running' && (await attr(p, 'sim-status', 'data-engine')) === 'mcu', 90000));
};
const stop = async (p, id) => {
  await T(p, 'sim-stop').click();
  check(`${id}: Stop -> stopped`, await until(p, async () => (await attr(p, 'sim-status', 'data-status')) === 'stopped', 60000));
};
const param = async (p, part, key, v) => {
  await select(p, part); const field = T(p, `param-${part}-${key}`);
  await field.fill(String(v)); await field.press('Enter');
};

await step('distance', async () => {
  const id = 'esp32-distance-alarm';
  await open(page, id); await build(page, id); await run(page, id);
  await select(page, 'U1');
  check(`${id}: 0.5 m printed (Distance: 50.x cm)`, await until(page, async () => /Distance: 50\.\d cm/.test(await serial(page)), 90000));
  check(`${id}: LED off at 0.5 m`, (await level(page, 2)) === '0');
  await param(page, 'U2', 'distance', 0.1);
  check(`${id}: 0.1 m -> LED on (GPIO2 high)`, await until(page, async () => (await level(page, 2)) === '1', 30000));
  await select(page, 'U1');
  check(`${id}: 10.x cm printed`, await until(page, async () => /Distance: 10\.\d cm/.test(await serial(page)), 30000));
  await page.screenshot({ path: `${OUT}/en-distance-alarm.png` });

  // Limit: another user is refused while this session runs (one runtime session on this host).
  const ctxB = await mk(`${WHO}-b`); const pb = await ctxB.newPage();
  await open(pb, 'esp32-blink'); await build(pb, 'esp32-blink (user B)');
  await T(pb, 'sim-run').click();
  const refused = await until(pb, async () => (await attr(pb, 'sim-status', 'data-status')) === 'failed', 90000);
  check('limit: user B refused while A runs (failed, explicit message)', refused && await T(pb, 'sim-error').isVisible(), `${await attr(pb, 'sim-error', 'data-code')}: ${(await T(pb, 'sim-error').innerText().catch(() => '')).slice(0, 120)}`);
  check('limit: user A unaffected (still running)', (await attr(page, 'sim-status', 'data-status')) === 'running');
  await ctxB.close();

  await param(page, 'U2', 'distance', 1);
  check(`${id}: 1 m -> LED off`, await until(page, async () => (await level(page, 2)) === '0', 30000));
  await stop(page, id);
});

await step('thermo', async () => {
  const id = 'esp32-thermo-hygrometer';
  await open(page, id); await build(page, id); await run(page, id);
  await select(page, 'U1');
  check(`${id}: prints 21.5 C / 55.0 %`, await until(page, async () => (await serial(page)).includes('Temperature: 21.5 C  Humidity: 55.0 %'), 90000));
  await param(page, 'U2', 'temperature', -7.3);
  await select(page, 'U1');
  check(`${id}: prints -7.3 C after the live change`, await until(page, async () => (await serial(page)).includes('Temperature: -7.3 C  Humidity: 55.0 %'), 30000));
  await page.screenshot({ path: `${OUT}/en-thermo.png` });
  await stop(page, id);
});

await step('lcd', async () => {
  const id = 'esp32-lcd-hello';
  await open(page, id); await build(page, id); await run(page, id);
  await select(page, 'DS1');
  check(`${id}: line 1 'Hello, ESP32!'`, await until(page, async () => ((await T(page, 'result-state-line1').textContent()) ?? '').trim() === 'Hello, ESP32!', 90000));
  check(`${id}: line 2 'Up: N s'`, await until(page, async () => /^Up: \d+ s/.test((await T(page, 'result-state-line2').textContent()) ?? ''), 30000));
  check(`${id}: backlight on, text drawn`, (await C(page, 'DS1').getAttribute('data-backlight')) === 'true' && await C(page, 'DS1').getByTestId('lcd-text').isVisible());
  await page.screenshot({ path: `${OUT}/en-lcd.png` });
  await stop(page, id);
});

await step('s11-motion', async () => {
  const id = 'esp32-motion-relay';
  await open(page, id); await build(page, id); await run(page, id);
  check(`${id}: idle GPIO4 low`, await until(page, async () => (await level(page, 4)) === '0', 60000));
  await T(page, 'actuator-U2').click();
  check(`${id}: motion -> relay energized, buzzer sounding`, await until(page, async () => (await C(page, 'K1').getAttribute('data-energized')) === 'true' && (await C(page, 'BZ1').getAttribute('data-sounding')) === 'true', 30000));
  await T(page, 'actuator-U2').click();
  check(`${id}: no motion -> relay released`, await until(page, async () => (await C(page, 'K1').getAttribute('data-energized')) === 'false', 30000));
  await stop(page, id);
});

await step('s11-night', async () => {
  const id = 'esp32-night-light';
  await open(page, id); await build(page, id); await run(page, id);
  await param(page, 'LDR1', 'illuminance', 1);
  check(`${id}: dark -> GPIO4 high`, await until(page, async () => (await level(page, 4)) === '1', 30000));
  await param(page, 'LDR1', 'illuminance', 300);
  check(`${id}: bright -> GPIO4 low`, await until(page, async () => (await level(page, 4)) === '0', 30000));
  await stop(page, id);
});

await step('refusals', async () => {
  await open(page, 'esp32-motion-relay');
  check('capacitor refused next to the board', (await T(page, 'palette-component.capacitor').getAttribute('data-unavailable')) === 'part_time_dependent');
  check('matrix refused next to the board', (await T(page, 'palette-display.led_matrix_8x8').getAttribute('data-unavailable')) === 'part_needs_runtime');
  check('S12 parts offered next to the board (not refused)', !(await T(page, 'palette-sensor.hc_sr04').getAttribute('data-unavailable')) && !(await T(page, 'palette-sensor.dht22').getAttribute('data-unavailable')) && !(await T(page, 'palette-display.lcd1602_i2c').getAttribute('data-unavailable')));
});

await step('hebrew', async () => {
  const id = 'esp32-distance-alarm';
  await open(page, id);
  await T(page, 'language-select').selectOption('he');
  check('HE: RTL chrome', (await page.evaluate(() => document.documentElement.dir)) === 'rtl');
  check('HE: HC-SR04 palette name', ((await T(page, 'palette-sensor.hc_sr04').textContent()) ?? '').includes('חיישן מרחק אולטרסוני'), await T(page, 'palette-sensor.hc_sr04').textContent());
  check('HE: DHT22 palette name', ((await T(page, 'palette-sensor.dht22').textContent()) ?? '').includes('חיישן טמפרטורה ולחות'));
  check('HE: LCD palette name', ((await T(page, 'palette-display.lcd1602_i2c').textContent()) ?? '').includes('צג LCD'));
  await build(page, `${id} (HE)`); await run(page, `${id} (HE)`);
  await select(page, 'U1');
  check('HE: firmware output unchanged (Distance: 50.x cm)', await until(page, async () => /Distance: 50\.\d cm/.test(await serial(page)), 90000));
  const dir = await T(page, 'mcu-serial-output').evaluate((e) => getComputedStyle(e).direction);
  check('HE: serial monitor stays LTR', dir === 'ltr', dir);
  await param(page, 'U2', 'distance', 0.1);
  check('HE: same electrical result (0.1 m -> LED on)', await until(page, async () => (await level(page, 2)) === '1', 30000));
  await page.screenshot({ path: `${OUT}/he-distance-alarm.png` });
  await stop(page, `${id} (HE)`);
  await T(page, 'language-select').selectOption('en');
});

check('no page errors', errors.length === 0, errors.join(' | '));
console.log(`${n - f}/${n} checks passed`);
await b.close();
