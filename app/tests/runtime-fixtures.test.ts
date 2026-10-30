/**
 * The runtime acceptance fixtures (runtime/tests/fixtures) are exactly the requests the app sends
 * for their examples (minus artifact and ticket), so the real-QEMU tests exercise what users run.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXAMPLES_WITH_DOCUMENTS as EXAMPLES } from '../src/examples/documents.js';
import { buildSessionRequest } from '../src/runtime/snapshot.js';
import { sourceKey, type ProgramSource } from '@tbi-lab/domain';
import { systemSourceKeys } from '../../runtime/builder/system-sources.js';

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

  // Sprint 11 (R1): the two curated examples with the Sprint 10 parts.
  for (const [file, id] of [
    ['r1-motion-relay-session.json', 'esp32-motion-relay'],
    ['r1-night-light-session.json', 'esp32-night-light'],
    // Sprint 12 (R2/R3): the three curated examples with the new parts.
    ['s12-distance-alarm-session.json', 'esp32-distance-alarm'],
    ['s12-thermo-hygrometer-session.json', 'esp32-thermo-hygrometer'],
    ['s12-lcd-hello-session.json', 'esp32-lcd-hello'],
    // Sprint 15 (R4): the two PWM examples.
    ['s15-led-fade-session.json', 'esp32-led-fade'],
    ['s15-servo-sweep-session.json', 'esp32-servo-sweep'],
    // Sprint 19B (Exploration Foundation X1): ESP32 + logic gate.
    ['s19b-logic-and-session.json', 'esp32-logic-and'],
    // Sprint 24 (M1): the MicroPython examples.
    ['s24-mpy-blink-session.json', 'mpy-blink'],
    ['s24-mpy-button-session.json', 'mpy-button'],
    ['s24-mpy-fade-session.json', 'mpy-fade'],
  ] as const)
    it(`${file} is the app request for ${id}`, () => {
      const fx = JSON.parse(
        readFileSync(new URL(`../../runtime/tests/fixtures/${file}`, import.meta.url), 'utf8'),
      ) as { request: unknown };
      const doc = EXAMPLES.find((e) => e.id === id)!.document;
      const plan = buildSessionRequest(doc, () => ({ sha256: '0'.repeat(64), origin: 'program' }));
      if (!plan.ok) throw new Error(JSON.stringify(plan.error));
      const { artifact: _artifact, ...request } = plan.plan.request;
      expect(fx.request).toEqual(JSON.parse(JSON.stringify(request)));
    });

  it('every ESP32 example runs a curated system source (a shared build: no build-service change)', () => {
    const keys = systemSourceKeys();
    const boards = EXAMPLES.filter((e) =>
      e.document.components.some((c) => c.type === 'board.esp32_devkitc_wroom32'),
    );
    expect(boards.map((e) => e.id)).toEqual(
      expect.arrayContaining(['esp32-motion-relay', 'esp32-night-light']),
    );
    for (const e of boards) {
      const programs = Object.values(
        (e.document as unknown as { programs?: Record<string, ProgramSource> }).programs ?? {},
      );
      expect(programs.length, e.id).toBe(1);
      const p = programs[0]!;
      expect(keys.has(sourceKey(p.profile, [{ name: p.fileName, text: p.text }])), e.id).toBe(true);
    }
  });
});
