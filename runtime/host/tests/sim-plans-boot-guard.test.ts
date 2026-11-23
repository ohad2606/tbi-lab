/**
 * TBI-018 s3d-1: `runtime/host/main.ts` refuses to start while any TBI_HOST_SIM_* flag is set (sim
 * metering is not wired yet) and is unchanged without them. The process is spawned with a minimal
 * environment: no identity key, so a host that passes the guard stops at today's first required
 * setting (TBI_IDENTITY_KEY_FILE) before it listens or stops any unit.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOST_SIM_FLAGS, HOST_SIM_REFUSED_EXIT } from '../../plans/hostflags.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const MAIN = join(ROOT, 'runtime', 'host', 'main.ts');
const VITE_NODE = join(ROOT, 'node_modules', '.bin', 'vite-node');

const runMain = (extra: Record<string, string>) =>
  spawnSync(VITE_NODE, [MAIN], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...extra },
  });

describe('Session Host main: sim-plans flags', () => {
  it("no flag: today's path (first required setting refuses, exit 1, not the sim code)", () => {
    const r = runMain({});
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TBI_IDENTITY_KEY_FILE is required');
    expect(r.stderr).not.toMatch(/sim metering/);
    expect(r.stdout).not.toMatch(/listening/);
  }, 70_000);

  it(`any flag set: refuses before anything else, exit ${HOST_SIM_REFUSED_EXIT}, flag named, value not`, () => {
    for (const f of [HOST_SIM_FLAGS[0], HOST_SIM_FLAGS[5]]) {
      const r = runMain({ [f]: '/private/secret-value' });
      expect(r.status).toBe(HOST_SIM_REFUSED_EXIT);
      expect(r.stderr).toMatch(/sim metering is not wired in this build; refusing to start/);
      expect(r.stderr).toContain(f);
      expect(r.stderr).not.toContain('secret-value');
      expect(r.stderr).not.toContain('TBI_IDENTITY_KEY_FILE');
      expect(r.stdout).not.toMatch(/listening/);
    }
  }, 140_000);

  it("the refusal exit code is distinct from the host's other exits (0, 1)", () => {
    expect([0, 1]).not.toContain(HOST_SIM_REFUSED_EXIT);
  });
});
