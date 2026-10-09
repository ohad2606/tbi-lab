/**
 * The curated system sources (Sprint 8, D-S8-3, owner decision Q3): the sketches shipped with the
 * product — the example projects' programs and the starter program of a new board. Builds of
 * exactly these sources are shared records (`global`), so everyone gets their cache hit; every
 * other source is private to the principal who built it.
 */
import { sourceKey, starterProgram, type ProgramSource } from '@tbi-lab/domain';
import blink from '../../app/src/examples/data/esp32-blink.json' with { type: 'json' };
import echo from '../../app/src/examples/data/esp32-input-echo.json' with { type: 'json' };
// Sprint 12 (R2/R3 curated examples).
import distance from '../../app/src/examples/data/esp32-distance-alarm.json' with { type: 'json' };
import thermo from '../../app/src/examples/data/esp32-thermo-hygrometer.json' with { type: 'json' };
import lcd from '../../app/src/examples/data/esp32-lcd-hello.json' with { type: 'json' };

const programsOf = (doc: unknown): ProgramSource[] =>
  Object.values((doc as { programs?: Record<string, ProgramSource> }).programs ?? {});

export function systemSourceKeys(): Set<string> {
  const programs = [
    ...programsOf(blink),
    ...programsOf(echo),
    ...programsOf(distance),
    ...programsOf(thermo),
    ...programsOf(lcd),
    starterProgram('board.esp32_devkitc_wroom32'),
  ].filter((p): p is ProgramSource => !!p);
  return new Set(programs.map((p) => sourceKey(p.profile, [{ name: p.fileName, text: p.text }])));
}
