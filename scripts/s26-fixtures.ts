/**
 * Sprint 26: write the runtime fixtures of the multi-file examples (the app's session request
 * minus artifact and ticket), as app/tests/runtime-fixtures.test.ts checks them.
 *   npx vite-node scripts/s26-fixtures.ts
 */
import { writeFileSync } from 'node:fs';
import { EXAMPLES_WITH_DOCUMENTS as EXAMPLES } from '../app/src/examples/documents.js';
import { buildSessionRequest } from '../app/src/runtime/snapshot.js';

for (const [file, id] of [
  ['s26-esp32-lcd-library-session.json', 'esp32-lcd-library'],
  ['s26-mpy-lcd-library-session.json', 'mpy-lcd-library'],
] as const) {
  const doc = EXAMPLES.find((e) => e.id === id)!.document;
  const plan = buildSessionRequest(doc, () => ({ sha256: '0'.repeat(64), origin: 'program' }));
  if (!plan.ok) throw new Error(JSON.stringify(plan.error));
  const { artifact: _artifact, ...request } = plan.plan.request;
  const url = new URL(`../runtime/tests/fixtures/${file}`, import.meta.url);
  const _comment = `Sprint 26: the app request for ${id} (app/tests/runtime-fixtures.test.ts keeps it equal).`;
  writeFileSync(url, `${JSON.stringify({ _comment, request }, null, 2)}\n`);
  console.log(`wrote ${file}`);
}
