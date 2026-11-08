/**
 * Sprint 22 (s22r) review of 5ff518b: the extra conflict pass never trades a wire's conflict for a
 * new kind (body, pin) and is not started when it could not finish; the exit-lane retry keeps the
 * FIRST best assignment; the 2-pitch run-on is bounded where the route leaves the lane; the result
 * survives save / reload unchanged. Seeds from the review (randomBench(n, seed, dense, board)).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createPackage,
  extraPassStats,
  parsePackage,
  routeConflictsReport,
  serializePackage,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { componentBoxes, routeAutomatic } from '../src/ui/routing.js';
import { deriveScene, deriveSceneVariant, laneStats } from '../src/views/scene3d/scene.js';
import { randomBench } from './support/routingBench.js';

const bench = (n: number, seed: number) => randomBench(n, seed, { dense: true, board: true }).doc;
const conflicts = (d: ProjectDocument) => routeConflictsReport(d, componentBoxes(d));
/** Plan reversals: a run turning straight back on the previous one. */
function reversals(d: ProjectDocument): string[] {
  const out: string[] = [];
  for (const w of deriveScene(d).wires) {
    const pts = w.points.map((p) => ({ x: p.x, z: p.z }));
    const runs: { x: number; z: number }[] = [];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i]!.x - pts[i - 1]!.x;
      const dz = pts[i]!.z - pts[i - 1]!.z;
      const l = Math.hypot(dx, dz);
      if (l > 0.5) runs.push({ x: dx / l, z: dz / l });
    }
    for (let i = 1; i < runs.length; i++)
      if (runs[i]!.x * runs[i - 1]!.x + runs[i]!.z * runs[i - 1]!.z < -0.99) out.push(w.id);
  }
  return out;
}

describe('s22r review: extra pass, lane retry, run-on, save/reload', () => {
  it('the extra pass adds no body or pin conflict (2005, 8014) and is skipped short of budget', () => {
    const a = routeAutomatic(bench(40, 2005));
    expect(extraPassStats.skipped).toBe('budget');
    expect(conflicts(a).kinds).toEqual({ wire: ['W8', 'W24', 'W31'], pin: [], body: [] });
    const b = routeAutomatic(bench(40, 8014));
    expect(conflicts(b).kinds.body).toEqual([]);
    expect(conflicts(b).kinds.body).not.toContain('W20');
  });

  it('a tried extra pass that would not improve without a new conflict kind is rejected (3006)', () => {
    const doc = randomBench(40, 3006, { dense: true }).doc;
    const d = routeAutomatic(doc);
    expect(extraPassStats).toEqual({ tried: 1, kept: 0, skipped: '' });
    expect(conflicts(d).kinds).toEqual({ wire: ['W7', 'W29', 'W35'], pin: [], body: [] });
  });

  it('the lane retry keeps the first best assignment on a tie (9306) and restores it (2011)', () => {
    deriveSceneVariant(routeAutomatic(bench(70, 9306)), true, 'fresh');
    expect(laneStats.scores).toEqual([24, 25, 24, 26]);
    expect(laneStats.kept).toBe(0);
    expect(laneStats.final).toBe(24);
    deriveSceneVariant(routeAutomatic(bench(40, 2011)), true, 'fresh');
    expect(laneStats.final).toBe(Math.min(...laneStats.scores));
    expect(laneStats.final).toBe(laneStats.scores[laneStats.kept]);
  });

  it('the 2-pitch run-on runs (9303, 9306), bounded where the route leaves the lane (relay-load)', () => {
    for (const [n, seed] of [
      [70, 9303],
      [70, 9306],
    ] as const) {
      deriveSceneVariant(routeAutomatic(bench(n, seed)), true, 'fresh');
      expect(laneStats.runOn, `${seed}`).toBeGreaterThan(0);
      expect(laneStats.capped, `${seed}`).toBeGreaterThan(0);
    }
    // Unbounded, the relay's lane ran past where its route turns and W7 turned straight back.
    const relay = routeAutomatic(
      JSON.parse(
        readFileSync(new URL('../src/examples/data/relay-load.json', import.meta.url), 'utf8'),
      ) as ProjectDocument,
    );
    expect(reversals(relay)).toEqual([]);
  });

  it('save / reload through a package gives the identical drawing and scene', () => {
    for (const seed of [2005, 8014]) {
      const d = { ...routeAutomatic(bench(40, seed)), projectId: 'prj_s22review' };
      const text = serializePackage(
        createPackage(d, { appVersion: '0', exportedAt: '2026-10-26T00:00:00.000Z' }),
      );
      const parsed = parsePackage(text);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const again = routeAutomatic(parsed.doc);
      expect(JSON.stringify(again.layout)).toBe(JSON.stringify(d.layout));
      expect(JSON.stringify(deriveScene(again))).toBe(JSON.stringify(deriveScene(d)));
    }
  });
});
