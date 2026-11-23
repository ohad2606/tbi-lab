/**
 * TBI-018 s3d-7 test hygiene: tests in runtime/host and runtime/plans that start child processes must
 * not leave stray node / vite-node processes behind (DEV has 1 CPU; a stray listening host also holds a
 * port and a state lock). Static check of the test sources:
 *   - an async `spawn(` is only allowed in a file that kills its children in afterAll/afterEach;
 *   - a synchronous spawnSync / execFileSync with a `timeout` must use `killSignal: 'SIGKILL'`, so a
 *     child that ignores SIGTERM can not outlive the timeout.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const DIRS = ['runtime/host/tests', 'runtime/plans/tests'];

const files = DIRS.flatMap((d) =>
  readdirSync(join(ROOT, d))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `${d}/${f}`),
).filter((f) => !f.endsWith('s3d7-child-hygiene.test.ts'));

const code = (f: string) =>
  readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/** the argument text of every `name(` call (balanced parentheses) */
function calls(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${name}\\(`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

describe('child processes in host/plans tests are cleaned up', () => {
  it('the scan sees the known spawning tests', () => {
    const spawning = files.filter((f) => /\b(spawn|spawnSync)\(/.test(code(f)));
    expect(spawning).toEqual(
      expect.arrayContaining([
        'runtime/host/tests/sim-plans-boot-guard.test.ts',
        'runtime/host/tests/s3d2-e2e-fake-host.test.ts',
        'runtime/plans/tests/s3d6-repair.test.ts',
        'runtime/plans/tests/s3d7-repair-package.test.ts',
      ]),
    );
  });

  it.each(files)('%s', (f) => {
    const src = code(f);
    if (/\bspawn\(/.test(src))
      expect(src, 'async spawn without a kill in afterAll/afterEach').toMatch(
        /after(All|Each)\([\s\S]*?\.kill\(/,
      );
    for (const c of [...calls(src, 'spawnSync'), ...calls(src, 'execFileSync')])
      if (/\btimeout\s*:/.test(c)) expect(c).toMatch(/killSignal:\s*'SIGKILL'/);
  });
});
