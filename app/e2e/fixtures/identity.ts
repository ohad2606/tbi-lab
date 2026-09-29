/**
 * TEST ONLY: the identity configuration shared by the e2e fake services. The Vite preview proxy
 * plays the gate in tests (TBI_TEST_GATE=1, app/vite.config.ts): it strips client identity
 * headers and asserts the subject from the `tbi_test_user` cookie (default `e2e-user`).
 */
import { identityConfig } from '../../../runtime/identity/principal.js';

export const E2E_IDENTITY = identityConfig({
  issuer: 'test',
  key: Buffer.from('tbi-lab e2e test identity key -- not a secret, tests only'),
});

/** Headers a test uses when it calls a fake backend directly (it is the gate then). */
export const asUser = (subject = 'e2e-user') => ({ 'x-forwarded-user': subject });
