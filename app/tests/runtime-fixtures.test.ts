/**
 * The runtime acceptance fixtures (runtime/tests/fixtures) are exactly the requests the app sends
 * for their examples (minus artifact and ticket), so the real-QEMU tests exercise what users run.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXAMPLES_WITH_DOCUMENTS as EXAMPLES } from '../src/examples/documents.js';
import { buildSessionRequest } from '../src/runtime/snapshot.js';

describe('runtime fixtures', () => {
  it('s10-bench-session.json is the app request for esp32-bench', () => {
    const fx = JSON.parse(
      readFileSync(
        new URL('../../runtime/tests/fixtures/s10-bench-session.json', import.meta.url),
        'utf8',
      ),
    ) as { request: unknown };
    const doc = EXAMPLES.find((e) => e.id === 'esp32-bench')!.document;
    const plan = buildSessionRequest(doc, () => ({ sha256: '0'.repeat(64), origin: 'program' }));
    if (!plan.ok) throw new Error(JSON.stringify(plan.error));
    const { artifact: _artifact, ...request } = plan.plan.request;
    expect(fx.request).toEqual(JSON.parse(JSON.stringify(request)));
  });
});
