/**
 * What the 3D view shows live while a simulation runs (moved out of ThreeView.tsx in Sprint 18F,
 * unchanged, so it is unit-tested): LED glow from the solved forward current (a visual cue, as on
 * the circuit canvas), matrix dots, LCD content, the servo horn at its reported shaft angle, the
 * RGB mix. Only a RUNNING simulation with a successful outcome reports anything: stopped,
 * starting, stopping, failed (a refusal, a crash) or an unsolved outcome give no levels, so every
 * part shows its rest state (a servo horn at SERVO_REST_DEG) and nothing keeps moving.
 */
import type { ProjectDocument } from '@tbi-lab/domain';
import type { SimState } from '../sim/controller.js';
import type { LiveLevel } from '../views/scene3d/renderer.js';
import { rgbMix } from '../views/ledLooks.js';
import { lcdView, servoAngle } from './symbols.js';

export function liveLevels(
  doc: ProjectDocument | null | undefined,
  sim: SimState,
): Record<string, LiveLevel> {
  const outcome = sim.status === 'running' && sim.outcome.ok ? sim.outcome : null;
  const levels: Record<string, LiveLevel> = {};
  if (outcome && doc)
    for (const c of doc.components)
      if (c.type === 'component.led') {
        const i = outcome.components[c.id]?.current ?? 0;
        if (i && i > 0) levels[c.id] = Math.min(1, Math.max(0.08, i / 0.02));
      } else if (c.type === 'display.led_matrix_8x8') {
        // Each dot's level from ITS solved current (full at 20 mA).
        const arr = outcome.components[c.id]?.array;
        if (arr && arr.currents.some((i) => i > 1e-6))
          levels[c.id] = {
            dots: arr.currents.map((i) => (i > 1e-6 ? Math.min(1, Math.max(0.15, i / 0.02)) : 0)),
          };
      } else if (c.type === 'display.lcd1602_i2c') {
        // Sprint 12: the LCD shows exactly what the engine reports (blank without it).
        const lcd = lcdView(outcome.components[c.id]?.state);
        if (lcd) levels[c.id] = { lcd };
      } else if (c.type === 'component.servo_sg90') {
        // Sprint 15: the horn at the angle the engine or the runtime reports (rest without one).
        const angle = servoAngle(outcome.components[c.id]?.state);
        if (angle !== undefined) levels[c.id] = { servoDeg: angle };
      } else if (c.type === 'component.rgb_led') {
        // The emitted colour is the mix of the SOLVED channel currents (never a chosen colour).
        const mix = rgbMix(outcome.components[c.id]?.currents ?? {});
        if (mix) levels[c.id] = { level: mix.intensity, color: mix.color };
      }
  return levels;
}
