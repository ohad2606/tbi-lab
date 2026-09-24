/**
 * R1.12: resource measurements for one classic-ESP32 session on this host. Measurements only:
 * nothing here is a capacity claim (the host is 1 vCPU / 3.8 GiB, and one workload is measured).
 *
 * Recorded per workload: QEMU startup (spawn -> bridge handshake), RSS after boot, peak RSS
 * (VmHWM), host (Node) RSS, QEMU CPU time and wall time against simulation time, shutdown time,
 * per-session overlay cost, and the disk footprint of the provisioned runtime.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runClosedLoop } from '../harness/closedLoop.js';
import {
  QEMU,
  RUNTIME_HOME,
  artifact,
  assertProvisioned,
  recordEvidence,
  runtimeInfo,
} from '../harness/env.js';

function rssKb(pid: number): number {
  const m = /^VmRSS:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
  return Number(m![1]);
}

function du(path: string): string {
  try {
    return execFileSync('du', ['-sh', path], { encoding: 'utf8' }).split('\t')[0]!;
  } catch {
    return 'n/a';
  }
}

describe('R1.12 resource measurements (evidence, not capacity)', () => {
  assertProvisioned();

  it('one release-gate session (TbiGpioProof, 15.5 s simulated, 1 ms tick)', async () => {
    const fw = artifact('TbiGpioProof');
    let pid = 0;
    let rssAfterBootKb = 0;
    let hostPeakRssKb = 0;
    const hostTimer = setInterval(() => {
      hostPeakRssKb = Math.max(hostPeakRssKb, Math.round(process.memoryUsage().rss / 1024));
    }, 100);
    const r = await runClosedLoop({
      qemu: QEMU,
      artifact: fw.path,
      artifactSha256: fw.sha256,
      endNs: 15_500_000_000n,
      tickUs: 1000,
      onSpawn: (p) => (pid = p),
      onTick: (vns) => {
        if (!rssAfterBootKb && vns >= 3_000_000_000n) rssAfterBootKb = rssKb(pid);
      },
    });
    clearInterval(hostTimer);
    expect(r.session.outcome).toBe('completed');
    const s = r.session;
    const simS = Number(s.lastVns) / 1e9;
    const res = {
      host: {
        cpus: cpus().length,
        model: cpus()[0]?.model,
        memTotalMb: Math.round(totalmem() / 2 ** 20),
      },
      runtimeId: runtimeInfo().runtimeId,
      simulatedS: simS,
      startupMs: Math.round(s.startupMs!),
      qemuRssAfterBootMb: +(rssAfterBootKb / 1024).toFixed(1),
      qemuPeakRssMb: +(s.qemu!.vmHwmKb / 1024).toFixed(1),
      qemuRssAtEndMb: +(s.qemu!.vmRssKb / 1024).toFixed(1),
      hostNodePeakRssMb: +(hostPeakRssKb / 1024).toFixed(1),
      qemuCpuS: +(s.qemu!.cpuMs / 1000).toFixed(2),
      wallS: +(s.wallMs / 1000).toFixed(2),
      cpuPerSimS: +(s.qemu!.cpuMs / 1000 / simS).toFixed(3),
      wallPerSimS: +(s.wallMs / 1000 / simS).toFixed(3),
      shutdownMs: Math.round(s.shutdownMs!),
      overlayPrepareMs: +r.prepareMs.toFixed(1),
      overlayBytes: 4 << 20,
      frames: s.frames,
      disk: {
        runtimeHome: du(RUNTIME_HOME),
        qemuInstall: du(`${RUNTIME_HOME}/qemu-current/`),
        artifacts: du(`${RUNTIME_HOME}/artifacts`),
        arduino: du(`${RUNTIME_HOME}/arduino`),
        build: du(`${RUNTIME_HOME}/build`),
        src: du(`${RUNTIME_HOME}/src`),
      },
    };
    console.log(res);
    recordEvidence('resources', res);
    expect(res.qemuRssAfterBootMb).toBeGreaterThan(0);
  });
});
