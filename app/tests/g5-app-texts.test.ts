/** BETA-G3 text minors: button names and plain wording in the HE and EN bundles. */
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';

describe('app texts', () => {
  it('Hebrew messages name the Run button as it is shown', () => {
    const english = Object.entries(he).filter(([, v]) => /\bRun\b/.test(v));
    expect(english.map(([k]) => k)).toEqual([]);
    expect(he['sim.error.runtime.commands_rate_limited']).toContain(`לחצו על ${he['sim.run']} `);
  });

  it('the report disclosure says whose run and what is included in plain words', () => {
    expect(he['report.disclosure.item.run']).toMatch(/^אם ההרצה שייכת לכם: /);
    expect(en['report.disclosure.always']).toBe(
      'Every report includes the following, where relevant:',
    );
  });
});
