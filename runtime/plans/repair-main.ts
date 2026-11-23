/**
 * TBI-018 s3d-6: operator CLI for the Session Host sim journal torn-tail repair (repairjournal.ts).
 * Run by hand with the Session Host STOPPED, as the host's user, never from a unit or at boot:
 *
 *   node sim-journal-repair.mjs <state dir>            report only (nothing written)
 *   node sim-journal-repair.mjs <state dir> --apply    copy to *.pre-repair, then drop the torn last record
 *
 * Packaged (s3d-7) as one self-contained bundle: `npm run simrepair:build` ->
 * runtime/plans/dist/sim-journal-repair.mjs, installed beside session-host.mjs (staging checklist §5).
 *
 * One JSON line on stdout (counts, byte offsets, the copy's file name; never journal content).
 * Exit: 0 clean or repaired, 2 torn tail found (report only), 3 corrupt (refused, never repaired),
 * 1 usage or an unusable directory / lock held (message on stderr).
 */
import { RepairError, repairTornTail } from './repairjournal.js';

export const REPAIR_EXIT = { ok: 0, error: 1, torn: 2, corrupt: 3 } as const;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const rest = args.filter((a) => a !== '--apply');
if (rest.length !== 1 || rest[0]!.startsWith('-')) {
  process.stderr.write('usage: repair-main <absolute state dir> [--apply]\n');
  process.exit(REPAIR_EXIT.error);
}
try {
  const out = await repairTornTail(rest[0]!, { apply });
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(
    out.kind === 'torn' ? REPAIR_EXIT.torn : out.kind === 'corrupt' ? REPAIR_EXIT.corrupt : 0,
  );
} catch (e) {
  const msg =
    e instanceof RepairError
      ? e.message
      : `failed (${e instanceof Error ? e.constructor.name : 'error'})`;
  process.stderr.write(`sim journal repair: ${msg}\n`);
  process.exit(REPAIR_EXIT.error);
}
