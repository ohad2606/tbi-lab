/**
 * The runtime release gate (scripts/release/runtime-gate.mjs) on made-up reports and a fake
 * runner: no emulator, no browser, no instance.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { G2_ENV, G2_NOT_COVERED } from '../../runtime/tests/g2-guard.ts';
import {
  evaluate,
  expectedFiles,
  normalizePlaywright,
  normalizeVitest,
  parseManifest,
  declaresExpectedFailure,
  sanitize,
} from '../release/runtime-gate-eval.mjs';
import { runGate } from '../release/runtime-gate.mjs';

const ROOT = '/work/repo';
const V = 'runtime/tests/a.runtime.test.ts';
const P = 'app/e2e/b-real.spec.ts';
const SHA = 'a'.repeat(40);
const TRACKED = [V, P, 'app/e2e/other.spec.ts', 'docs/x.runtime.test.ts.txt'];

const vTest = (title, status = 'passed', failureMessages = []) => ({
  ancestorTitles: ['suite'],
  title,
  status,
  failureMessages,
});
function vitestReport(tests = [vTest('one')], over = {}) {
  return {
    success: true,
    numTotalTests: tests.length,
    testResults: [{ name: `${ROOT}/${V}`, status: 'passed', assertionResults: tests }],
    ...over,
  };
}
const pTest = (status = 'expected', expectedStatus = 'passed', results) => ({
  status,
  expectedStatus,
  results: results ?? (status === 'skipped' ? [] : [{ status: 'passed', retry: 0 }]),
});
function playwrightReport(specs = [['one', pTest()]], over = {}) {
  const stats = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
  for (const [, t] of specs) stats[t.status]++;
  return {
    config: { rootDir: `${ROOT}/app/e2e` },
    errors: [],
    stats,
    suites: [
      {
        title: 'b-real.spec.ts',
        file: 'b-real.spec.ts',
        specs: [],
        suites: [
          {
            title: 'group',
            file: 'b-real.spec.ts',
            specs: specs.map(([title, t]) => ({ title, file: 'b-real.spec.ts', tests: [t] })),
          },
        ],
      },
    ],
    ...over,
  };
}

function judge({ v = vitestReport(), p = playwrightReport(), exits = {}, entries = [] } = {}) {
  return evaluate({
    expected: expectedFiles(TRACKED),
    manifest: parseManifest({ exclusions: entries }),
    runs: {
      vitest: { exitCode: 0, report: v && normalizeVitest(v, ROOT), ...exits.vitest },
      playwright: { exitCode: 0, report: p && normalizePlaywright(p, ROOT), ...exits.playwright },
    },
  });
}
const codes = (r) => r.failures.map((f) => f.code);
const entry = (over = {}) => ({
  runner: 'vitest',
  file: V,
  test: 'suite two',
  reason: 'cannot run here by design',
  ...over,
});

describe('expected files come from the committed tree', () => {
  it('runtime tests and *-real specs only', () => {
    expect(expectedFiles(TRACKED)).toEqual({ vitest: [V], playwright: [P] });
  });
});

describe('evaluation', () => {
  it('everything passed: no failures, counted', () => {
    const r = judge();
    expect(r.failures).toEqual([]);
    expect(r.counts.vitest).toMatchObject({ expectedFiles: 1, tests: 1, passed: 1, exitCode: 0 });
    expect(r.counts.playwright).toMatchObject({ reportedFiles: 1, passed: 1 });
  });
  it.each(['skipped', 'todo', 'failed', 'pending'])('a %s vitest test fails', (status) => {
    const r = judge({ v: vitestReport([vTest('one'), vTest('two', status)]) });
    expect(r.failures).toContainEqual(
      expect.objectContaining({ runner: 'vitest', file: V, test: 'suite two' }),
    );
  });
  it('a vitest test that passed on a retry is flaky and fails', () => {
    const r = judge({ v: vitestReport([vTest('one', 'passed', ['first attempt'])]) });
    expect(codes(r)).toContain('test_flaky');
  });
  it.each([
    ['test_skipped', pTest('skipped', 'skipped')],
    ['test_failed', pTest('unexpected', 'passed', [{ status: 'failed', retry: 0 }])],
    [
      'test_flaky',
      pTest('flaky', 'passed', [
        { status: 'failed', retry: 0 },
        { status: 'passed', retry: 1 },
      ]),
    ],
    ['test_expected_failure', pTest('expected', 'failed', [{ status: 'failed', retry: 0 }])],
    ['test_incomplete', pTest('expected', 'passed', [])],
  ])('playwright: %s', (code, t) => {
    const r = judge({
      p: playwrightReport([
        ['one', pTest()],
        ['two', t],
      ]),
    });
    expect(r.failures).toEqual([
      expect.objectContaining({ code, runner: 'playwright', file: P, test: 'group two' }),
    ]);
  });
  it('a file with zero tests, or missing from the report, fails', () => {
    expect(codes(judge({ v: vitestReport([]) }))).toContain('zero_tests');
    const none = judge({ v: vitestReport([], { testResults: [] }) });
    expect(codes(none)).toEqual(expect.arrayContaining(['missing_file', 'nothing_passed']));
    expect(codes(judge({ p: playwrightReport([], { suites: [] }) }))).toContain('missing_file');
  });
  it('a file the tree does not expect fails', () => {
    const v = vitestReport();
    v.testResults.push({ ...v.testResults[0], name: '/elsewhere/a.runtime.test.ts' });
    v.numTotalTests = 2;
    expect(codes(judge({ v }))).toContain('unexpected_file');
  });
  it('no report, a non-zero exit or a killed runner fails', () => {
    expect(codes(judge({ v: null }))).toEqual(['no_report']);
    for (const exitCode of [1, null])
      expect(codes(judge({ exits: { playwright: { exitCode } } }))).toEqual(['runner_exit']);
  });
  it('suite hooks, collection errors and truncated reports fail', () => {
    const failedFile = vitestReport();
    failedFile.testResults[0].status = 'failed';
    expect(codes(judge({ v: failedFile }))).toEqual(['file_failed']);
    expect(codes(judge({ v: vitestReport(undefined, { success: false }) }))).toEqual([
      'report_unsuccessful',
    ]);
    expect(codes(judge({ v: vitestReport(undefined, { numTotalTests: 5 }) }))).toEqual([
      'report_inconsistent',
    ]);
    expect(codes(judge({ p: playwrightReport(undefined, { errors: [{}] }) }))).toEqual([
      'report_errors',
    ]);
    expect(() => normalizeVitest({}, ROOT)).toThrow(/vitest/);
    expect(() => normalizePlaywright({ suites: [] }, ROOT)).toThrow(/playwright/);
  });
});

describe('per file', () => {
  const W = 'runtime/tests/w.runtime.test.ts';
  const two = (status) => {
    const v = vitestReport();
    v.testResults.push({
      name: `${ROOT}/${W}`,
      status: 'passed',
      assertionResults: [vTest('two', status)],
    });
    v.numTotalTests = 2;
    return evaluate({
      expected: expectedFiles([...TRACKED, W]),
      manifest: parseManifest({ exclusions: status === 'skipped' ? [entry({ file: W })] : [] }),
      runs: {
        vitest: { exitCode: 0, report: normalizeVitest(v, ROOT) },
        playwright: { exitCode: 0, report: normalizePlaywright(playwrightReport(), ROOT) },
      },
    });
  };
  it('a file in which nothing passed fails', () => {
    expect(two('todo').failures).toContainEqual(
      expect.objectContaining({ code: 'file_nothing_passed', file: W }),
    );
  });
  it('unless the whole file is excluded', () => {
    expect(two('skipped').failures).toEqual([]);
  });
  it('a partly excluded file with no pass fails', () => {
    const r = judge({
      v: vitestReport([vTest('two', 'skipped'), vTest('three', 'todo')]),
      entries: [entry()],
    });
    expect(codes(r)).toContain('file_nothing_passed');
  });
});

describe('expected failures declared in sources', () => {
  it.each([
    "it.fails('x', () => {});",
    "test.fails('x', () => {});",
    "it.skipIf(a(b)).fails('x', () => {});",
    "it.each([1, 2]).fails('x', () => {});",
    "it\n  .fails('x', () => {});",
    "it('x', { fails: true }, () => {});",
  ])('detects %j', (source) => {
    expect(declaresExpectedFailure(source)).toBe(true);
  });
  it('ignores other uses of the word', () => {
    expect(declaresExpectedFailure("if (lock.fails) x({ fails: false }); it('fails', f);")).toBe(
      false,
    );
  });
});

describe('exclusion manifest', () => {
  const skipped = vitestReport([vTest('one'), vTest('two', 'skipped')]);
  it('an excluded skip passes and is listed with its reason', () => {
    const r = judge({ v: skipped, entries: [entry()] });
    expect(r.failures).toEqual([]);
    expect(r.excluded).toEqual([
      {
        runner: 'vitest',
        file: V,
        test: 'suite two',
        status: 'skipped',
        reason: entry().reason,
      },
    ]);
    expect(r.counts.vitest).toMatchObject({ skipped: 1, excluded: 1 });
  });
  it('never excuses a failure or a flaky test', () => {
    for (const t of [vTest('two', 'failed'), vTest('two', 'passed', ['x'])]) {
      const r = judge({ v: vitestReport([vTest('one'), t]), entries: [entry()] });
      expect(r.excluded).toEqual([]);
      expect(codes(r)).toEqual(
        expect.arrayContaining(['stale_exclusion', expect.stringMatching(/^test_/)]),
      );
    }
  });
  it('stale: matches nothing, an unknown file, or also a test that passed', () => {
    expect(codes(judge({ entries: [entry()] }))).toEqual(['stale_exclusion']);
    expect(
      codes(
        judge({ v: skipped, entries: [entry({ file: 'runtime/tests/gone.runtime.test.ts' })] }),
      ),
    ).toEqual(expect.arrayContaining(['stale_exclusion', 'test_skipped']));
    expect(codes(judge({ v: skipped, entries: [entry({ test: 'suite' })] }))).toEqual([
      'stale_exclusion',
    ]);
  });
  it('a runner where everything is excluded has run nothing', () => {
    const r = judge({ v: vitestReport([vTest('two', 'skipped')]), entries: [entry()] });
    expect(codes(r)).toEqual(['nothing_passed']);
  });
  it('rejects entries without a reason, unknown keys and wildcards', () => {
    for (const bad of [
      entry({ reason: ' ' }),
      entry({ test: '' }),
      entry({ test: undefined }),
      entry({ file: 'runtime/tests/*.ts' }),
      entry({ runner: 'jest' }),
      { ...entry(), optional: true },
    ])
      expect(() => parseManifest({ exclusions: [bad] })).toThrow(/manifest/);
  });
});

/** Full titles ("describe … test") written in a test source; `${NAME}` is resolved from `names`. */
function sourceTitles(source, names) {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const root = (e) =>
    ts.isCallExpression(e) || ts.isPropertyAccessExpression(e) ? root(e.expression) : e.getText();
  const text = (n) => {
    if (ts.isStringLiteralLike(n)) return n.text;
    if (!ts.isTemplateExpression(n)) return undefined;
    let out = n.head.text;
    for (const span of n.templateSpans) {
      const value = names[span.expression.getText()];
      if (value === undefined) return out; // a prefix: the rest is only known at run time
      out += value + span.literal.text;
    }
    return out;
  };
  const titles = [];
  const walk = (node, outer) => {
    let inner = outer;
    if (ts.isCallExpression(node) && ['describe', 'test', 'it'].includes(root(node.expression))) {
      const title = node.arguments[0] && text(node.arguments[0]);
      if (title !== undefined) {
        inner = [...outer, title];
        if (!/(^|\.)describe\b/.test(node.expression.getText())) titles.push(inner.join(' '));
      }
    }
    ts.forEachChild(node, (child) => walk(child, inner));
  };
  walk(file, []);
  return titles;
}

describe('the committed exclusion manifest', () => {
  const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const entries = parseManifest(JSON.parse(read('scripts/release/runtime-gate.manifest.json')));
  const G2 = 'runtime/tests/g2-deployed.runtime.test.ts';
  const G2_SUITE = 'G2 deployed: queue, idle and builds under load on staging';
  const titles = (file) => {
    const source = read(file);
    const out = sourceTitles(source, { G2_ENV });
    // The todo titles come from an exported list.
    if (file === G2 && /for \(const title of G2_NOT_COVERED\) it\.todo\(title\);/.test(source))
      out.push(...G2_NOT_COVERED.map((t) => `${G2_SUITE} ${t}`));
    return out;
  };
  it('names only tests that exist', () => {
    for (const e of entries)
      expect(
        titles(e.file).filter((t) => t.startsWith(e.test)),
        `${e.file}: ${e.test}`,
      ).not.toEqual([]);
  });
  it('excludes every g2-deployed test, todos included, as not yet evidenced', () => {
    const g2 = entries.filter((e) => e.file === G2);
    const all = titles(G2);
    expect(all).toHaveLength(1 + G2_NOT_COVERED.length);
    for (const t of all) expect(g2.filter((e) => t.startsWith(e.test))).toHaveLength(1);
    for (const e of g2)
      expect(e.reason).toContain(
        'staging-only load harness, run separately (planned 3.12); no evidence yet',
      );
  });
});

describe('evidence redaction', () => {
  it('drops env values, paths, hosts and addresses', () => {
    const out = sanitize('case (my-inst) at /home/someone/x on box.example 10.1.2.3 http://h:1/p', [
      'my-inst',
      'box.example',
    ]);
    expect(out).toBe('case (<redacted>) at <redacted> on <redacted> <redacted> <redacted>');
  });
});

describe('the gate run (fake git and runners)', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'gate-test-'));
    dirs.push(d);
    return d;
  };
  const ENV = {
    TBI_RUNTIME_PROXY: 'http://127.0.0.1:7410',
    TBI_BUILD_PROXY: 'http://127.0.0.1:7420',
    TBI_S8_INSTANCE: 'secret-instance',
    TBI_C5_DEPLOYED: 'secret-instance',
    TBI_C5_FAULTS: '1',
    TBI_ALLOW_SERVICE_MUTATION: 'secret-instance',
  };
  function fake({ status = '', env = ENV, reports = true, after, lock = true, source = '' } = {}) {
    const root = tmp();
    const ran = [];
    let state = { sha: SHA, status };
    const deps = {
      root,
      env,
      log: () => {},
      holdsLock: () => lock,
      read: () => source,
      git: (args) =>
        args[0] === 'rev-parse'
          ? `${state.sha}\n`
          : args[0] === 'status'
            ? state.status
            : TRACKED.join('\0'),
      manifest: () => ({ exclusions: [] }),
      run: (step) => {
        ran.push(step);
        if (step.report && reports) {
          const r = step.name === 'vitest' ? vitestReport() : playwrightReport();
          if (step.name === 'vitest') r.testResults[0].name = join(root, V);
          else r.config.rootDir = join(root, 'app/e2e');
          writeFileSync(step.report, JSON.stringify(r));
        }
        if (after) state = { ...state, ...after };
        return 0;
      },
    };
    return { deps, ran, root };
  }
  const evidence = (out, suffix = '') =>
    JSON.parse(readFileSync(join(out, `runtime-gate-${SHA}${suffix}.json`), 'utf8'));

  it('PASS: runs both runners strictly and writes allowlisted evidence for the SHA', () => {
    const { deps, ran } = fake();
    const out = tmp();
    expect(runGate(['--out', out], deps)).toBe(0);
    expect(ran.map((s) => s.name)).toEqual(['host:build', 'vitest', 'playwright']);
    expect(ran[1].args).toEqual(expect.arrayContaining(['--retry=0', '--allowOnly=false']));
    expect(ran[2].args).toEqual(expect.arrayContaining(['--retries=0', '--forbid-only']));
    expect(ran[2].env.CI).toBe('1');
    // The opt-in is passed on as the operator set it, never added or widened.
    for (const s of ran) expect(s.env.TBI_ALLOW_SERVICE_MUTATION).toBe('secret-instance');
    const e = evidence(out);
    expect(e).toMatchObject({ sha: SHA, mode: 'run', verdict: 'PASS' });
    expect(Object.keys(e).sort()).toEqual([
      'counts',
      'excluded',
      'failures',
      'finishedAt',
      'mode',
      'schema',
      'sha',
      'startedAt',
      'verdict',
    ]);
    expect(JSON.stringify(e)).not.toMatch(/secret-instance|127\.0\.0\.1|gate-test-/);
  });
  it.each([
    ['dirty_tree', { status: '?? new.txt\n' }],
    ['no_real_proxy', { env: {} }],
    ['no_real_proxy', { env: { ...ENV, TBI_BUILD_PROXY: 'http://127.0.0.1:7498' } }],
    ['weakening_env', { env: { ...ENV, TBI_GATE_UNPINNED: '1' } }],
    ...[
      'TBI_S8_QEMU_CYCLES',
      'TBI_C5_SECONDS',
      'TBI_C5_N',
      'TBI_C5_WORKLOAD',
      'TBI_C5_PACE',
      'TBI_MPY_BENCH_N',
      'TBI_S11_EXPECT',
      'TBI_S12_EXPECT',
      'TBI_G2_DEPLOYED',
    ].map((name) => ['weakening_env', { env: { ...ENV, [name]: '1' } }]),
    ['weakening_env', { env: { ...ENV, TBI_C5_N: '' } }],
    ['fault_drills_off', { env: { ...ENV, TBI_C5_FAULTS: undefined } }],
    ['fault_drills_off', { env: { ...ENV, TBI_C5_FAULTS: 'true' } }],
    ['no_fault_optin', { env: { ...ENV, TBI_ALLOW_SERVICE_MUTATION: undefined } }],
    ['no_fault_optin', { env: { ...ENV, TBI_ALLOW_SERVICE_MUTATION: 'other' } }],
    ['no_fault_optin', { env: { ...ENV, TBI_C5_DEPLOYED: undefined } }],
    ['no_lock', { lock: false }],
    ['declared_expected_failure', { source: "it.fails('x', () => {});" }],
  ])('%s: FAIL before anything runs', (code, over) => {
    const { deps, ran } = fake(over);
    const out = tmp();
    expect(runGate(['--out', out], deps)).toBe(1);
    expect(ran).toEqual([]);
    expect(codes(evidence(out))).toContain(code);
  });
  it('redacts instance and unit values however short', () => {
    const env = {
      ...ENV,
      TBI_S8_INSTANCE: 'qz',
      TBI_C5_DEPLOYED: 'jx',
      TBI_ALLOW_SERVICE_MUTATION: 'jx, kv',
      TBI_S18_UNIT: 'w',
    };
    const { deps, root } = fake({ env });
    const run = deps.run;
    deps.run = (step) => {
      const code = run(step);
      if (step.name === 'vitest') {
        const r = vitestReport([vTest('one'), vTest('on qz jx kv w end', 'failed')]);
        r.testResults[0].name = join(root, V);
        writeFileSync(step.report, JSON.stringify(r));
      }
      return code;
    };
    const out = tmp();
    runGate(['--out', out], deps);
    const failed = evidence(out).failures.find((f) => f.code === 'test_failed');
    expect(failed.test).not.toMatch(/qz|jx|kv|\bw\b/);
    expect(failed.test).toMatch(/<redacted> <redacted> <redacted> <redacted>/);
  });
  it('a tree or HEAD that changed during the run fails', () => {
    for (const after of [{ status: ' M x\n' }, { sha: 'b'.repeat(40) }]) {
      const { deps } = fake({ after });
      const out = tmp();
      expect(runGate(['--out', out], deps)).toBe(1);
      expect(codes(evidence(out))).toContain('tree_changed');
    }
  });
  it('runners that write no report fail; an older PASS for the SHA is not left behind', () => {
    const out = tmp();
    runGate(['--out', out], fake().deps);
    expect(runGate(['--out', out], fake({ reports: false }).deps)).toBe(1);
    expect(codes(evidence(out))).toEqual(['no_report', 'no_report']);
  });
  it('--from-reports never yields a release PASS and runs nothing', () => {
    const { deps, ran, root } = fake();
    const reports = tmp();
    const v = vitestReport();
    v.testResults[0].name = join(root, V);
    const p = playwrightReport();
    p.config.rootDir = join(root, 'app/e2e');
    writeFileSync(join(reports, 'vitest.json'), JSON.stringify(v));
    writeFileSync(join(reports, 'playwright.json'), JSON.stringify(p));
    const out = tmp();
    expect(runGate(['--out', out, '--from-reports', reports], deps)).toBe(3);
    expect(ran).toEqual([]);
    expect(evidence(out, '.evaluation').verdict).toBe('EVALUATION_ONLY');
    expect(existsSync(join(out, `runtime-gate-${SHA}.json`))).toBe(false);
  });
  it('usage: unknown flags and an --out inside the repository are refused', () => {
    const { deps, ran, root } = fake();
    for (const argv of [
      [],
      ['--out', tmp(), '--allow-skips'],
      ['--out', root],
      ['--out', join(root, 'evidence')],
    ])
      expect(runGate(argv, deps)).toBe(2);
    expect(ran).toEqual([]);
  });
});
