/**
 * Host resource admission (Sprint 8, Phase 4): new expensive work is refused while the host is
 * low on disk or memory — running work is never stopped to make room.
 */
import { readFileSync, statfsSync } from 'node:fs';
import type { GlobalPolicy } from './policy.js';
import { Refusal } from './refusal.js';

export interface ResourceProbe {
  freeDiskMb(path: string): number;
  availableMemoryMb(): number;
}

export const hostProbe: ResourceProbe = {
  freeDiskMb(path) {
    const s = statfsSync(path);
    return (s.bavail * s.bsize) / (1024 * 1024);
  },
  availableMemoryMb() {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
    return m ? Number(m[1]) / 1024 : Number.POSITIVE_INFINITY;
  },
};

/** Throws the matching refusal when a resource is below its floor. */
export function checkResources(
  g: GlobalPolicy['resources'],
  diskPath: string,
  probe: ResourceProbe = hostProbe,
  memory = true,
): void {
  if (probe.freeDiskMb(diskPath) < g.minFreeDiskMb) throw new Refusal('storage_pressure', 30_000);
  if (memory && probe.availableMemoryMb() < g.minAvailableMemoryMb)
    throw new Refusal('memory_pressure', 30_000);
}
