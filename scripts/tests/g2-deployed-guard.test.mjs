/**
 * Offline unit test of the BETA-G2 queue load harness's run guard: it refuses every instance that is
 * not staging, and refuses (does not skip) a half-configured opt-in. No service, no lock, no network.
 */
import { describe, expect, it } from 'vitest';
import { g2Decision } from '../../runtime/tests/g2-guard.ts';

const locked = () => true;
const unlocked = () => false;
const ok = {
  TBI_G2_DEPLOYED: 'tbi-s8',
  TBI_ALLOW_SERVICE_MUTATION: 'tbi-s8',
  TBI_G2_PREVIEW_USERS: 'p1,p2',
};

describe('g2-deployed guard', () => {
  it('is off (file excluded) without the opt-in', () => {
    expect(g2Decision({}, locked)).toEqual({ kind: 'off' });
    expect(g2Decision({ TBI_ALLOW_SERVICE_MUTATION: 'tbi-s8' }, locked)).toEqual({ kind: 'off' });
  });

  it.each(['tbi', 'tbi-prod', 'alpha', 'tbi-s8x', 'tbi-s88', 'TBI-S8'])(
    'refuses instance %s even with every other condition met',
    (instance) => {
      const d = g2Decision(
        { ...ok, TBI_G2_DEPLOYED: instance, TBI_ALLOW_SERVICE_MUTATION: `${instance},tbi-s8` },
        locked,
      );
      expect(d.kind).toBe('refused');
    },
  );

  it('refuses when the mutation opt-in does not name staging', () => {
    for (const m of [undefined, '', 'tbi', 'tbi-s88'])
      expect(g2Decision({ ...ok, TBI_ALLOW_SERVICE_MUTATION: m }, locked).kind).toBe('refused');
  });

  it('refuses without the pipeline lock', () => {
    expect(g2Decision(ok, unlocked).kind).toBe('refused');
  });

  it('refuses (fails, not skips) a missing or wrong preview identity list', () => {
    for (const p of [undefined, '', 'p1', 'p1,p2,p3'])
      expect(g2Decision({ ...ok, TBI_G2_PREVIEW_USERS: p }, locked).kind).toBe('refused');
  });

  it('refuses a heavy workload', () => {
    expect(g2Decision({ ...ok, TBI_C5_WORKLOAD: 'sonar' }, locked).kind).toBe('refused');
  });

  it('runs only on staging with gate, lock and two preview identities', () => {
    expect(g2Decision({ ...ok, TBI_C5_WORKLOAD: 'gpio' }, locked)).toEqual({
      kind: 'run',
      instance: 'tbi-s8',
      previewUsers: ['p1', 'p2'],
    });
  });
});
