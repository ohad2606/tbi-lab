/**
 * Regenerate the curated example documents from their recipes:
 *   npx vite-node scripts/build-examples.ts
 */
import { writeFileSync } from 'node:fs';
import { RECIPES } from '../app/tests/exampleRecipes.js';

for (const [id, build] of Object.entries(RECIPES)) {
  const file = new URL(`../app/src/examples/data/${id}.json`, import.meta.url);
  writeFileSync(file, `${JSON.stringify(build(), null, 2)}\n`);
  console.log(`wrote ${id}.json`);
}
