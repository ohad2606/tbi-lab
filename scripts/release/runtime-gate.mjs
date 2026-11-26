#!/usr/bin/env node
/**
 * Release gate of the runtime acceptance suites (docs/ops/TEST-SAFETY.md, "Release gate"): runs the
 * runtime vitest suite and the *-real Playwright specs on a clean tree and fails unless every test
 * of every expected file passed at its first attempt, except the tests listed in
 * runtime-gate.manifest.json. There is no lenient mode.
 *
 *   npm run release:runtime-gate -- --out <dir outside the repository>
 *   ... --from-reports <dir>   evaluates <dir>/vitest.json and playwright.json; never a PASS
 *
 * It sets no mutation opt-in and takes no lock: both are the operator's. Exit: 0 PASS, 1 FAIL,
 * 2 usage, 3 evaluation only.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  evaluate,
  expectedFiles,
  normalizePlaywright,
  normalizeVitest,
  parseManifest,
  RUNNERS,
  sanitize,
} from './runtime-gate-eval.mjs';

/** Variables that make a runtime test check less than it does by default. */
const WEAKENING = [
  'TBI_GATE_RUNS',
  'TBI_GATE_UNPINNED',
  'TBI_R1_DET_RUNS',
  'TBI_S12_DET_RUNS',
  'TBI_S12_DET_UNPINNED',
];
/** Ports of the fake services playwright.app.config.ts falls back to. */
const FAKE_PORTS = ['7496', '7497', '7498', '7499'];
const NORMALIZE = { vitest: normalizeVitest, playwright: normalizePlaywright };

function steps(reports, env) {
  const json = (name) => join(reports, `${name}.json`);
  return [
    // The suite runs the built Session Host: build it from this tree, never use a leftover.
    { name: 'host:build', cmd: 'npm', args: ['run', 'host:build'], env },
    {
      name: 'vitest',
      cmd: 'npx',
      args: [
        '--no-install',
        'vitest',
        'run',
        '--config',
        'vitest.runtime.config.ts',
        '--retry=0',
        '--allowOnly=false',
        '--passWithNoTests=false',
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${json('vitest')}`,
      ],
      env,
      report: json('vitest'),
    },
    {
      name: 'playwright',
      cmd: 'npx',
      args: [
        '--no-install',
        'playwright',
        'test',
        '-c',
        'playwright.app.config.ts',
        'e2e/.*-real\\.spec\\.ts$',
        '--retries=0',
        '--forbid-only',
        '--reporter=list,json',
      ],
      // CI=1: never reuse a server that is already listening (it may serve another build).
      env: { ...env, CI: '1', PLAYWRIGHT_JSON_OUTPUT_FILE: json('playwright') },
      report: json('playwright'),
    },
  ];
}

function realProxy(value) {
  try {
    return !FAKE_PORTS.includes(new URL(value).port);
  } catch {
    return false;
  }
}

/** The path with symlinks resolved, also when its last parts do not exist yet. */
function real(path) {
  return existsSync(path) ? realpathSync(path) : join(real(dirname(path)), basename(path));
}

export function runGate(argv, deps) {
  const { root, env, git, log } = deps;
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = { '--out': 'out', '--from-reports': 'from' }[argv[i]];
    if (!name || !argv[i + 1] || opts[name]) {
      log(`usage: runtime-gate.mjs --out <dir> [--from-reports <dir>] (got "${argv[i]}")`);
      return 2;
    }
    opts[name] = argv[i + 1];
  }
  const out = opts.out && real(resolve(opts.out));
  const rel = out && relative(real(root), out);
  if (!out || !(rel === '..' || rel.startsWith(`..${sep}`))) {
    log('--out is required and must be outside the repository');
    return 2;
  }

  const startedAt = new Date().toISOString();
  const head = () => git(['rev-parse', 'HEAD']).trim();
  const dirty = () => git(['status', '--porcelain', '--untracked-files=all']).trim() !== '';
  const sha = head();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error('cannot read the commit of HEAD');
  const mode = opts.from ? 'from-reports' : 'run';
  mkdirSync(out, { recursive: true });
  const target = join(out, `runtime-gate-${sha}${opts.from ? '.evaluation' : ''}.json`);
  rmSync(target, { force: true }); // an interrupted run leaves no earlier verdict behind

  const pre = [];
  if (!opts.from) {
    if (dirty()) pre.push({ code: 'dirty_tree' });
    for (const name of ['TBI_RUNTIME_PROXY', 'TBI_BUILD_PROXY'])
      if (!realProxy(env[name])) pre.push({ code: 'no_real_proxy', test: name });
    for (const name of WEAKENING) if (env[name]) pre.push({ code: 'weakening_env', test: name });
  }

  let result = { failures: [], excluded: [], counts: {} };
  if (pre.length === 0) {
    const manifest = parseManifest(deps.manifest());
    const expected = expectedFiles(git(['ls-files', '-z']).split('\0').filter(Boolean));
    const reports = opts.from ? resolve(opts.from) : mkdtempSync(join(tmpdir(), 'tbi-gate-'));
    const exits = { vitest: 0, playwright: 0 };
    if (!opts.from) {
      log(`raw reports (private, not evidence): ${reports}`);
      for (const step of steps(reports, env)) {
        const code = deps.run(step);
        if (step.report) exits[step.name] = code;
        else if (code !== 0) pre.push({ code: 'build_failed' });
      }
    }
    const runs = {};
    for (const runner of RUNNERS) {
      let report = null;
      try {
        const raw = readFileSync(join(reports, `${runner}.json`), 'utf8');
        report = NORMALIZE[runner](JSON.parse(raw), root);
      } catch (e) {
        log(`${runner}: no usable report (${e.message})`);
      }
      runs[runner] = { exitCode: exits[runner], report };
    }
    result = evaluate({ expected, manifest, runs });
    if (!opts.from && (head() !== sha || dirty())) pre.push({ code: 'tree_changed' });
  }

  const secrets = [
    ...Object.entries(env)
      .filter(([k]) => k.startsWith('TBI_') || ['HOME', 'USER', 'LOGNAME'].includes(k))
      .map(([, v]) => v)
      // Switch values such as "1" or "r1" identify nothing and occur in ordinary titles.
      .filter((v) => v && v.length >= 4),
    homedir(),
    hostname(),
  ];
  const clean = (item) =>
    item.test === undefined || item.code === 'no_real_proxy' || item.code === 'weakening_env'
      ? item
      : { ...item, test: sanitize(item.test, secrets) };
  const failures = [...pre, ...result.failures].map(clean);
  const verdict = failures.length ? 'FAIL' : opts.from ? 'EVALUATION_ONLY' : 'PASS';
  const evidence = {
    schema: 'tbi-runtime-gate/1',
    sha,
    mode,
    verdict,
    startedAt,
    finishedAt: new Date().toISOString(),
    counts: result.counts,
    excluded: result.excluded.map(clean),
    failures,
  };
  writeFileSync(`${target}.tmp`, `${JSON.stringify(evidence, null, 2)}\n`);
  renameSync(`${target}.tmp`, target);
  for (const f of failures)
    log(`FAIL ${[f.code, f.runner, f.file, f.test].filter(Boolean).join(' | ')}`);
  log(
    `runtime gate ${verdict} for ${sha}: ${failures.length} failure(s), ` +
      `${result.excluded.length} excluded. Evidence: ${target}`,
  );
  return { PASS: 0, FAIL: 1, EVALUATION_ONLY: 3 }[verdict];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const capture = (args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
    return r.stdout;
  };
  process.exitCode = runGate(process.argv.slice(2), {
    root,
    env: process.env,
    git: capture,
    log: (line) => console.log(line),
    manifest: () =>
      JSON.parse(readFileSync(new URL('runtime-gate.manifest.json', import.meta.url), 'utf8')),
    run: ({ cmd, args, env }) => spawnSync(cmd, args, { cwd: root, env, stdio: 'inherit' }).status,
  });
}
