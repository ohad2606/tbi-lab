/**
 * Pure evaluation of the runtime release gate (runtime-gate.mjs): what the runtime vitest suite and
 * the *-real Playwright specs reported, against the files in the committed tree and the exclusion
 * manifest. Strict: only a test that passed at its first attempt counts. Unit-tested in
 * scripts/tests/runtime-gate.test.mjs.
 */
import { relative, resolve } from 'node:path';

export const RUNNERS = ['vitest', 'playwright'];

/** The test files a release run must report, from the tracked files of the tree. */
export const expectedFiles = (tracked) => ({
  vitest: tracked.filter((f) => /^runtime\/.*\.runtime\.test\.ts$/.test(f)).sort(),
  playwright: tracked.filter((f) => /^(?!experiments\/).*-real\.spec\.ts$/.test(f)).sort(),
});

/** Exclusions: one exact file, a prefix of the full test title, and the reason. Nothing else. */
export function parseManifest(raw) {
  const bad = (why) => new Error(`invalid exclusion manifest: ${why}`);
  if (!Array.isArray(raw?.exclusions)) throw bad('"exclusions" must be a list');
  const keys = ['file', 'reason', 'runner', 'test'];
  return raw.exclusions.map((e, i) => {
    if (Object.keys(e).sort().join() !== keys.join())
      throw bad(`entry ${i} needs exactly ${keys.join(', ')}`);
    if (!keys.every((k) => typeof e[k] === 'string' && e[k].trim() !== ''))
      throw bad(`entry ${i} has an empty value`);
    if (!RUNNERS.includes(e.runner)) throw bad(`entry ${i}: unknown runner`);
    if (e.file.includes('*')) throw bad(`entry ${i}: no wildcards in "file"`);
    return e;
  });
}

function vitestStatus(t) {
  // A pass that kept an error passed on a retry (a per-test `retry` option beats the CLI).
  if (t.status === 'passed') return t.failureMessages?.length ? 'flaky' : 'passed';
  return ['failed', 'skipped', 'todo'].includes(t.status) ? t.status : 'incomplete';
}

/** vitest `--reporter=json` → { files: [{file, failed, tests}], problems }. Throws if not one. */
export function normalizeVitest(raw, root) {
  if (!Array.isArray(raw?.testResults)) throw new Error('not a vitest JSON report');
  const files = raw.testResults.map((r) => ({
    file: relative(root, r.name),
    failed: r.status !== 'passed',
    tests: r.assertionResults.map((t) => ({
      title: [...t.ancestorTitles.filter(Boolean), t.title].join(' '),
      status: vitestStatus(t),
    })),
  }));
  const problems = [];
  if (raw.success !== true) problems.push('report_unsuccessful');
  if (raw.numTotalTests !== files.reduce((n, f) => n + f.tests.length, 0))
    problems.push('report_inconsistent');
  return { files, problems };
}

function playwrightStatus(t) {
  if (t.status === 'skipped') return 'skipped';
  if (t.status === 'flaky' || t.results.length > 1 || t.results.some((r) => r.retry > 0))
    return 'flaky';
  if (t.status !== 'expected') return 'failed';
  if (t.expectedStatus !== 'passed') return 'expected_failure';
  return t.results[0]?.status === 'passed' ? 'passed' : 'incomplete';
}

/** Playwright `json` reporter → the same shape. */
export function normalizePlaywright(raw, root) {
  if (!Array.isArray(raw?.suites) || !raw.config?.rootDir || !raw.stats)
    throw new Error('not a playwright JSON report');
  const byFile = new Map();
  let count = 0;
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      const file = relative(root, resolve(raw.config.rootDir, spec.file));
      if (!byFile.has(file)) byFile.set(file, { file, failed: false, tests: [] });
      for (const t of spec.tests) {
        count++;
        byFile
          .get(file)
          .tests.push({ title: [...titles, spec.title].join(' '), status: playwrightStatus(t) });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  // The top suites are the files themselves: their titles are not part of a test title.
  for (const suite of raw.suites) walk(suite, []);
  const problems = [];
  if (raw.errors?.length) problems.push('report_errors');
  const { expected = 0, unexpected = 0, flaky = 0, skipped = 0 } = raw.stats;
  if (expected + unexpected + flaky + skipped !== count) problems.push('report_inconsistent');
  return { files: [...byFile.values()], problems };
}

/**
 * `runs[runner]` = { exitCode (null: killed or not started), report (normalized, or null) }.
 * Returns { failures, excluded, counts }; the gate passes only with no failures.
 */
export function evaluate({ expected, manifest, runs }) {
  const failures = [];
  const excluded = [];
  const counts = {};
  const matched = manifest.map(() => ({ excused: 0, other: 0 }));
  for (const runner of RUNNERS) {
    const { exitCode, report } = runs[runner];
    const fail = (code, file, test) => failures.push({ code, runner, file, test });
    const c = (counts[runner] = {
      exitCode,
      expectedFiles: expected[runner].length,
      reportedFiles: report?.files.length ?? 0,
      tests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      todo: 0,
      flaky: 0,
      expected_failure: 0,
      incomplete: 0,
      excluded: 0,
    });
    if (expected[runner].length === 0) fail('no_expected_files');
    if (!report) {
      fail('no_report');
      continue;
    }
    if (exitCode !== 0) fail('runner_exit');
    for (const code of report.problems) fail(code);
    const reported = new Set(report.files.map((f) => f.file));
    for (const file of expected[runner]) if (!reported.has(file)) fail('missing_file', file);
    for (const { file, failed, tests } of report.files) {
      // A path outside the tree is not echoed.
      const known = expected[runner].includes(file);
      const shown = file.startsWith('..') ? undefined : file;
      if (!known) fail('unexpected_file', shown);
      if (failed) fail('file_failed', shown);
      if (tests.length === 0) fail('zero_tests', shown);
      for (const { title, status } of tests) {
        c.tests++;
        c[status]++;
        // Only a skip or a todo can be excluded: never a failure, a retry or an unfinished test.
        const excusable = status === 'skipped' || status === 'todo';
        let reason;
        manifest.forEach((e, i) => {
          if (e.runner !== runner || e.file !== file || !title.startsWith(e.test)) return;
          matched[i][excusable ? 'excused' : 'other']++;
          if (excusable) reason ??= e.reason;
        });
        if (reason !== undefined && known) {
          c.excluded++;
          excluded.push({ runner, file, test: title, status, reason });
        } else if (status !== 'passed') fail(`test_${status}`, shown, title);
      }
    }
    if (c.passed === 0) fail('nothing_passed');
  }
  manifest.forEach((e, i) => {
    // Stale: excludes nothing, or its pattern also covers a test that ran.
    if (matched[i].excused === 0 || matched[i].other > 0)
      failures.push({ code: 'stale_exclusion', runner: e.runner, file: e.file, test: e.test });
  });
  return { failures, excluded, counts };
}

/** Removes the given values, URLs, absolute paths and IPv4 addresses from a test title. */
export function sanitize(text, values = []) {
  let out = text;
  for (const v of [...values].sort((a, b) => b.length - a.length))
    if (v.length >= 3) out = out.replaceAll(v, '<redacted>');
  return out
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<redacted>')
    .replace(
      /(?<![\w.<>])\/(home|root|var|tmp|srv|etc|run|opt|usr|Users)\/[^\s'")]*/g,
      '<redacted>',
    )
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '<redacted>');
}
