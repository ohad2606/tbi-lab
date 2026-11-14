/**
 * Test safety (docs/ops/TEST-SAFETY.md): every runtime test and e2e spec that can restart / stop a
 * service, kill a QEMU or session unit, or install configuration under /etc must go through the
 * service-mutation gate (runtime/tests/mutation-gate.ts), so a default run never changes a shared
 * instance. Static check over the sources, plus the gate's refusal logic.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowedTargets, mutationAllowed } from '../../runtime/tests/mutation-gate.ts';

const root = new URL('../../', import.meta.url).pathname;
const files = [
  ...readdirSync(join(root, 'runtime/tests'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `runtime/tests/${f}`),
  ...readdirSync(join(root, 'app/e2e'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `app/e2e/${f}`),
];
/** A sudo'd systemctl that changes a unit, or an install into /etc. */
const MUTATING =
  /['"]systemctl['"]\s*,\s*['"](restart|stop|start|kill|reload)['"]|['"]install['"][^\n]*\/etc\//;

describe('service-mutation gate', () => {
  it('every test that mutates a deployed instance uses the gate', () => {
    const offenders = files.filter((f) => {
      const text = readFileSync(join(root, f), 'utf8');
      return MUTATING.test(text) && !/from '[./]*(runtime\/tests\/)?mutation-gate\.js'/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('the known mutating tests are found by the check (it is not vacuous)', () => {
    const hits = files.filter((f) => MUTATING.test(readFileSync(join(root, f), 'utf8')));
    expect(hits).toEqual(
      expect.arrayContaining([
        'runtime/tests/s8-policy.runtime.test.ts',
        'runtime/tests/s28-assist.runtime.test.ts',
        'runtime/tests/s8-containment.runtime.test.ts',
        'runtime/tests/s8-deployed-policy.runtime.test.ts',
        'app/e2e/s18-r4b-real.spec.ts',
      ]),
    );
  });

  it('refuses without an opt-in naming the target', () => {
    expect(allowedTargets({})).toEqual([]);
    expect(mutationAllowed('tbi-s8', {})).toBe(false);
    expect(mutationAllowed('tbi-s8', { TBI_ALLOW_SERVICE_MUTATION: 'tbi' })).toBe(false);
    expect(mutationAllowed('', { TBI_ALLOW_SERVICE_MUTATION: 'tbi-s8' })).toBe(false);
    expect(allowedTargets({ TBI_ALLOW_SERVICE_MUTATION: ' tbi-s8 , tbi ' })).toEqual([
      'tbi-s8',
      'tbi',
    ]);
  });
});
