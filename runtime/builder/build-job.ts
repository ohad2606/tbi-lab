/**
 * The driver inside one sandboxed build step (Sprint 8, D-S8-6), started by the fixed template
 * unit `tbi-build-job@<job>.service` (bundled as build-job.mjs). It sees only the read-only
 * toolchains (/opt/tbi-arduino; Sprint 19B /opt/tbi-micropython), its job directory (/job) and
 * system binaries.
 *
 * It runs exactly ONE allow-listed pinned tool with the step's arguments, a fixed set of
 * environment variables and a working directory inside the job, and reports the exit status and
 * bounded output back through files in the job directory. The sandbox is the security boundary;
 * these checks are defence in depth against a confused or compromised service.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, normalize } from 'node:path';
import { runTool } from './run.js';
import {
  STEP_REPORT,
  STEP_SPEC,
  STEP_STDERR,
  STEP_STDOUT,
  type StepReport,
  type StepSpec,
} from './runner.js';

const JOB = '/job';
/**
 * Pinned tools by read-only toolchain home: the Arduino toolchain, and (Sprint 19B) the MicroPython
 * build home with tbi-mklfs (the interpreter's file system image) and (Sprint 24) mpy-cross.
 */
const TOOLCHAINS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['/opt/tbi-arduino/', new Set(['arduino-cli', 'esptool', 'xtensa-esp32-elf-nm'])],
  // Sprint 24: and mpy-cross, the interpreter's own compiler (compile only: the Build syntax check).
  ['/opt/tbi-micropython/', new Set(['tbi-mklfs', 'mpy-cross'])],
]);
const ENV_KEYS = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'SOURCE_DATE_EPOCH']);
const MAX_OUTPUT = 16 * 1024 * 1024;

function refuse(why: string): never {
  writeFileSync(`${JOB}/${STEP_STDERR}`, `build-job: ${why}\n`);
  writeFileSync(
    `${JOB}/${STEP_REPORT}`,
    JSON.stringify({ code: 126, signal: null, truncated: false }),
  );
  process.exit(0);
}

const spec = JSON.parse(readFileSync(`${JOB}/${STEP_SPEC}`, 'utf8')) as StepSpec;
const file = normalize(spec.file);
const allowed = [...TOOLCHAINS].some(
  ([home, tools]) => file.startsWith(home) && tools.has(basename(file)),
);
if (file !== spec.file || !allowed) refuse('not a pinned tool');
const cwd = normalize(spec.cwd);
if (cwd !== JOB && !cwd.startsWith(`${JOB}/`)) refuse('working directory outside the job');
if (!Array.isArray(spec.args) || !spec.args.every((a) => typeof a === 'string'))
  refuse('bad arguments');
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(spec.env ?? {})) {
  if (!ENV_KEYS.has(k) || typeof v !== 'string') refuse(`environment variable ${k}`);
  env[k] = v;
}
const maxOutputBytes = Math.min(Math.max(0, Number(spec.maxOutputBytes) || 0), MAX_OUTPUT);

const r = await runTool(file, spec.args, {
  cwd,
  env,
  signal: new AbortController().signal, // the unit's own limits stop a runaway tool
  maxOutputBytes,
});
writeFileSync(`${JOB}/${STEP_STDOUT}`, r.stdout);
writeFileSync(`${JOB}/${STEP_STDERR}`, r.stderr);
const report: StepReport = { code: r.code, signal: r.signal, truncated: r.truncated };
writeFileSync(`${JOB}/${STEP_REPORT}`, JSON.stringify(report));
