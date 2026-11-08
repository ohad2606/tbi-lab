/**
 * Sprint 13 H1 (PM review): supported / limited / refused stays consistent across every layer that
 * decides it, part by part: the capability panel (domain registry, from the catalog), the palette
 * (placementBlock), the Run planner's refusal (buildSessionRequest) and the panel section a Run
 * error links to. The Session Host applies the same catalog predicate (runtime/host/session.ts),
 * and the build service's facility codes are tied to the registry in runtime/builder tests.
 */
import { describe, expect, it } from 'vitest';
import {
  CATALOG_ORDER,
  addComponent,
  partCapabilities,
  placementBlock,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { EXAMPLES_WITH_DOCUMENTS as EXAMPLES } from '../src/examples/documents.js';
import { buildSessionRequest } from '../src/runtime/snapshot.js';
import { sectionForFailure } from '../src/ui/Capabilities.js';

const base = (): ProjectDocument =>
  structuredClone(EXAMPLES.find((e) => e.id === 'esp32-blink')!.document);
const plan = (doc: ProjectDocument) =>
  buildSessionRequest(doc, () => ({ sha256: '0'.repeat(64), origin: 'program' }));
const RUN_CODE = {
  part_time_dependent: 'mcu_component_time_dependent',
  part_needs_runtime: 'mcu_component_unsupported',
} as const;

describe('capability consistency, part by part (ESP32 project)', () => {
  it('the example itself plans cleanly', () => {
    expect(plan(base()).ok).toBe(true);
  });

  for (const cap of partCapabilities()) {
    it(`${cap.type}: panel, palette and Run agree (${cap.status}${cap.reason ? `, ${cap.reason}` : ''})`, () => {
      const doc = base();
      // Palette: the reason a part cannot be placed next to the board.
      expect(placementBlock(doc, cap.type)).toBe(cap.reason ?? null);
      // Run: the same part in the project is refused with the matching code, or not at all.
      const added = addComponent(doc, cap.type, { x: 1200, y: 900 });
      if (!added.ok) throw new Error(added.error);
      const p = plan(added.doc);
      if (cap.reason) {
        expect(p.ok).toBe(false);
        if (!p.ok) {
          expect(p.error.code).toBe(RUN_CODE[cap.reason]);
          expect(p.error.components).toContain(added.id);
          // The Run error links to the panel's parts section.
          expect(sectionForFailure(p.error.code)).toBe('parts');
        }
      } else if (!p.ok) {
        // Supported parts are never refused for being unsupported (other plan rules may apply).
        expect(p.error.code).not.toMatch(/^mcu_component_/);
      }
    });
  }

  it('the registry covers every catalog part except the board', () => {
    expect(
      partCapabilities()
        .map((p) => p.type)
        .sort(),
    ).toEqual(CATALOG_ORDER.filter((t) => t !== 'board.esp32_devkitc_wroom32').sort());
  });
});
