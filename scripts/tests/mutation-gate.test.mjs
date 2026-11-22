/**
 * Test safety (docs/ops/TEST-SAFETY.md): every runtime test, e2e spec and deploy script that can
 * change a deployed instance must go through the service-mutation gate, so no default run and no
 * unattended job changes a shared instance. Static check over the sources (with deliberately
 * un-gated fixtures proving the check fails), plus the gate's decision logic.
 *
 * Entry points detected (see ENTRY_POINTS):
 * - TypeScript tests/specs: sudo'd systemctl restart|stop|start|kill|reload; sudo install into /etc
 *   or /srv; writing files under /etc or /srv; sudo pkill/kill (except killing the children of the
 *   test's own relay, `'pkill', '-TERM', '-P'`). Gate: importing runtime/tests/mutation-gate.
 * - Shell scripts under deploy/: systemctl restart|stop|start|kill|reload|enable|disable; install /
 *   cp / rm / ln into /etc or /srv (literal or via $root/$page/$BUNDLES); tee into /etc. Gate: the
 *   TBI_ALLOW_SERVICE_MUTATION check (deploy/ops/require-mutation.sh or inline).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowedTargets, mutationAllowed } from '../../runtime/tests/mutation-gate.ts';

const root = new URL('../../', import.meta.url).pathname;
const walk = (dir, ext) =>
  readdirSync(join(root, dir)).flatMap((f) => {
    const rel = `${dir}/${f}`;
    if (statSync(join(root, rel)).isDirectory()) return f === 'node_modules' ? [] : walk(rel, ext);
    return f.endsWith(ext) ? [rel] : [];
  });

export const ENTRY_POINTS = {
  ts: [
    [
      'systemctl restart/stop/start/kill/reload',
      /['"]systemctl['"]\s*,\s*['"](restart|stop|start|kill|reload)['"]/,
    ],
    ['install into /etc or /srv', /['"]install['"][^\n]*['"`]\/(etc|srv)\//],
    [
      'write a file under /etc or /srv',
      /(writeFileSync|appendFileSync|['"]tee['"])[^\n]*['"`]\/(etc|srv)\//,
    ],
    [
      'pkill/kill via sudo (not the own relay)',
      /sudo\(\s*['"](pkill|kill)['"](?!\s*,\s*['"]-TERM['"]\s*,\s*['"]-P['"])/,
    ],
  ],
  sh: [
    [
      'systemctl restart/stop/start/kill/reload/enable/disable',
      /systemctl\s+(restart|stop|start|kill|reload|enable|disable)\b/,
    ],
    [
      'install/cp/rm/ln into /etc or /srv',
      /sudo\s+(install|cp|rm|ln|mv)\b[^\n]*(\/etc\/|\/srv\/|\$root|\$page|\$BUNDLES|\$\{?root)/,
    ],
    ['tee into /etc or /srv', /tee\s+[^\n]*\/(etc|srv)\//],
  ],
};
const GATED = {
  ts: /from '[./]*(runtime\/tests\/)?mutation-gate\.js'/,
  sh: /TBI_ALLOW_SERVICE_MUTATION|require_mutation_opt_in/,
};
/** The entry points a source uses, and whether it is gated. */
export function scan(text, kind) {
  const hits = ENTRY_POINTS[kind].filter(([, re]) => re.test(text)).map(([name]) => name);
  return { hits, gated: GATED[kind].test(text) };
}

const tsFiles = [...walk('runtime/tests', '.ts'), ...walk('app/e2e', '.ts'), ...walk('admin-app/e2e', '.ts')].filter(
  (f) => !f.endsWith('mutation-gate.ts'),
);
const shFiles = [...walk('deploy', '.sh'), ...walk('scripts', '.sh')].filter(
  (f) => !f.endsWith('require-mutation.sh'),
);
const report = [
  ...tsFiles.map((f) => ({ f, ...scan(readFileSync(join(root, f), 'utf8'), 'ts') })),
  ...shFiles.map((f) => ({ f, ...scan(readFileSync(join(root, f), 'utf8'), 'sh') })),
].filter((r) => r.hits.length > 0);

describe('service-mutation gate: static coverage', () => {
  it('every source with a mutation entry point is gated', () => {
    expect(report.filter((r) => !r.gated).map((r) => `${r.f}: ${r.hits.join(', ')}`)).toEqual([]);
  });

  it('the known entry points are found (the check is not vacuous)', () => {
    const files = report.map((r) => r.f);
    expect(files).toEqual(
      expect.arrayContaining([
        'runtime/tests/s8-policy.runtime.test.ts',
        'runtime/tests/s28-assist.runtime.test.ts',
        'runtime/tests/s8-containment.runtime.test.ts',
        'runtime/tests/s8-deployed-policy.runtime.test.ts',
        'runtime/tests/s13-deployed-security.runtime.test.ts',
        'runtime/tests/c5-deployed.runtime.test.ts',
        'app/e2e/s18-r4b-real.spec.ts',
        'deploy/dev-lab/s8/install.sh',
        'deploy/dev-lab/s8/switch-runtime.sh',
        'deploy/dev-lab/publish.sh',
        'deploy/dev-lab/rollback-runtime.sh',
      ]),
    );
    // Printed for the coverage table (TEST-SAFETY.md).
    console.log(JSON.stringify(report.map((r) => [r.f, r.hits, r.gated])));
  });

  it('a deliberately un-gated test fixture is flagged', () => {
    const text = readFileSync(
      join(root, 'scripts/tests/fixtures/ungated-mutation.fixture.txt'),
      'utf8',
    );
    expect(scan(text, 'ts')).toEqual({
      hits: ['systemctl restart/stop/start/kill/reload'],
      gated: false,
    });
    const gated = `import { mutationAllowed } from './mutation-gate.js';\n${text}`;
    expect(scan(gated, 'ts').gated).toBe(true);
  });

  it('a deliberately un-gated script fixture is flagged', () => {
    const text = readFileSync(
      join(root, 'scripts/tests/fixtures/ungated-script.fixture.txt'),
      'utf8',
    );
    const r = scan(text, 'sh');
    expect(r.gated).toBe(false);
    expect(r.hits).toEqual(
      expect.arrayContaining([
        'systemctl restart/stop/start/kill/reload/enable/disable',
        'install/cp/rm/ln into /etc or /srv',
      ]),
    );
  });

  it('own-relay cleanup (pkill -TERM -P <relay>) is not an entry point; other kills are', () => {
    expect(scan(`sudo('pkill', '-TERM', '-P', String(r.pid));`, 'ts').hits).toEqual([]);
    expect(scan(`sudo('pkill', 'node');`, 'ts').hits).toHaveLength(1);
    expect(scan(`sudo('kill', '-9', pid);`, 'ts').hits).toHaveLength(1);
  });
});

describe('service-mutation gate: decisions', () => {
  const yes = () => true;
  const no = () => false;
  it('no opt-in: refused (with or without the lock)', () => {
    expect(allowedTargets({})).toEqual([]);
    expect(mutationAllowed('tbi-s8', {}, yes)).toBe(false);
    expect(mutationAllowed('tbi-s8', {}, no)).toBe(false);
  });
  it('the opt-in names another target: refused', () => {
    expect(mutationAllowed('tbi-s8', { TBI_ALLOW_SERVICE_MUTATION: 'tbi' }, yes)).toBe(false);
  });
  it('the opt-in names the target but the lock is not held: refused', () => {
    expect(mutationAllowed('tbi-s8', { TBI_ALLOW_SERVICE_MUTATION: 'tbi-s8' }, no)).toBe(false);
  });
  it('both present: allowed', () => {
    expect(mutationAllowed('tbi-s8', { TBI_ALLOW_SERVICE_MUTATION: 'tbi,tbi-s8' }, yes)).toBe(true);
  });
  it('no instance named: refused', () => {
    expect(mutationAllowed('', { TBI_ALLOW_SERVICE_MUTATION: 'tbi-s8' }, yes)).toBe(false);
  });
  it('list parsing', () => {
    expect(allowedTargets({ TBI_ALLOW_SERVICE_MUTATION: ' tbi-s8 , tbi ' })).toEqual([
      'tbi-s8',
      'tbi',
    ]);
  });
});
