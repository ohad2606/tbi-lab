/**
 * TBI-018 s3d-8: operator CLI of the OFFLINE sim-plans config validator (validateconfig.ts). Run by hand
 * as the Session Host's user with the SAME environment the unit gives the host (the TBI_HOST_SIM_* flags,
 * TBI_POLICY_FILE, TBI_HOST_LEASE_MS); it takes no arguments:
 *
 *   sudo -u <user> env TBI_HOST_SIM_PLANS_CONFIG=... TBI_HOST_SIM_PLANS_STATE=... \
 *     TBI_HOST_SIM_PLAN_MAP=... TBI_POLICY_FILE=... [TBI_HOST_LEASE_MS=...] <node> sim-config-validate.mjs
 *
 * Packaged like the repair CLI: `npm run simvalidate:build` -> runtime/plans/dist/sim-config-validate.mjs
 * (one self-contained file, no node_modules). Never starts a host, never writes or locks anything.
 *
 * stdout: one JSON line `{"status","problems":[{code,message,detail?}],"notes":[...]}` (codes, flag
 * names, counts; never a value, path or file content). stderr: one human line per problem.
 *
 * Exit (VALIDATE_EXIT):
 *   0   ok: the flags are set and the host would boot metered with them
 *   1   problems: at least one problem (each one would make the host refuse, exit 78, except
 *       `state_dir_missing`, which the validator requires to be created beforehand), or an internal error
 *   78  refused to validate (EX_CONFIG, the same code as HOST_SIM_REFUSED_EXIT): no TBI_HOST_SIM_* flag
 *       is set (nothing to validate: the operator's environment is not the unit's), or an argument was
 *       given (the validator takes none)
 */
import { HOST_SIM_REFUSED_EXIT } from './hostflags.js';
import { validateSimConfig } from './validateconfig.js';

export const VALIDATE_EXIT = { ok: 0, problems: 1, refused: HOST_SIM_REFUSED_EXIT } as const;

const NAME = 'sim config validate';

if (process.argv.length > 2) {
  process.stderr.write(
    `${NAME}: takes no arguments; set the unit's TBI_HOST_SIM_* / TBI_POLICY_FILE / TBI_HOST_LEASE_MS environment\n`,
  );
  process.exit(VALIDATE_EXIT.refused);
}
try {
  const r = await validateSimConfig(process.env);
  process.stdout.write(`${JSON.stringify(r)}\n`);
  if (r.status === 'off') {
    process.stderr.write(`${NAME}: no TBI_HOST_SIM_* flag set; nothing to validate (refused)\n`);
    process.exit(VALIDATE_EXIT.refused);
  }
  for (const p of r.problems)
    process.stderr.write(`${NAME}: ${p.code}: ${p.message}${p.detail ? ` (${p.detail})` : ''}\n`);
  process.exit(r.status === 'ok' ? VALIDATE_EXIT.ok : VALIDATE_EXIT.problems);
} catch (e) {
  process.stderr.write(`${NAME}: failed (${e instanceof Error ? e.constructor.name : 'error'})\n`);
  process.exit(VALIDATE_EXIT.problems);
}
