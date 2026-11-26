/**
 * The deployed tests' policy helper (runtime/tests/s8-installed-policy.ts), against an in-memory
 * instance: the deployed tests themselves are skipped without an installed instance.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  InstalledPolicy,
  notTested,
  prebuiltMode,
  previewDefaultPolicy,
  repoPolicyFile,
  skipNote,
  strictAcceptance,
  withInstalledPlanNames,
  type Deps,
} from '../../tests/s8-installed-policy.js';
import { DEFAULT_POLICY, Policy, validatePolicy } from '../policy.js';
import type { Principal } from '../../identity/principal.js';

const path = (name: string) =>
  fileURLToPath(new URL(`../../../deploy/dev-lab/s8/${name}`, import.meta.url));
const file = (name: string) => readFileSync(path(name));
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

function errorOf(run: () => unknown): string {
  try {
    run();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected an error');
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
    const expected = join(mkdtempSync(join(tmpdir(), 'tbi-policy-test-')), 'policy.json');
    writeFileSync(expected, before);
    const p = InstalledPolicy.capture('tbi-s8', deps, expected);
    p.install(previewDefaultPolicy(p.bytes), UNITS);
    p.install(file('policy.alpha.json'), UNITS);
    expect(state.installed).toEqual(file('policy.alpha.json'));
    expect(p.restore(UNITS)).toBe(true);
    expect(state.installed).toEqual(before);
    expect(p.restore(UNITS)).toBe(false);
  });
  it('nothing changed: restore runs no command', () => {
    const { state, deps } = instance(file('policy.beta.json'));
    expect(InstalledPolicy.capture('tbi-s8', deps, path('policy.beta.json')).restore(UNITS)).toBe(
      false,
    );
    expect(state.calls).toEqual(['cat']);
  });
  it('unreadable, empty or invalid installed policy: capture throws, nothing is changed', () => {
    for (const [bytes, fail] of [
      [file('policy.json'), ['cat']],
      [Buffer.alloc(0), []],
      [Buffer.from('{}'), []],
    ] as const) {
      const { state, deps } = instance(bytes, true, [...fail]);
      expect(() => InstalledPolicy.capture('tbi-s8', deps, path('policy.json'))).toThrow(/policy/);
      expect(state.calls).toEqual(['cat']);
    }
  });
  it('without the mutation gate: install is refused and restore does nothing', () => {
    const { state, deps } = instance(file('policy.beta.json'), false);
    const p = InstalledPolicy.capture('tbi-s8', deps, path('policy.beta.json'));
    expect(() => p.install(file('policy.json'), UNITS)).toThrow(/mutation gate/);
    expect(p.restore(UNITS)).toBe(false);
    expect(state.calls).toEqual(['cat']);
  });
  it('a failed restart after the install is still restored; the failure is reported', () => {
    const fail: string[] = ['systemctl'];
    const { state, deps } = instance(file('policy.beta.json'), true, fail);
    const p = InstalledPolicy.capture('tbi-s8', deps, path('policy.beta.json'));
    expect(() => p.install(file('policy.json'), UNITS)).toThrow(/systemctl/);
    expect(() => p.restore(UNITS)).toThrow(/systemctl/);
    expect(state.installed).toEqual(file('policy.beta.json'));
  });
  it('a restore that cannot install throws and can be retried', () => {
    const fail: string[] = [];
    const { state, deps } = instance(file('policy.beta.json'), true, fail);
    const p = InstalledPolicy.capture('tbi-s8', deps, path('policy.beta.json'));
    p.install(file('policy.json'), UNITS);
    fail.push('install');
    const message = errorOf(() => p.restore(UNITS));
    expect(message).toMatch(/NOT restored: restore it from \S+policy\.before\.json .*install/);
    const backup = /from (\S+policy\.before\.json)/.exec(message)![1]!;
    expect(readFileSync(backup)).toEqual(file('policy.beta.json'));
    fail.length = 0;
    expect(p.restore(UNITS)).toBe(true);
    expect(state.installed).toEqual(file('policy.beta.json'));
    expect(existsSync(backup)).toBe(false);
  });
  it('a restart failure inside restore names the backup file; the restore can be retried', () => {
    const fail: string[] = [];
    const { state, deps } = instance(file('policy.beta.json'), true, fail);
    const p = InstalledPolicy.capture('tbi-s8', deps, path('policy.beta.json'));
    p.install(file('policy.json'), UNITS);
    fail.push('systemctl');
    const message = errorOf(() => p.restore(UNITS));
    expect(message).toMatch(/NOT restarted.*\S+policy\.before\.json.*systemctl/);
    expect(state.installed).toEqual(file('policy.beta.json'));
    const backup = /(\/\S+policy\.before\.json)/.exec(message)![1]!;
    expect(readFileSync(backup)).toEqual(file('policy.beta.json'));
    fail.length = 0;
    expect(p.restore(UNITS)).toBe(true);
    expect(existsSync(backup)).toBe(false);
  });
  it('restore does not rewrite the backup: it is the file saved before the first change', () => {
    const fail: string[] = [];
    const { deps } = instance(file('policy.beta.json'), true, fail);
    const log = vi.spyOn(console, 'log');
    const p = InstalledPolicy.capture('tbi-s8', deps, path('policy.beta.json'));
    p.install(file('policy.json'), UNITS);
    const backup = /saved to (\S+)/.exec(String(log.mock.lastCall![0]))![1]!;
    writeFileSync(backup, 'marker: must stay as it is');
    fail.push('install');
    expect(() => p.restore(UNITS)).toThrow(/NOT restored/);
    expect(readFileSync(backup, 'utf8')).toBe('marker: must stay as it is');
  });
  it('a restore that cannot verify the installed bytes names the backup', () => {
    const fail: string[] = [];
    const { deps } = instance(file('policy.beta.json'), true, fail);
    const p = InstalledPolicy.capture('tbi-s8', deps, path('policy.beta.json'));
    p.install(file('policy.json'), UNITS);
    fail.push('cat');
    expect(() => p.restore(UNITS)).toThrow(/NOT restored: restore it from \S+policy\.before\.json/);
  });
});

describe('the installed policy must be the repository file', () => {
  it('a leftover temporary policy is refused before any change, with the recovery command', () => {
    const left = previewDefaultPolicy(file('policy.beta.json'));
    const { state, deps } = instance(left);
    const message = errorOf(() =>
      InstalledPolicy.capture('tbi-s8', deps, path('policy.beta.json')),
    );
    expect(message).toContain('differs from');
    expect(message).toContain('nothing was changed');
    expect(message).toContain(
      `sudo install -m 0400 ${path('policy.beta.json')} /etc/tbi-s8/policy.json && ` +
        'sudo systemctl restart tbi-s8-build.service tbi-s8-session-host.service',
    );
    // The printed command can be pasted as it is: no punctuation after it.
    expect(message).toMatch(/tbi-s8-session-host\.service(\n|$)/);
    expect(state.calls).toEqual(['cat']);
    expect(state.installed).toEqual(left);
  });
  it('bytes, not parsed content: one extra newline is drift', () => {
    const { deps } = instance(Buffer.concat([file('policy.json'), Buffer.from('\n')]));
    expect(() => InstalledPolicy.capture('tbi-s8', deps, path('policy.json'))).toThrow(/differs/);
  });
  it('recovery: drift fails when assertions would run, including an unexpected refusal', () => {
    for (const [installed, expected, enough] of [
      ['policy.beta.json', 'policy.alpha.json', true],
      ['policy.beta.json', 'policy.alpha.json', false],
      ['policy.alpha.json', 'policy.beta.json', true],
      ['policy.alpha.json', 'policy.beta.json', false],
      ['policy.json', 'policy.alpha.json', true],
    ] as const) {
      const { deps } = instance(file(installed));
      expect(
        () => InstalledPolicy.captureForRecovery('tbi', enough, deps, path(expected)),
        `${installed} ${expected} ${enough}`,
      ).toThrow(/differs/);
    }
    const unreadable = instance(file('policy.alpha.json'), true, ['cat']).deps;
    for (const [expected, enough] of [
      ['policy.alpha.json', true],
      ['policy.beta.json', false],
    ] as const)
      expect(() =>
        InstalledPolicy.captureForRecovery('tbi', enough, unreadable, path(expected)),
      ).toThrow(/cannot read/);
  });
  it('recovery: nothing would run (too few sessions, no refusal): no capture, no error', () => {
    for (const { deps } of [
      instance(file('policy.json')), // drift that refuses nothing
      instance(file('policy.alpha.json'), true, ['cat']),
      instance(Buffer.from('{}')),
    ])
      expect(
        InstalledPolicy.captureForRecovery('tbi', false, deps, path('policy.alpha.json')),
      ).toBeUndefined();
  });
  it('recovery: matching policy is captured when assertions run', () => {
    for (const [name, enough] of [
      ['policy.alpha.json', true],
      ['policy.beta.json', false],
    ] as const) {
      const { deps } = instance(file(name));
      expect(InstalledPolicy.captureForRecovery('tbi', enough, deps, path(name))?.bytes).toEqual(
        file(name),
      );
    }
  });
});

describe('strict acceptance (TBI_ACCEPTANCE_STRICT)', () => {
  const strict = { TBI_ACCEPTANCE_STRICT: '1' };
  it('off by default: a skip stays a skip', () => {
    for (const env of [{}, { TBI_ACCEPTANCE_STRICT: '' }, { TBI_ACCEPTANCE_STRICT: '0' }]) {
      expect(strictAcceptance(env)).toBe(false);
      expect(notTested(true, skipNote('refused'), env)).toBe(true);
    }
  });
  it('on: a skip throws with its reason; a case that runs is unaffected', () => {
    expect(strictAcceptance(strict)).toBe(true);
    expect(() => notTested(true, skipNote('refused'), strict)).toThrow(
      /TBI_ACCEPTANCE_STRICT=1: NOT TESTED/,
    );
    expect(notTested(false, '', strict)).toBe(false);
  });
  it('an unrecognised value is an error, not silently lenient', () => {
    expect(() => strictAcceptance({ TBI_ACCEPTANCE_STRICT: 'true' })).toThrow(/1 or 0/);
  });
});
