/**
 * The runtime identity the version details show (Sprint 10): only a version token and a full
 * commit from the Session Host's /health; anything else is "not reported".
 */
import { describe, expect, it } from 'vitest';
import { parseRuntimeIdentity } from '../src/runtimeInfo.js';

describe('runtime identity', () => {
  it('takes the version and commit the runtime reports', () => {
    const commit = '0123456789abcdef0123456789abcdef01234567';
    expect(
      parseRuntimeIdentity({
        protocol: 'tbi-lab.session/2',
        sessions: {},
        runtime: { version: '0.10-dev', commit },
      }),
    ).toEqual({ version: '0.10-dev', commit });
  });
  it('an older runtime (no identity) or anything malformed is not reported', () => {
    expect(parseRuntimeIdentity({ protocol: 'tbi-lab.session/2', sessions: {} })).toBeNull();
    expect(parseRuntimeIdentity(null)).toBeNull();
    for (const runtime of [
      { version: '0.10-dev', commit: 'abc' },
      { version: '/etc/passwd', commit: '0'.repeat(40) },
      { version: 1, commit: '0'.repeat(40) },
      { version: '0.10-dev', commit: '0'.repeat(40) + ' host-1' },
    ])
      expect(parseRuntimeIdentity({ runtime })).toBeNull();
  });
});
