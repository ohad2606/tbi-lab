/**
 * Sprint 18F (owner acceptance): the SG90 horn in the 3D view follows the simulation's angle.
 *
 * The defect: the renderer's static batching merged the horn's meshes into the per-material
 * batches with their transforms baked in, leaving the `servoHorn` group empty; turning it moved
 * nothing. Here, in node (no WebGL):
 * - the horn is a moving part, its meshes are never batchable, and the case's are;
 * - the horn pivots on the output shaft: 0 / 45 / 90 / 180 deg put the arm tip at exactly that
 *   angle about the shaft (counter-clockwise from above, as the 2D symbol), at the arm's reach;
 *   the modelled travel clamps;
 * - the live level comes only from a RUNNING, solved outcome: stopped, starting, stopping, failed
 *   (refusal or crash) and unsolved give none (the horn at rest; nothing keeps moving).
 * The browser side (the drawn horn really turns, the view lifecycle) is e2e/s18f-servo-3d.spec.ts;
 * the real Runtime v3 angle into the 3D view is e2e/s18-r4b-real.spec.ts.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createProject, type ProjectDocument } from '@tbi-lab/domain';
import type { SolveOutcome } from '@tbi-lab/engine';
import {
  buildComponent,
  createMaterials,
  movingPart,
  OwnedResources,
  servoHornYaw,
  SERVO_REST_DEG,
} from '../src/views/scene3d/models.js';
import { SERVO_SG90, SERVO_SHAFT_X_MM } from '../src/views/scene3d/physical.js';
import type { SceneComponent } from '../src/views/scene3d/scene.js';
import { liveLevels } from '../src/ui/liveLevels.js';
import type { SimState } from '../src/sim/controller.js';

function servoModel() {
  const c = {
    id: 'M1',
    type: 'component.servo_sg90',
    model: 'servo.sg90',
    x: 10,
    z: -5,
    rotationY: Math.PI / 2,
    terminals: [],
    visual: {},
  } as unknown as SceneComponent;
  const g = buildComponent(c, createMaterials(), new OwnedResources(null, 'reduced'));
  g.updateMatrixWorld(true);
  const horn = g.getObjectByName('servoHorn')!;
  return { g, horn };
}

/** The arm tip's angle about the shaft, in the part's own frame (deg, CCW from above, +x = 0). */
function tipAngle(horn: THREE.Object3D, yaw: number) {
  horn.rotation.y = yaw;
  horn.updateMatrix();
  const tip = new THREE.Vector3(SERVO_SG90.hornReachMm, 0, 0).applyMatrix4(horn.matrix);
  const dx = tip.x - SERVO_SHAFT_X_MM;
  const dz = tip.z;
  return { deg: (Math.atan2(-dz, dx) * 180) / Math.PI, reach: Math.hypot(dx, dz), y: tip.y };
}

describe('S18F: the SG90 horn in 3D', () => {
  it('the horn is a moving part: its meshes are never statically batched; the case is', () => {
    const { g, horn } = servoModel();
    expect(horn.userData.moving).toBe(true);
    const inHorn: THREE.Mesh[] = [];
    const rest: THREE.Mesh[] = [];
    g.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      let p: THREE.Object3D | null = o;
      while (p && p !== horn) p = p.parent;
      (p ? inHorn : rest).push(o as THREE.Mesh);
    });
    expect(inHorn.length).toBe(4); // hub, arm, tip, screw
    expect(inHorn.every(movingPart)).toBe(true);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.some(movingPart)).toBe(false);
  });

  it('pivot on the output shaft; 0 / 45 / 90 / 180 deg exactly; travel clamped; rest 90', () => {
    const { horn } = servoModel();
    expect(horn.position.x).toBeCloseTo(SERVO_SHAFT_X_MM, 9);
    expect(horn.position.z).toBeCloseTo(0, 9);
    expect(horn.position.y).toBeCloseTo(SERVO_SG90.hornBottomMm, 9);
    for (const a of [0, 45, 90, 135, 180, 37.5]) {
      const t = tipAngle(horn, servoHornYaw(a));
      expect(t.deg).toBeCloseTo(a, 9);
      expect(t.reach).toBeCloseTo(SERVO_SG90.hornReachMm, 9);
      expect(t.y).toBeCloseTo(SERVO_SG90.hornBottomMm, 9); // turns in its own plane
    }
    expect(tipAngle(horn, servoHornYaw(-20)).deg).toBeCloseTo(0, 9);
    expect(tipAngle(horn, servoHornYaw(200)).deg).toBeCloseTo(180, 9);
    expect(servoHornYaw(undefined)).toBeCloseTo((SERVO_REST_DEG * Math.PI) / 180, 12);
  });

  const doc = (): ProjectDocument => {
    const d = createProject({
      projectId: 'prj_s18f',
      deviceId: 'dev',
      name: 'S18F',
      appVersion: '0',
    });
    return {
      ...d,
      components: [{ id: 'M1', type: 'component.servo_sg90', x: 0, y: 0, rotation: 0, params: {} }],
    } as unknown as ProjectDocument;
  };
  const running = (angleDeg: number | undefined, ok = true): SimState =>
    ({
      status: 'running',
      outcome: ok
        ? ({
            ok: true,
            components: {
              M1: {
                state: angleDeg === undefined ? { powered: false } : { angleDeg, powered: true },
              },
            },
          } as unknown as SolveOutcome)
        : ({ ok: false } as unknown as SolveOutcome),
      timings: {},
      solves: 1,
      pressed: [],
    }) as unknown as SimState;

  it('the live angle is exactly the reported one, only while running and solved', () => {
    for (const a of [0, 0.03, 89.99, 90, 179.97, 180])
      expect(liveLevels(doc(), running(a))).toEqual({ M1: { servoDeg: a } });
    // No reported angle: rest.
    expect(liveLevels(doc(), running(undefined))).toEqual({});
    // Not running, or no solved outcome: nothing (rest; no motion continues).
    for (const s of [
      { status: 'stopped' },
      { status: 'starting' },
      { status: 'stopping' },
      { status: 'failed', failure: { code: 'runtime_crashed' } },
      { status: 'failed', failure: { code: 'pwm_duty_zero_unverified' } },
    ] as unknown as SimState[])
      expect(liveLevels(doc(), s)).toEqual({});
    expect(liveLevels(doc(), running(45, false))).toEqual({});
    expect(liveLevels(null, running(45))).toEqual({});
  });
});
