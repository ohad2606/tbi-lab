/**
 * The `capabilities` of a provisioned runtime.json, as the build service reads them at start-up.
 * Known tokens only (the bridge's canonical list), sorted; anything else fails closed.
 */
import { readFileSync } from 'node:fs';
import { CAPABILITIES } from '../harness/protocol.js';

export function runtimeCapabilitiesFrom(file: string | undefined): string[] {
  if (!file) return [];
  const caps = (JSON.parse(readFileSync(file, 'utf8')) as { capabilities?: unknown }).capabilities;
  // A runtime provisioned before Sprint 12 records no capabilities: a v1 bridge has none.
  if (caps === undefined) return [];
  if (
    !Array.isArray(caps) ||
    !caps.every((c) => typeof c === 'string' && (CAPABILITIES as readonly string[]).includes(c))
  )
    throw new Error(`${file}: no valid "capabilities" list`);
  return [...caps].sort();
}
