/** Diagnostic: N closed-loop runs (3 s window) with main-loop stress; report distinct outcomes. */
import { runClosedLoop } from './closedLoop.js';
const N = Number(process.env.N ?? 8);
const stress = process.env.STRESS !== '0';
const seen = new Map<string, number>();
const firstApp: string[] = [];
for (let i = 1; i <= N; i++) {
  const r = await runClosedLoop({ icount: true, endNs: 3_000_000_000n, pollUs: 10_000, stressMainLoop: stress });
  seen.set(r.timelineSha256, (seen.get(r.timelineSha256) ?? 0) + 1);
  const app = r.timeline.find((l) => l.startsWith('O') && l.includes('gpio2=')) ?? 'none';
  firstApp.push(app.split(' ')[1] ?? '?');
  console.log(`run ${i}: ${r.timelineSha256.slice(0, 16)} firstGpio2@${app.split(' ')[1]}`);
}
console.log(JSON.stringify({ stress, runs: N, distinctTimelines: seen.size, counts: [...seen.values()] }));
