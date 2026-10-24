/**
 * A8 / A9: complete English and Hebrew; RTL chrome with an LTR canvas; switching language
 * changes no project byte and does not move the circuit.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  component,
  createProject,
  place,
  storedProject,
  waitForStoredProject,
  waitSaved,
  wire,
  scannedText,
} from './helpers.js';

/** Words of Latin script left in the UI once allowed technical tokens are removed. */
async function untranslatedWords(page: Page): Promise<string[]> {
  // Unit symbols with an SI prefix (mΩ, kΩ, GΩ, mA) are technical tokens, not words.
  // (Not after a letter: the V of "CV" is part of a word, not a unit.)
  const text = (await scannedText(page)).replace(/(?<![A-Za-z])[kmMGµunp]?[ΩVA](?![A-Za-z])/g, ' ');
  const allowed = [
    /^TBI$/,
    /^Lab$/, // product name
    /^(ESP32|DevKitC|GPIO\d+)$/, // Classic ESP32 technical tokens: MCU, board, pin names (Sprint 6)
    /^English$/, // the language's autonym in the language menu
    /^tbilab$/, // the project file extension (.tbilab), a technical token
    /^(PSU|R|GND|D|SW)\d+$/, // reference designators (SW: Sprint 4 switches)
    /^(GND|LED|DC|CV|CC)$/, // technical terms kept in Hebrew by the glossary
    /^Vishay$/,
    /^TLHR5400$/, // LED model card name
    /^(RGB|NPN|LDR|PIR|NC|NO|COM|RC|GL5528|N3904|HC|SR501|F)$/, // Sprint 10: part numbers and standard acronyms (technical tokens)
    /^(HIGH|LOW|ADC|Flyback|lx)$/, // Sprint 11: logic levels, ADC, flyback (kept in English by the glossary rule, CLAUDE.md) and the lux symbol
    /^N4148$/, // the 1N4148 diode model (tokenized after its leading digit)
    /^(LCD|I2C|SR04|DHT22|AM2302|PCF8574|Wire|Pull|pull|up|down)$/, // Sprint 12: part numbers, I2C/LCD, the Wire library, Pull-up (glossary rule)
    /^(PWM|LEDC|SG90|TowerPro|analogWrite|ledcWrite|ledcDetach|digitalWrite|Hz|kHz|ms|us)$/, // Sprint 15 (R4): PWM/LEDC, the SG90, Arduino PWM API names, frequency/time units
    /^(AND|NAND|OR|NOT|SN74LVC1G\d\d|SN74LVC08A?|TI|SOT|SOIC|Y|B|C|D|VCC|MicroPython|KOA|CF1|CFS1|W)$/, // Sprint 19B: gate functions and pin names (datasheet tokens), part numbers, packages, MicroPython, resistor series, the watt
    /^I$/, // the current symbol in formulas such as I = V / R (example summaries)
    /^N_\d+$/, // net ids
    /^(k|m|M|G|µ|u|n|p)?(Ω|V|A)$/,
    /^m(Ω|V|A)$/, // units
    /^Esc$/,
    /^Delete$/,
    /^R$/, // key names on the keyboard
    /^a$/,
    /^b$/, // language-neutral terminal ids
    /^k$/,
    /^\d+k\d*$/, // value examples such as 1k, 4k7
  ];
  const words = text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return [...new Set(words.filter((w) => !allowed.some((re) => re.test(w))))];
}

test('Hebrew: every shipped screen is translated, chrome is RTL, canvas stays LTR', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('פרויקטים');
  expect(await untranslatedWords(page)).toEqual([]);

  await page.getByTestId('create-project').click();
  await waitSaved(page);
  await place(page, 'component.resistor', { x: 0, y: 0 });
  await wire(page, ['PSU1', 'positive'], ['R1', 'a']);
  await waitSaved(page);
  // Editor with a component selected: palette, canvas, inspector and hints all in Hebrew.
  await component(page, 'R1').locator('.component-hit').click();
  await expect(page.getByTestId('inspector')).toContainText('התנגדות');
  expect(await untranslatedWords(page)).toEqual([]);
  // An inspector validation message in Hebrew.
  const field = page.getByTestId('param-R1-resistance');
  await field.fill('1,5k');
  await field.press('Enter');
  await expect(page.getByTestId('param-R1-resistance-error')).toContainText('נקודה');
  expect(await untranslatedWords(page)).toEqual([]);

  // Layout: the chrome mirrors (palette on the right, inspector on the left) ...
  const palette = (await page.locator('.palette').boundingBox())!;
  const inspector = (await page.locator('.inspector').boundingBox())!;
  const canvas = (await page.getByTestId('canvas').boundingBox())!;
  expect(palette.x).toBeGreaterThan(canvas.x);
  expect(inspector.x).toBeLessThan(canvas.x);
  // ... while the canvas and its technical text stay LTR.
  expect(await page.locator('.canvas-wrap').evaluate((el) => getComputedStyle(el).direction)).toBe(
    'ltr',
  );
  expect(await page.getByTestId('value-R1').evaluate((el) => getComputedStyle(el).direction)).toBe(
    'ltr',
  );
  expect(await field.evaluate((el) => getComputedStyle(el).direction)).toBe('ltr');
  expect(
    await page.getByTestId('inspector-ref').evaluate((el) => getComputedStyle(el).direction),
  ).toBe('ltr');
  await expect(page.getByTestId('value-R1')).toHaveText('1 kΩ');
});

test('English: every shipped screen reads in English with LTR chrome', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await page.getByTestId('create-project').click();
  await waitSaved(page);
  const palette = (await page.locator('.palette').boundingBox())!;
  const canvas = (await page.getByTestId('canvas').boundingBox())!;
  expect(palette.x).toBeLessThan(canvas.x);
  // The only Hebrew allowed is the language menu's own name for Hebrew (its autonym).
  const text = (await scannedText(page)).replace('עברית', '');
  expect(text).not.toMatch(/[֐-׿]/);
});

test('A9: switching language changes no project byte and does not move the circuit', async ({
  page,
}) => {
  await createProject(page, 'Divider — מחלק מתח');
  await place(page, 'component.resistor', { x: 0, y: 0 });
  await place(page, 'component.resistor', { x: 0, y: 100 });
  await wire(page, ['PSU1', 'positive'], ['R1', 'a']);
  await wire(page, ['R1', 'b'], ['R2', 'a']);
  await page.keyboard.press('Escape');
  // Baseline only once the last wire is durable; otherwise a pending autosave could land
  // during the language loop and be mistaken for a language-caused write.
  const baseline = await waitForStoredProject(
    page,
    (d) => d.connections.some((c) => c.component === 'R2' && c.terminal === 'a'),
    'R1.b to R2.a wired',
  );
  await waitSaved(page);

  const bytesBefore = JSON.stringify(baseline);
  // Positions are compared relative to the canvas element: the chrome around it mirrors
  // (which moves the canvas on screen), the circuit inside it must not.
  const inCanvas = async () => {
    const c = (await page.getByTestId('canvas').boundingBox())!;
    const r = (await component(page, 'R1').locator('.symbol').boundingBox())!;
    return { x: r.x - c.x, y: r.y - c.y, width: r.width, height: r.height, canvasWidth: c.width };
  };
  const r1Before = await inCanvas();
  const viewBoxBefore = await page.getByTestId('canvas').getAttribute('viewBox');
  // The drawn wire geometry (path data since Sprint 5; it must really be there).
  const wiresBefore = await page
    .locator('.wires .wire')
    .evaluateAll((els) => els.map((e) => e.getAttribute('d')));
  expect(wiresBefore.length).toBeGreaterThan(0);
  expect(wiresBefore.every((d) => typeof d === 'string' && d.startsWith('M'))).toBe(true);

  for (const locale of ['he', 'en', 'he']) {
    await page.getByTestId('language-select').selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await page.waitForTimeout(400); // longer than the autosave debounce: nothing may be written
    expect(JSON.stringify(await storedProject(page))).toBe(bytesBefore);
    expect(await inCanvas()).toEqual(r1Before);
    expect(await page.getByTestId('canvas').getAttribute('viewBox')).toBe(viewBoxBefore);
    expect(
      await page.locator('.wires .wire').evaluateAll((els) => els.map((e) => e.getAttribute('d'))),
    ).toEqual(wiresBefore);
  }
  // The user-authored name is shown verbatim in either language.
  await expect(page.getByTestId('project-name')).toHaveValue('Divider — מחלק מתח');
});

test('the language choice is remembered per device, not stored in the project', async ({
  page,
}) => {
  await createProject(page, 'Prefs');
  await page.getByTestId('language-select').selectOption('he');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const doc = await storedProject(page);
  expect(JSON.stringify(doc)).not.toMatch(/"(he|en)"|locale|rtl/);
});
