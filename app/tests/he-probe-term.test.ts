/** The Hebrew UI names the Probe tool with one term: the glossary's `probe`. */
import { describe, expect, it } from 'vitest';
import { GLOSSARY, applyGlossary } from '../src/i18n/glossary.js';
import { he } from '../src/i18n/messages.he.js';

describe('Hebrew Probe term', () => {
  const texts = applyGlossary(he, GLOSSARY.he!);

  it('no message uses an older word for the Probe tool', () => {
    const old = /בוחן|בוחנים|מצב ה?בדיקה|\(probe\)|גשש/;
    expect(Object.entries(texts).filter(([, v]) => old.test(v))).toEqual([]);
  });

  it('the welcome step names the measurement point through the glossary', () => {
    expect(he['firstRun.step3']).toContain('[[probe]]');
    expect(texts['firstRun.step3']).toContain('נקודת מדידה');
  });
});
