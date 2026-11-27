/**
 * The runtime release gate (scripts/release/runtime-gate.mjs) on made-up reports and a fake
 * runner: no emulator, no browser, no instance.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { G2_ENV, G2_STAGING } from '../../runtime/tests/g2-guard.ts';
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
    "it['fails']('x', () => {});",
    'test["fails"](\'x\', () => {});',
    "it[`fails`]('x', () => {});",
    "it.each([1])['fails']('x', () => {});",
    "it?.['fails']('x', () => {});",
    "it['fails'].each([1])('x', () => {});",
    "it.fails['each']([1])('x', () => {});",
    "it('x', { 'fails': true }, () => {});",
    "it('x', { ['fails']: true }, () => {});",
  ])('detects %j', (source) => {
    expect(declaresExpectedFailure(source)).toBe(true);
  });
  it('ignores other uses of the word', () => {
    for (const source of [
      "if (lock.fails) x({ fails: false }); it('fails', f);",
      "const codes = ['fails']; return ['fails'].includes(x);",
      "counts['fails'] += 1;",
    ])
      expect(declaresExpectedFailure(source)).toBe(false);
  });
  // `it['skip']` / `it["todo"]` need no source check: whatever the spelling, the report names them.
  it.each([
    ["it['skip']", 'skipped'],
    ['it["todo"]', 'todo'],
  ])('%s is caught from the report', (_, status) => {
    const r = judge({ v: vitestReport([vTest('one'), vTest('two', status)]) });
    expect(codes(r)).toContain(`test_${status}`);
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
  const titles = (file) => sourceTitles(read(file), { G2_ENV });
  it('names only tests that exist', () => {
    for (const e of entries)
      expect(
        titles(e.file).filter((t) => t.startsWith(e.test)),
        `${e.file}: ${e.test}`,
      ).not.toEqual([]);
  });
  it('excludes every g2-deployed test as not yet evidenced', () => {
    const g2 = entries.filter((e) => e.file === G2);
    const all = titles(G2);
    expect(all).toHaveLength(2);
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
    TBI_FEEDBACK_RUNTIME_PROXY: 'http://127.0.0.1:7411',
    TBI_S8_INSTANCE: 'tbi-s8',
    TBI_C5_DEPLOYED: 'tbi-s8',
    TBI_C5_FAULTS: '1',
    TBI_ALLOW_SERVICE_MUTATION: 'tbi-s8',
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
    for (const s of ran) expect(s.env.TBI_ALLOW_SERVICE_MUTATION).toBe('tbi-s8');
    const e = evidence(out);
    expect(e).toMatchObject({ sha: SHA, mode: 'run', verdict: 'PASS' });
    expect(Object.keys(e).sort()).toEqual([
      'counts',
      'excluded',
      'failures',
      'finishedAt',
      'mode',
      'notGated',
      'schema',
      'sha',
      'startedAt',
      'verdict',
    ]);
    expect(e.notGated).toEqual([expect.stringMatching(/QEMU-unit crash drill: needs N>=2/)]);
    expect(JSON.stringify(e)).not.toMatch(/tbi-s8|127\.0\.0\.1|gate-test-/);
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
    ['no_real_proxy', { env: { ...ENV, TBI_FEEDBACK_RUNTIME_PROXY: undefined } }],
    ['no_real_proxy', { env: { ...ENV, TBI_FEEDBACK_RUNTIME_PROXY: 'http://127.0.0.1:7497' } }],
    ...[
      'http://127.0.0.1',
      'http://127.0.0.1:80',
      'localhost:7420',
      '127.0.0.1:7420',
      'ws://127.0.0.1:7420',
      'file:///tmp/build',
    ].map((url) => ['no_real_proxy', { env: { ...ENV, TBI_BUILD_PROXY: url } }]),
    ['lease_knob', { env: { ...ENV, TBI_C5_BUILDS: '5' } }],
    ['lease_knob', { env: { ...ENV, TBI_C5_BUILDS: '' } }],
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
  const PICKERS = [
    'TBI_ALLOW_SERVICE_MUTATION',
    'TBI_C5_DEPLOYED',
    'TBI_S8_INSTANCE',
    'TBI_S13_SEC_DEPLOYED',
    'TBI_S18_UNIT',
  ];
  it.each(PICKERS)('refuses %s naming the live instance, before anything runs', (name) => {
    const value = name === 'TBI_ALLOW_SERVICE_MUTATION' ? 'tbi-s8, tbi' : 'tbi';
    const { deps, ran } = fake({ env: { ...ENV, [name]: value } });
    const lines = [];
    deps.log = (line) => lines.push(line);
    const out = tmp();
    expect(runGate(['--out', out], deps)).toBe(1);
    expect(ran).toEqual([]);
    expect(evidence(out).failures).toContainEqual({ code: 'live_instance', test: name });
    expect(lines.join('\n')).toContain(`${name} names the live DEV-Lab instance`);
  });
  const refusal = (env) => {
    const { deps, ran } = fake({ env });
    const lines = [];
    deps.log = (line) => lines.push(line);
    const out = tmp();
    expect(runGate(['--out', out], deps)).toBe(1);
    expect(ran).toEqual([]);
    return { failures: evidence(out).failures, log: lines.join('\n') };
  };
  const NOT_ALLOWED = [
    // other names, other case
    ...['TBI', 'Tbi', 'TBI-S8', 'Tbi-s8', 'tbi-s88', 'tbi-s8x', 'tbi-s9', 'tbi-s9-preview'],
    ...['tbi-lab', 'tbi-prod', 'tbi-staging', 'alpha', 'secret-instance', 'xtbi-s8'],
    // wildcards and pattern characters
    ...['*', 'tbi*', 'tbi-*', 'tbi-s*', 'tbi-s8*', 'tbi-s?', 'tbi-s[8]', 'tbi-s8|tbi', '.*'],
    // paths
    ...['/etc/tbi', 'tbi/', '../tbi', 'tbi-s8/', 'tbi-s8/../tbi', '/etc/tbi-s8', 'tbi\\'],
    // systemd unit forms
    ...['tbi.service', 'tbi-session-host.service', 'tbi-qemu@', 'tbi-qemu@*.service', 'tbi@'],
    ...['tbi-s8.service', 'tbi-s8-session-host.service', 'tbi-s8-qemu', 'tbi-s8@'],
    // whitespace, separators, look-alikes, quoting
    ...[' ', '   ', ' tbi', 'tbi ', ' tbi-s8', 'tbi-s8 ', 'tbi-s8\n', '\ttbi-s8', 'tbi-s8\r'],
    ...['tbi-s8\ntbi', 'tbi-s8 tbi', 'tbi-s8;tbi', 'tbi-s8:tbi', 'tbi-s8\u00a0', 'tbi\u200b'],
    ...['tbi\u2011s8', '"tbi-s8"', "'tbi'", '$TBI', '-', 'tbi-', 'tbi-s8-'],
  ];
  it.each(PICKERS)('refuses %s with any value but the test instance name', (name) => {
    for (const value of NOT_ALLOWED) {
      const { failures, log } = refusal({ ...ENV, [name]: value });
      const mine = failures.filter(
        (f) => f.test === name && ['instance_not_allowed', 'live_instance'].includes(f.code),
      );
      expect(mine, JSON.stringify(value)).toHaveLength(1);
      expect(log).toContain(name);
      expect(log).toContain('tbi-s8');
    }
  });
  it.each(PICKERS.slice(1))('refuses %s holding a list, even of allowed names', (name) => {
    for (const value of ['tbi-s8,tbi-s8', 'tbi-s8,tbi', 'tbi-s8,', ',tbi-s8']) {
      const codes_ = refusal({ ...ENV, [name]: value }).failures.map((f) => `${f.code} ${f.test}`);
      expect(codes_.join(), value).toMatch(
        new RegExp(`(instance_not_allowed|live_instance) ${name}`),
      );
    }
  });
  it('checks every entry of the mutation opt-in list, untrimmed', () => {
    const name = 'TBI_ALLOW_SERVICE_MUTATION';
    for (const value of [
      'tbi-s8,tbi-*',
      'tbi-s8, tbi-s8',
      'tbi-s8 ,tbi-s8',
      'tbi-s8,',
      ',tbi-s8',
      'tbi-s8,,tbi-s8',
      'tbi-s8,TBI',
      'tbi-s8,/etc/tbi',
    ])
      expect(refusal({ ...ENV, [name]: value }).failures, value).toContainEqual({
        code: 'instance_not_allowed',
        test: name,
      });
    for (const value of ['tbi,tbi-s8', 'tbi-s8, tbi', 'tbi-*, tbi '])
      expect(refusal({ ...ENV, [name]: value }).failures, value).toContainEqual({
        code: 'live_instance',
        test: name,
      });
    const { deps } = fake({ env: { ...ENV, [name]: 'tbi-s8,tbi-s8' } });
    expect(runGate(['--out', tmp()], deps)).toBe(0);
  });
  it('the refusal names the variable and the allowed form, never the value', () => {
    const { failures, log } = refusal({ ...ENV, TBI_S8_INSTANCE: 'zz-private-value' });
    expect(failures).toEqual([{ code: 'instance_not_allowed', test: 'TBI_S8_INSTANCE' }]);
    expect(log).toMatch(/TBI_S8_INSTANCE .*exactly "tbi-s8"/);
    expect(log).not.toContain('zz-private-value');
  });
  it('the test instance passes; an unset or empty picker is not refused', () => {
    for (const value of ['tbi-s8', '', undefined]) {
      const env = {
        ...ENV,
        TBI_S8_INSTANCE: value,
        TBI_S13_SEC_DEPLOYED: value,
        TBI_S18_UNIT: value,
      };
      const { deps } = fake({ env });
      expect(runGate(['--out', tmp()], deps), String(value)).toBe(0);
    }
  });
  it('the allowed name is the one install.sh gives the staging target', () => {
    const install = readFileSync(
      new URL('../../deploy/dev-lab/s8/install.sh', import.meta.url),
      'utf8',
    );
    expect(/^ {2}staging\)\n {4}N=(\S+)$/m.exec(install)?.[1]).toBe('tbi-s8');
    expect(G2_STAGING).toBe('tbi-s8');
  });
  it('every instance, unit or deployment variable the suites read is covered', () => {
    const dirs_ = ['runtime/tests', 'app/e2e'];
    const names = new Set(['TBI_ALLOW_SERVICE_MUTATION']);
    for (const dir of dirs_) {
      const base = new URL(`../../${dir}/`, import.meta.url);
      for (const file of readdirSync(base).filter((f) => f.endsWith('.ts')))
        for (const m of readFileSync(new URL(file, base), 'utf8').matchAll(
          /env\.(TBI_\w*(?:INSTANCE|DEPLOYED|UNIT))\b/g,
        ))
          names.add(m[1]);
    }
    // G2_DEPLOYED is read through a constant, and refused whenever set.
    expect([...names].sort()).toEqual([...PICKERS].sort());
  });
  it.each(['TBI_HOST_RUNTIME_UNIT', 'TBI_BUILD_JOB_UNIT'])(
    'refuses the service unit setting %s whenever it has a value',
    (name) => {
      for (const value of ['tbi-qemu', 'tbi-s8-qemu', ' '])
        expect(refusal({ ...ENV, [name]: value }).failures).toEqual([
          { code: 'unit_setting', test: name },
        ]);
      const { deps } = fake({ env: { ...ENV, [name]: '' } });
      expect(runGate(['--out', tmp()], deps)).toBe(0);
    },
  );
  const PROXIES = [
    'TBI_RUNTIME_PROXY',
    'TBI_BUILD_PROXY',
    'TBI_FEEDBACK_RUNTIME_PROXY',
    'TBI_ADMIN_PROXY',
  ];
  it.each(PROXIES)('refuses %s pointing anywhere but this host by loopback', (name) => {
    for (const url of [
      'http://192.0.2.10:7410',
      'https://lab.example.test:7410',
      'http://127.0.0.1.example.test:7410',
      'http://localhost.example.test:7410',
      'http://127.0.0.1:7410@192.0.2.10:7410',
      'http://192.0.2.10:7410/127.0.0.1:7410',
      'http://192.0.2.10:7410#@127.0.0.1:7410',
      'http://127.0.0.1:7410\\@192.0.2.10',
      'http://user@127.0.0.1:7410',
      'http://0.0.0.0:7410',
      'http://2130706433:7410',
      'http://localhost.:7410',
      'http://LOCALHOST:7410',
      ' http://127.0.0.1:7410',
      'http://127.0.0.1:7410\n',
      'http://127.0.0.1:7410/path',
      'http://*:7410',
    ])
      expect(
        refusal({ ...ENV, [name]: url }).failures.map((f) => f.test),
        url,
      ).toContain(name);
  });
  it('accepts the loopback spellings, and an unset or empty admin proxy', () => {
    for (const url of ['http://127.0.0.1:7410', 'http://localhost:7410/', 'https://[::1]:7410']) {
      const { deps } = fake({
        env: { ...ENV, ...Object.fromEntries(PROXIES.map((n) => [n, url])) },
      });
      expect(runGate(['--out', tmp()], deps), url).toBe(0);
    }
    const { deps } = fake({ env: { ...ENV, TBI_ADMIN_PROXY: '' } });
    expect(runGate(['--out', tmp()], deps)).toBe(0);
  });
  it('names the refused knob and says why', () => {
    const { deps } = fake({ env: { ...ENV, TBI_C5_BUILDS: '5' } });
    const lines = [];
    deps.log = (line) => lines.push(line);
    const out = tmp();
    expect(runGate(['--out', out], deps)).toBe(1);
    expect(evidence(out).failures).toEqual([{ code: 'lease_knob', test: 'TBI_C5_BUILDS' }]);
    expect(lines.join('\n')).toMatch(/TBI_C5_BUILDS must be unset: .*session lease/);
  });
  it('the app config has no fake-service default the gate does not refuse', () => {
    const config = readFileSync(new URL('../../playwright.app.config.ts', import.meta.url), 'utf8');
    const names = [...config.matchAll(/process\.env\.(TBI_\w+) \?\? 'http/g)].map((m) => m[1]);
    expect(names).toContain('TBI_FEEDBACK_RUNTIME_PROXY');
    for (const name of new Set(names)) {
      const { deps, ran } = fake({ env: { ...ENV, [name]: undefined } });
      expect(runGate(['--out', tmp()], deps), name).toBe(1);
      expect(ran).toEqual([]);
    }
  });
  it('redacts instance and unit values however short', () => {
    const env = {
      ...ENV,
      TBI_S8_INSTANCE: 'qz',
      TBI_C5_DEPLOYED: 'jx',
      TBI_ALLOW_SERVICE_MUTATION: 'jx, kv',
      TBI_S18_UNIT: 'w',
    };
    // A run refuses these values; --from-reports evaluates without the preconditions.
    const { deps, root } = fake({ env });
    const reports = tmp();
    const v = vitestReport([vTest('one'), vTest('on qz jx kv w end', 'failed')]);
    v.testResults[0].name = join(root, V);
    writeFileSync(join(reports, 'vitest.json'), JSON.stringify(v));
    const out = tmp();
    runGate(['--out', out, '--from-reports', reports], deps);
    const failed = evidence(out, '.evaluation').failures.find((f) => f.code === 'test_failed');
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
