/** BETA-G3 text minors: button names and plain wording in the HE and EN bundles. */
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';

describe('app texts', () => {
  it('Hebrew messages name the Run button as it is shown', () => {
    const english = Object.entries(he).filter(([, v]) => /\bRun\b/.test(v));
    expect(english.map(([k]) => k)).toEqual([]);
    expect(he['sim.error.runtime.commands_rate_limited']).toContain(`לחצו על „${he['sim.run']}” `);
    // Every "press Run" sentence quotes the button name.
    const unquoted = Object.entries(he).filter(([, v]) => v.includes(`לחצו על ${he['sim.run']}`));
    expect(unquoted.map(([k]) => k)).toEqual([]);
  });

  it('Hebrew sentences quote the Run and Stop button names as „…”', () => {
    const names = `(?:${he['sim.run']}|${he['sim.stop']})`;
    // "press X", "press X and then Y", and a name in any other quotation marks.
    const bad = new RegExp(`(?:לחצו|לחצו על|ואז|ואז על) ${names}(?![א-ת])|["״“]${names}["״”]`);
    const found = Object.entries(he).filter(([, v]) => bad.test(v));
    expect(found.map(([k]) => k)).toEqual([]);
  });

  it('the report disclosure says whose run and what is included in plain words', () => {
    expect(he['report.disclosure.item.run']).toMatch(/^אם ההרצה שייכת לכם: /);
    expect(en['report.disclosure.always']).toBe(
      'Every report includes the following, where relevant:',
    );
  });
});
