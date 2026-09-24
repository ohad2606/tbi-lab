/**
 * R1.5: immutable firmware artifacts, private per-session writable copies, discarded guest writes,
 * and isolation between concurrent sessions.
 *
 * TbiNvs increments an NVS boot counter (a real guest flash write) and prints it. If any session's
 * writes survived into the artifact or another session, a later session would report more than 1.
 */
import { Circuit, GpioPin } from '@tbi-lab/engine';
import { existsSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArtifactError, createSessionOverlay, sha256File } from '../harness/artifacts.js';
import { runCircuitSession, serialLines } from '../harness/circuitSession.js';
import { runClosedLoop } from '../harness/closedLoop.js';
import { QEMU, artifact, assertProvisioned, recordEvidence } from '../harness/env.js';

function nvsSession() {
  const fw = artifact('TbiNvs');
  const c = new Circuit();
  const pin = c.add(new GpioPin('IO2', 'io2', 'input'));
  return runCircuitSession({
    qemu: QEMU,
    artifact: fw.path,
    artifactSha256: fw.sha256,
    circuit: c,
    pads: [{ pad: 2, pin, node: 'io2', input: false }],
    endNs: 2_000_000_000n,
  }).then((r) => ({ r, lines: serialLines(r.serialTimeline).map((l) => l.text) }));
}

describe('R1.5 firmware artifacts and session isolation', () => {
  assertProvisioned();

  it('artifacts are content-addressed and read-only on disk', () => {
    for (const name of ['TbiNvs', 'TbiGpioProof', 'micropython']) {
      const a = artifact(name);
      expect(sha256File(a.path)).toBe(a.sha256);
      expect(statSync(a.path).mode & 0o222, `${name} is not writable`).toBe(0);
    }
  });

  it('each session gets a fresh private 0700 directory with a 0600 copy; discard removes it', () => {
    const a = artifact('TbiNvs');
    const o1 = createSessionOverlay(a.path, a.sha256);
    const o2 = createSessionOverlay(a.path, a.sha256);
    expect(o1.dir).not.toBe(o2.dir);
    expect(statSync(o1.dir).mode & 0o777).toBe(0o700);
    expect(statSync(o1.flash).mode & 0o777).toBe(0o600);
    expect(o1.guestWrote()).toBe(false);
    o1.discard();
    o2.discard();
    expect(existsSync(o1.dir)).toBe(false);
  });

  it('a tampered or missing artifact is refused before any session starts', () => {
    const a = artifact('TbiNvs');
    expect(() => createSessionOverlay(a.path, '0'.repeat(64))).toThrow(ArtifactError);
    try {
      createSessionOverlay(`${a.path}.missing`, a.sha256);
    } catch (e) {
      expect((e as ArtifactError).code).toBe('artifact_missing');
    }
  });

  it('guest NVS writes happen, are confined to the session, and are discarded (sequential sessions)', async () => {
    const a = artifact('TbiNvs');
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await nvsSession());
    for (const { r, lines } of results) {
      expect(r.session.outcome).toBe('completed');
      expect(lines).toContain('TBI-NVS-BOOTS=1');
      expect(lines).toContain('TBI-NVS-DONE');
      expect(r.guestWroteFlash, 'the guest really wrote its private flash').toBe(true);
    }
    expect(sha256File(a.path), 'artifact unchanged').toBe(a.sha256);
    recordEvidence(
      'isolation-sequential',
      results.map(({ r, lines }) => ({
        guestWroteFlash: r.guestWroteFlash,
        boots: lines.find((l) => l.startsWith('TBI-NVS-BOOTS')),
      })),
    );
  });

  it('concurrent sessions are isolated: NVS, and the release-gate workload stays bit-identical', async () => {
    const gp = artifact('TbiGpioProof');
    const gate = () =>
      runClosedLoop({
        qemu: QEMU,
        artifact: gp.path,
        artifactSha256: gp.sha256,
        endNs: 15_500_000_000n,
        tickUs: 1000,
      });
    const solo = await gate();
    const [n1, n2, g1, g2] = await Promise.all([nvsSession(), nvsSession(), gate(), gate()]);
    for (const { r, lines } of [n1, n2]) {
      expect(r.session.outcome).toBe('completed');
      expect(lines).toContain('TBI-NVS-BOOTS=1');
    }
    for (const g of [g1, g2]) {
      expect(g.session.outcome).toBe('completed');
      expect(g.timelineSha256, 'concurrent run equals the solo run').toBe(solo.timelineSha256);
      expect(g.serialTimedSha256).toBe(solo.serialTimedSha256);
    }
    expect(sha256File(artifact('TbiNvs').path)).toBe(artifact('TbiNvs').sha256);
    expect(sha256File(gp.path)).toBe(gp.sha256);
    recordEvidence('isolation-concurrent', {
      solo: solo.timelineSha256,
      concurrent: [g1.timelineSha256, g2.timelineSha256],
      wallMs: { solo: solo.session.wallMs, concurrent: [g1.session.wallMs, g2.session.wallMs] },
    });
  });
});
