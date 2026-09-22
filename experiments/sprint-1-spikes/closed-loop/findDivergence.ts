/**
 * Diagnostic: repeat the closed-loop run until one diverges from the first, then report the first
 * virtual-time tick at which the two runs' vCPU PCs differ. Not a test; a debugging aid.
 */
import { runClosedLoop } from './closedLoop.js';
const MAX = Number(process.env.MAX_RUNS ?? 15);
const opts = {
  icount: true,
  endNs: BigInt(process.env.END_NS ?? 3_000_000_000),
  pollUs: Number(process.env.TICK_US ?? 10_000),
  stressMainLoop: process.env.STRESS === '1',
};
const ref = await runClosedLoop(opts);
console.log(`ref: ${ref.timelineSha256.slice(0, 16)} ticks=${ref.ticks.length}`);
for (let i = 2; i <= MAX; i++) {
  const r = await runClosedLoop(opts);
  const same = r.timelineSha256 === ref.timelineSha256;
  console.log(`run ${i}: ${r.timelineSha256.slice(0, 16)} ${same ? 'same' : 'DIVERGED'}`);
  if (!same) {
    const k = ref.ticks.findIndex((t, j) => t !== r.ticks[j]);
    console.log(`first differing tick index ${k}`);
    for (let j = Math.max(0, k - 3); j < Math.min(ref.ticks.length, k + 4); j++) {
      console.log(`  ref ${ref.ticks[j]}\n  div ${r.ticks[j]}`);
    }
    const t = ref.timeline.findIndex((x, j) => x !== r.timeline[j]);
    console.log(`first differing timeline entry ${t}: ref="${ref.timeline[t]}" div="${r.timeline[t]}"`);
    process.exit(0);
  }
}
console.log(`no divergence in ${MAX} runs`);
