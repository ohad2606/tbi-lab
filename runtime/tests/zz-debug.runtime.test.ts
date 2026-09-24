import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Circuit } from '@tbi-lab/engine';
import { runCircuitSession } from '../harness/circuitSession.js';
import { QEMU } from '../harness/env.js';
it('dbg', async () => {
  const img = Buffer.alloc(4 << 20, 0xff);
  const p = '/tmp/claude-1001/-home-ubuntu/a3c7cde7-e171-4708-b57b-e2e09055e051/scratchpad/ff.bin';
  writeFileSync(p, img);
  const r = await runCircuitSession({ qemu: QEMU, artifact: p, artifactSha256: createHash('sha256').update(img).digest('hex'), circuit: new Circuit(), pads: [], endNs: 1_000_000_000n, session: { wallTimeoutMs: 20000 } });
  console.log(r.session.outcome, r.session.frames, r.session.lastVns);
  const t = r.serialTimeline;
  console.log(t.length, t.slice(0, 3).map(s => s.vns + ' ' + JSON.stringify(s.bytes.toString())), t.slice(-6).map(s => s.vns + ' ' + JSON.stringify(s.bytes.toString())));
  console.log(JSON.stringify(r.session.serial.toString().slice(-300)));
});
