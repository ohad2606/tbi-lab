/**
 * Sprint 25 closure: the refusal of an undefined ESP32 input read names each pin with its own
 * cause (several pads of one register can be undefined for different reasons), in EN and HE.
 */
import { describe, expect, it } from 'vitest';
import { getLocale } from '../src/i18n/i18n.js';
import { engineErrorMessage } from '../src/sim/format.js';

const error = (inputs: { gpio: number; cause: string; voltage?: number }[], watchAll = false) =>
  ({
    code: 'gpio_input_undefined',
    components: ['U1'],
    param: `gpio${inputs[0]!.gpio}`,
    detail: { inputs, vil: 0.825, vih: 2.475, ...(watchAll ? { watchAll } : {}) },
  }) as unknown as Parameters<typeof engineErrorMessage>[1];

describe('gpio_input_undefined message', () => {
  for (const tag of ['en', 'he'] as const) {
    it(`${tag}: each pin is described with its own cause`, () => {
      const locale = getLocale(tag);
      const msg = engineErrorMessage(
        locale,
        error([
          { gpio: 4, cause: 'floating' },
          { gpio: 5, cause: 'unconnected' },
          { gpio: 13, cause: 'between_thresholds', voltage: 1.65 },
          { gpio: 12, cause: 'unconnected' },
        ]),
        null,
      );
      const one = (cause: string, pins: string, extra: Record<string, unknown> = {}) =>
        engineErrorMessage(locale, error([{ gpio: 0, cause, ...extra }]), null).replace(
          'GPIO0',
          pins,
        );
      expect(msg).toBe(
        [
          one('floating', 'GPIO4'),
          one('unconnected', 'GPIO5, GPIO12'),
          one('between_thresholds', 'GPIO13', { voltage: 1.65 }),
        ].join(' '),
      );
    });
  }

  it('a single cause is one sentence naming every pin (as before)', () => {
    const msg = engineErrorMessage(
      getLocale('en'),
      error([
        { gpio: 4, cause: 'floating' },
        { gpio: 5, cause: 'floating' },
      ]),
      null,
    );
    expect(msg.startsWith('⁦GPIO4, GPIO5⁩:')).toBe(true);
    expect(msg.match(/the program read/g)).toHaveLength(1);
  });

  it('unresolved reads: the band keeps its own text, the rest say the reads could not be told', () => {
    const msg = engineErrorMessage(
      getLocale('en'),
      error(
        [
          { gpio: 23, cause: 'unconnected' },
          { gpio: 34, cause: 'between_thresholds', voltage: 1.2 },
        ],
        true,
      ),
      null,
    );
    expect(msg).toContain('could not tell from the program which pins it reads');
    expect(msg).toContain('specifies no hysteresis');
  });

  it('unresolved reads with several non-band causes: one "could not tell" sentence for them', () => {
    const msg = engineErrorMessage(
      getLocale('en'),
      error(
        [
          { gpio: 23, cause: 'unconnected' },
          { gpio: 4, cause: 'floating' },
        ],
        true,
      ),
      null,
    );
    expect(msg.match(/could not tell from the program/g)).toHaveLength(1);
    expect(msg).toContain('GPIO23, GPIO4');
  });

  for (const tag of ['en', 'he'] as const)
    it(`${tag}: a sensor response into the band names the sensor, the pin and the voltage`, () => {
      const msg = engineErrorMessage(
        getLocale(tag),
        {
          code: 'sensor_level_undefined',
          components: ['U3', 'U1'],
          param: 'gpio14',
          detail: { gpio: 14, voltage: 1.6667, vil: 0.825, vih: 2.475 },
        } as unknown as Parameters<typeof engineErrorMessage>[1],
        null,
      );
      expect(msg).toContain('U3');
      expect(msg).toContain('\u2066GPIO14\u2069');
      expect(msg).toMatch(/1[.,]66\d* V/);
      expect(msg).toContain(tag === 'en' ? 'hysteresis' : 'היסטרזיס');
    });
});
