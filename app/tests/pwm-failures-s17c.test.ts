/**
 * Sprint 17C: every PWM refusal the Session Host can send (`pwm_unsupported`, its detail `code`
 * and, for an unrepresentable LEDC mode, its `why`) reaches the user as a named, translated
 * message in English and Hebrew: no raw keys, no unfilled placeholders, the pads and parts named.
 * And a supply's reading names the servos whose (unmodelled) current it leaves out.
 */
import { describe, expect, it } from 'vitest';
import { PWM_CODES, pwmFailure } from '../src/runtime/controller.js';
import { simFailureMessage } from '../src/sim/format.js';
import { getLocale, isMessageKey } from '../src/i18n/i18n.js';
import { servosOnSupply } from '../src/sim/servoSupply.js';
import { newDoc } from '../../packages/domain/tests/helpers.js';
import { place, wire } from '../../packages/domain/tests/circuits.js';

/**
 * The `why` values the host produces: QEMU's channel refusals (runtime/harness/protocol.ts
 * LedcChannelState), `timer-` + the timer states it refuses (runtime/host/pwm.ts waveform()), and
 * the host's own (open drain, GPIO-matrix inversion).
 */
const WHY = [
  'low-speed',
  'interrupt',
  'dither',
  'fade',
  'hpoint',
  'timer-reset',
  'timer-paused',
  'timer-resolution',
  'timer-divider',
  'timer-apb-clock',
  'open-drain',
  'inverted',
];

describe('PWM refusals in the app (Sprint 17C)', () => {
  for (const locale of [getLocale('en'), getLocale('he')])
    for (const code of PWM_CODES)
      it(`${locale.code}: ${code} is named, with its pads and parts`, () => {
        const failure = pwmFailure({
          code,
          gpios: [18, 19],
          components: ['PSU1', 'LED1'],
          inputs: [5],
          why: 'fade',
        });
        expect(failure).toMatchObject({ kind: 'pwm', code, gpios: [18, 19] });
        const text = simFailureMessage(locale, failure, null);
        expect(text).not.toMatch(/[{}]|sim\.(error|pwm)\./);
        expect(text).toContain('GPIO18');
        if (code === 'pwm_input_unsupported') expect(text).toContain('GPIO5');
        else if (code !== 'pwm_unsupported_mode') expect(text).toContain('PSU1');
      });

  it('a single-pad detail (`gpio`) is named too; an unknown code stays generic', () => {
    expect(pwmFailure({ code: 'pwm_duty_zero_unverified', gpio: 2 })).toMatchObject({ gpios: [2] });
    expect(pwmFailure({ code: 'pwm_something_new' })).toEqual({
      kind: 'runtime',
      code: 'pwm_unsupported',
    });
  });

  it('every LEDC mode the host can refuse has an explanation in both languages', () => {
    for (const why of WHY) {
      expect(isMessageKey(`sim.pwm.why.${why}`), why).toBe(true);
      for (const locale of [getLocale('en'), getLocale('he')]) {
        const text = simFailureMessage(
          locale,
          pwmFailure({ code: 'pwm_unsupported_mode', gpio: 18, why }),
          null,
        );
        expect(text).not.toMatch(/[{}]|sim\.pwm\.why/);
      }
    }
  });
});

describe('a supply reading names the servos it leaves out (Sprint 17C, R4-D3)', () => {
  it('servos wired to the supply output are listed; others are not', () => {
    let doc = newDoc();
    const on = place(doc, 'component.servo_sg90', 300, -20);
    doc = on.doc;
    const off = place(doc, 'component.servo_sg90', 300, 200);
    doc = off.doc;
    const r = place(doc, 'component.resistor', 100, 200);
    doc = r.doc;
    doc = wire(doc, ['PSU1', 'positive'], [on.id, 'vcc']);
    // Through a resistor: not on the supply's own output net (its supply is the documented
    // "weak supply, not shown sagging" limitation, limitation.servo_supply_current).
    doc = wire(doc, ['PSU1', 'positive'], [r.id, 'a']);
    doc = wire(doc, [r.id, 'b'], [off.id, 'vcc']);
    expect(servosOnSupply(doc, 'PSU1')).toEqual([on.id]);
    expect(servosOnSupply(doc, 'NOPE')).toEqual([]);
    expect(servosOnSupply(null, 'PSU1')).toEqual([]);
  });
});
