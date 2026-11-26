/**
 * The deployed tests' policy helper (runtime/tests/s8-installed-policy.ts), against an in-memory
 * instance: the deployed tests themselves are skipped without an installed instance.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  InstalledPolicy,
  prebuiltMode,
  previewDefaultPolicy,
  repoPolicyFile,
  skipNote,
  withInstalledPlanNames,
  type Deps,
} from '../../tests/s8-installed-policy.js';
import { DEFAULT_POLICY, Policy, validatePolicy } from '../policy.js';
import type { Principal } from '../../identity/principal.js';

const file = (name: string) =>
  readFileSync(new URL(`../../../deploy/dev-lab/s8/${name}`, import.meta.url));
const parsed = (b: Buffer) => validatePolicy(JSON.parse(b.toString('utf8')) as unknown);
const UNITS = ['tbi-s8-build', 'tbi-s8-session-host'];

/** One installed policy file behind a fake sudo; every command is recorded. */
function instance(initial: Buffer, mayMutate = true, fail: string[] = []) {
  const state = { installed: initial, calls: [] as string[] };
  const deps: Deps = {
    mayMutate: () => mayMutate,
    sudo: ([cmd, ...args]) => {
      state.calls.push(cmd!);
      if (fail.includes(cmd!))
        return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('denied') };
      if (cmd === 'install') state.installed = readFileSync(args[2]!);
      return {
        status: 0,
        stdout: cmd === 'cat' ? state.installed : Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      };
    },
  };
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return { state, deps };
}

describe('repository policy resolution', () => {
  it('defaults to policy.json (also when empty), else TBI_S8_POLICY as an absolute path', () => {
    for (const env of [{}, { TBI_S8_POLICY: '' }])
      expect(readFileSync(repoPolicyFile(env))).toEqual(file('policy.json'));
    expect(repoPolicyFile({ TBI_S8_POLICY: 'deploy/dev-lab/s8/policy.beta.json' })).toBe(
      resolve('deploy/dev-lab/s8/policy.beta.json'),
    );
  });
});

describe('prebuilt uploads under the installed default plan', () => {
  it('policy.json and policy.alpha.json: as installed, whether or not mutation is allowed', () => {
    for (const name of ['policy.json', 'policy.alpha.json'])
      for (const may of [true, false])
        expect(prebuiltMode(file(name), may), name).toBe('installed');
    expect(skipNote('installed')).toBe('');
    expect(skipNote('temporary')).toBe('');
  });
  it('policy.beta.json: temporary only with the mutation gate, else refused with a reason', () => {
    expect(prebuiltMode(file('policy.beta.json'), true)).toBe('temporary');
    expect(prebuiltMode(file('policy.beta.json'), false)).toBe('refused');
    expect(skipNote('refused')).toContain('NOT TESTED');
  });
  it('the temporary policy changes only the default plan; fresh users get preview', () => {
    const principal = `p_${'a'.repeat(26)}` as Principal;
    const installed = parsed(file('policy.beta.json'));
    installed.assignments = { [principal]: 'free' };
    const t = parsed(previewDefaultPolicy(Buffer.from(JSON.stringify(installed))));
    expect(t).toEqual({ ...installed, defaultPlan: 'preview' });
    expect(new Policy(t).plan(`p_${'b'.repeat(26)}` as Principal)).toEqual(t.plans.preview);
    expect(new Policy(t).planName(principal)).toBe('free');
  });
  it('no preview plan that allows prebuilt: throws', () => {
    const p = parsed(file('policy.beta.json'));
    p.plans.preview!.capabilities.allowPrebuiltBinary = false;
    expect(() => previewDefaultPolicy(Buffer.from(JSON.stringify(p)))).toThrow(/preview/);
  });
  it('a validation policy keeps the installed plan names; unchanged under policy.json', () => {
    const beta = withInstalledPlanNames(DEFAULT_POLICY, file('policy.beta.json'));
    expect(Object.keys(beta.plans).sort()).toEqual(['free', 'preview', 'system']);
    expect(beta.plans.free).toEqual(DEFAULT_POLICY.plans.preview);
    expect(beta.defaultPlan).toBe('preview');
    expect(withInstalledPlanNames(DEFAULT_POLICY, file('policy.json'))).toEqual(DEFAULT_POLICY);
  });
});

describe('save and restore of the installed policy', () => {
  it('restores exactly the saved bytes after one or more temporary policies', () => {
    // Bytes that match no repository file (e.g. a server copy with assignments or other spacing).
    const before = Buffer.from(`${file('policy.beta.json').toString('utf8')}\n\n`);
    const { state, deps } = instance(before);
    const p = InstalledPolicy.capture('tbi-s8', deps);
    p.install(previewDefaultPolicy(p.bytes), UNITS);
    p.install(file('policy.alpha.json'), UNITS);
    expect(state.installed).toEqual(file('policy.alpha.json'));
    expect(p.restore(UNITS)).toBe(true);
    expect(state.installed).toEqual(before);
    expect(p.restore(UNITS)).toBe(false);
  });
  it('nothing changed: restore runs no command', () => {
    const { state, deps } = instance(file('policy.beta.json'));
    expect(InstalledPolicy.capture('tbi-s8', deps).restore(UNITS)).toBe(false);
    expect(state.calls).toEqual(['cat']);
  });
  it('unreadable, empty or invalid installed policy: capture throws, nothing is changed', () => {
    for (const [bytes, fail] of [
      [file('policy.json'), ['cat']],
      [Buffer.alloc(0), []],
      [Buffer.from('{}'), []],
    ] as const) {
      const { state, deps } = instance(bytes, true, [...fail]);
      expect(() => InstalledPolicy.capture('tbi-s8', deps)).toThrow(/policy/);
      expect(state.calls).toEqual(['cat']);
    }
  });
  it('without the mutation gate: install is refused and restore does nothing', () => {
    const { state, deps } = instance(file('policy.beta.json'), false);
    const p = InstalledPolicy.capture('tbi-s8', deps);
    expect(() => p.install(file('policy.json'), UNITS)).toThrow(/mutation gate/);
    expect(p.restore(UNITS)).toBe(false);
    expect(state.calls).toEqual(['cat']);
  });
  it('a failed restart after the install is still restored; the failure is reported', () => {
    const fail: string[] = ['systemctl'];
    const { state, deps } = instance(file('policy.beta.json'), true, fail);
    const p = InstalledPolicy.capture('tbi-s8', deps);
    expect(() => p.install(file('policy.json'), UNITS)).toThrow(/systemctl/);
    expect(() => p.restore(UNITS)).toThrow(/systemctl/);
    expect(state.installed).toEqual(file('policy.beta.json'));
  });
  it('a restore that cannot install throws and can be retried', () => {
    const fail: string[] = [];
    const { state, deps } = instance(file('policy.beta.json'), true, fail);
    const p = InstalledPolicy.capture('tbi-s8', deps);
    p.install(file('policy.json'), UNITS);
    fail.push('install');
    expect(() => p.restore(UNITS)).toThrow(/install/);
    fail.length = 0;
    expect(p.restore(UNITS)).toBe(true);
    expect(state.installed).toEqual(file('policy.beta.json'));
  });
});
