/**
 * The curated system sources (Sprint 8, D-S8-3, owner decision Q3): the sketches shipped with the
 * product — the example projects' programs and the starter program of a new board. Builds of
 * exactly these sources are shared records (`global`), so everyone gets their cache hit; every
 * other source is private to the principal who built it.
 */
import { programBuildFiles, starterProgram, type ProgramSource } from '@tbi-lab/domain';
import { requestKey } from './libraries.js';
import { BUILD_PROTOCOL, type BuildRequest } from './protocol.js';
import blink from '../../app/src/examples/data/esp32-blink.json' with { type: 'json' };
import echo from '../../app/src/examples/data/esp32-input-echo.json' with { type: 'json' };
// Sprint 12 (R2/R3 curated examples).
import distance from '../../app/src/examples/data/esp32-distance-alarm.json' with { type: 'json' };
import thermo from '../../app/src/examples/data/esp32-thermo-hygrometer.json' with { type: 'json' };
import lcd from '../../app/src/examples/data/esp32-lcd-hello.json' with { type: 'json' };
// Sprint 15 (R4 curated examples).
import fade from '../../app/src/examples/data/esp32-led-fade.json' with { type: 'json' };
import sweep from '../../app/src/examples/data/esp32-servo-sweep.json' with { type: 'json' };
// Sprint 19B (Exploration Foundation X1).
import logicAnd from '../../app/src/examples/data/esp32-logic-and.json' with { type: 'json' };
// Exploration Foundation L3 interop.
import logicQuadAnd from '../../app/src/examples/data/esp32-logic-quad-and.json' with { type: 'json' };
// Sprint 20 logic example D (ESP32 + manual input + OR gate).
import logicOverride from '../../app/src/examples/data/esp32-logic-override.json' with { type: 'json' };
// Sprint 24 (M1): the MicroPython examples (built by the MicroPython profile where it is offered).
import mpyBlink from '../../app/src/examples/data/mpy-blink.json' with { type: 'json' };
import mpyButton from '../../app/src/examples/data/mpy-button.json' with { type: 'json' };
import mpyFade from '../../app/src/examples/data/mpy-fade.json' with { type: 'json' };
import mpyLcdHello from '../../app/src/examples/data/mpy-lcd-hello.json' with { type: 'json' };
// Sprint 25 (Phase 4): a potentiometer read as a digital level.
import potThreshold from '../../app/src/examples/data/esp32-pot-threshold.json' with { type: 'json' };
import mpyPotThreshold from '../../app/src/examples/data/mpy-pot-threshold.json' with { type: 'json' };
// Sprint 26: multi-file programs with a managed library.
import lcdLibrary from '../../app/src/examples/data/esp32-lcd-library.json' with { type: 'json' };
import mpyLcdLibrary from '../../app/src/examples/data/mpy-lcd-library.json' with { type: 'json' };
// Sprint 29 (M4): an ESP32 in MicroPython reading a logic half adder.
import mpyAdderMonitor from '../../app/src/examples/data/mpy-adder-monitor.json' with { type: 'json' };
// Sprint 30 (M2/M4): firmware → logic → firmware feedback with a relay stage, both languages.
import logicFeedback from '../../app/src/examples/data/esp32-logic-feedback.json' with { type: 'json' };
import mpyLogicFeedback from '../../app/src/examples/data/mpy-logic-feedback.json' with { type: 'json' };
// MicroPython expansion: verified twins (same circuits, the other language).
import mpyInputEcho from '../../app/src/examples/data/mpy-input-echo.json' with { type: 'json' };
import mpyServoSweep from '../../app/src/examples/data/mpy-servo-sweep.json' with { type: 'json' };
import esp32Button from '../../app/src/examples/data/esp32-button.json' with { type: 'json' };
import esp32AdderMonitor from '../../app/src/examples/data/esp32-adder-monitor.json' with { type: 'json' };
import mpyLogicAnd from '../../app/src/examples/data/mpy-logic-and.json' with { type: 'json' };
import mpyLogicQuadAnd from '../../app/src/examples/data/mpy-logic-quad-and.json' with { type: 'json' };
import mpyLogicOverride from '../../app/src/examples/data/mpy-logic-override.json' with { type: 'json' };
import mpyDistanceAlarm from '../../app/src/examples/data/mpy-distance-alarm.json' with { type: 'json' };

const programsOf = (doc: unknown): ProgramSource[] =>
  Object.values((doc as { programs?: Record<string, ProgramSource> }).programs ?? {});

function systemPrograms(): ProgramSource[] {
  return [
    ...programsOf(blink),
    ...programsOf(echo),
    ...programsOf(distance),
    ...programsOf(thermo),
    ...programsOf(lcd),
    ...programsOf(fade),
    ...programsOf(sweep),
    ...programsOf(logicAnd),
    ...programsOf(logicQuadAnd),
    ...programsOf(logicOverride),
    ...programsOf(mpyBlink),
    ...programsOf(mpyButton),
    ...programsOf(mpyFade),
    ...programsOf(mpyLcdHello),
    ...programsOf(potThreshold),
    ...programsOf(mpyPotThreshold),
    ...programsOf(lcdLibrary),
    ...programsOf(mpyLcdLibrary),
    ...programsOf(mpyAdderMonitor),
    ...programsOf(logicFeedback),
    ...programsOf(mpyLogicFeedback),
    // mpy-bench, mpy-motion-relay and mpy-night-light run mpy-input-echo's program.
    ...programsOf(mpyInputEcho),
    ...programsOf(mpyServoSweep),
    ...programsOf(esp32Button),
    ...programsOf(esp32AdderMonitor),
    ...programsOf(mpyLogicAnd),
    ...programsOf(mpyLogicQuadAnd),
    ...programsOf(mpyLogicOverride),
    ...programsOf(mpyDistanceAlarm),
    starterProgram('board.esp32_devkitc_wroom32'),
  ].filter((p): p is ProgramSource => !!p);
}

/** Sprint 26: a program as its build request (every file, entry first, and its libraries). */
export const programRequest = (p: ProgramSource): BuildRequest => ({
  protocol: BUILD_PROTOCOL,
  profile: p.profile,
  files: programBuildFiles(p),
  ...(p.libraries?.length ? { libraries: p.libraries } : {}),
});

export function systemSourceKeys(): Set<string> {
  return new Set(systemPrograms().map((p) => requestKey(programRequest(p))));
}

/** Sprint 18F: the curated sources as build requests (the service prewarms their builds). */
export function systemBuildRequests(): BuildRequest[] {
  const seen = new Set<string>();
  return systemPrograms()
    .map(programRequest)
    .filter((r) => {
      const key = requestKey(r);
      return !seen.has(key) && seen.add(key);
    });
}
