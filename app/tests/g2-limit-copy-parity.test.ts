/** The app's sim limit sentences that carry no offer are exact copies of the server's limit.sim.* texts. */
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../../runtime/plans/messages.js';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';

const COPIES = [
  'queue',
  'queue_timeout',
  'queue_full',
  'queue_replaced',
  'cooldown',
  'concurrent',
  'daily',
  'free_paused',
] as const;

describe('sim limit copies: server and app', () => {
  it('are identical in EN and HE', () => {
    for (const code of COPIES) {
      expect(en[`sim.limit.${code}`], code).toBe(MESSAGES.en[`limit.sim.${code}`]);
      expect(he[`sim.limit.${code}`], code).toBe(MESSAGES.he[`limit.sim.${code}`]);
    }
  });
});
