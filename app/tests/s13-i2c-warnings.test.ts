/**
 * Sprint 13 OS-09: the Session Host's I2C diagnostics reach the user as specific, actionable text
 * (which part, which pad, which pin), not as "Runtime warning: i2c_wiring", in every locale.
 */
import { describe, expect, it } from 'vitest';
import { LOCALES, translate, type MessageKey } from '../src/i18n/i18n.js';
import { i2cWarningText } from '../src/ui/McuPanel.js';

describe('OS-09: I2C diagnostics are explained', () => {
  for (const locale of LOCALES) {
    const t = ((key: MessageKey, params?: Record<string, string>) =>
      translate(locale, key, params)) as Parameters<typeof i2cWarningText>[0];
    it(`${locale.code}: an I2C line on the module's VCC pin names the pad, the line and the pin`, () => {
      const text = i2cWarningText(t, {
        code: 'i2c_wiring',
        detail: { component: 'U2', line: 'sda', gpio: 21, terminal: 'vcc', reason: 'supply_pin' },
      })!;
      for (const token of ['U2', 'GPIO21', 'SDA', 'VCC']) expect(text).toContain(token);
      expect(text).not.toContain('i2c_wiring');
    });
    it(`${locale.code}: swapped lines, missing pull-ups and logic levels each have their text`, () => {
      const swapped = i2cWarningText(t, {
        code: 'i2c_wiring',
        detail: { component: 'U2', sda: 21, scl: 22, reason: 'swapped' },
      })!;
      expect(swapped).toContain('GPIO21');
      expect(swapped).toContain('GPIO22');
      const lines = [{ line: 'sda', gpio: 21 }];
      expect(
        i2cWarningText(t, { code: 'i2c_no_pullup', detail: { component: 'U2', lines } }),
      ).toContain('SDA');
      expect(
        i2cWarningText(t, { code: 'i2c_logic_level', detail: { component: 'U2', lines } }),
      ).toContain('SDA');
      expect(i2cWarningText(t, { code: 'something_else' })).toBeNull();
    });
  }
});
