/** Product Alpha maintenance: project display-name comparison (ids remain the identity). */
import { describe, expect, it } from 'vitest';
import { firstAvailableName, projectNameKey, projectNameTaken } from '../src/index.js';

describe('project display-name key', () => {
  it('ignores surrounding whitespace, collapses inner runs and ignores Latin case', () => {
    const k = projectNameKey('My Bench');
    for (const v of ['  My Bench  ', 'my bench', 'MY   BENCH', 'My\tBench', 'My Bench']) {
      expect(projectNameKey(v), JSON.stringify(v)).toBe(k);
    }
  });

  it('treats Unicode-equivalent spellings as the same name (NFKC)', () => {
    expect(projectNameKey('Café')).toBe(projectNameKey('Café')); // decomposed vs composed
    expect(projectNameKey('Ｐroject')).toBe(projectNameKey('Project')); // full-width P
    expect(projectNameKey('שָׁ')).toBe(projectNameKey('שָׁ')); // Hebrew point order
  });

  it('ignores invisible directional marks, keeps Hebrew text as is', () => {
    expect(projectNameKey('‏מעגל‎')).toBe(projectNameKey('מעגל'));
    expect(projectNameKey('מעגל ראשון')).toBe('מעגל ראשון');
    expect(projectNameKey('מעגל ראשון')).not.toBe(projectNameKey('מעגל שני'));
  });

  it('never changes the stored string: the key is only for comparison', () => {
    const name = '  Café Bench  ';
    projectNameKey(name);
    expect(name).toBe('  Café Bench  ');
  });

  it('projectNameTaken compares keys', () => {
    expect(projectNameTaken('project', ['Project', 'Other'])).toBe(true);
    expect(projectNameTaken('Project 2', ['Project', 'Other'])).toBe(false);
  });

  it('firstAvailableName is deterministic and skips every taken variant', () => {
    const fmt = (n: number) => (n === 1 ? 'Project (copy)' : `Project (copy ${n})`);
    expect(firstAvailableName(['Project'], fmt)).toBe('Project (copy)');
    expect(firstAvailableName(['Project', 'project (COPY)'], fmt)).toBe('Project (copy 2)');
    expect(firstAvailableName(['Project', 'Project (copy 2)'], fmt)).toBe('Project (copy)');
    const names = ['Project', 'Project (copy)', 'Project (copy 2)'];
    expect(firstAvailableName(names, fmt)).toBe('Project (copy 3)');
    expect(firstAvailableName([...names].reverse(), fmt)).toBe('Project (copy 3)');
  });
});
