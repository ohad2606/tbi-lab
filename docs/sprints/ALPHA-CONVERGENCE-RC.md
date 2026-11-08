# Alpha Convergence RC (rc6)

One release candidate that joins the two lines that diverged at `71c4ce7`: the DEV line (Sprints
24-30, Runtime v5 engine and examples, icon set) and the Alpha line (tester management, feedback).
Preparation only: it is not merged and not deployed by this document.

## Source commits

| Part | Commit |
|---|---|
| DEV frontend (base of this branch) | `5994184` (`icon-quality`) |
| DEV services (ancestor of the frontend commit) | `e38b444` (`sprint-30`) |
| Running Alpha (frontend and services) | `2fe1ca0` (`s23c`) |
| Alpha functionality merged here | `e6ea180` (`phase-c-admin`; `2fe1ca0` plus two commits) |
| Integration merge | `ad33573` |

The running Alpha commit and the merged commit are not identical; the two extra commits are the
Phase C application changes. The admission gate is operations work kept outside this repository;
it does not change application code and is neither copied nor reimplemented here.

The production icon set in `alpha-icons` (`97e925d`) and `5994184` is the same tree, so no separate
icon merge exists and the icons are not a release dependency.

## Integration decisions

Conflicts were resolved by intended behaviour, not by taking one side.

- **App shell and strings** (`App.tsx`, `styles.css`, messages EN/HE): both the Assist panel and the
  administration; `package.json` and `vitest.config.ts` likewise.
- **Build service** (`runtime/builder/service.ts`): failure sharing keeps the DEV rule and also
  excludes `account_disabled` results; the abort check before `provider.build` passes libraries and
  curated sets; an aborted build is `cancelled` before `recordBuild`, with analyzer and capabilities
  recorded; a prewarm record has `emailTag: null`.
- **Installer** (`deploy/dev-lab/s8/install.sh`): per-instance socket and artifact groups from DEV,
  with the Alpha line's feedback and admin rendering on top. `TBI_S23_ADMIN` is refused for the
  staging target: the admin service and its helper are single-instance.
- **Units**: per-instance `User=` and `SupplementaryGroups=` from DEV.
- **Release profiles**: `rc6-admin` and `rc6-feedback` added; the `rc4*` profiles are unchanged and
  fail closed against this source; `dev-lab` pins the administration off. The profile name rule
  accepts `rc<N>[-suffix]`.
- **Project formats**: schema v7 from the DEV line. Migrations v3 to v7 are the identity. A v3 reader
  opens a v7 document read-only, by name (`app/tests/rc6-alpha-formats.test.ts`).

## Release kit

The package now carries `records-cli.mjs`, the build-record tool a runtime rollback needs, beside the other service bundles. The capacity harness adds a bounded Runtime v5 mix; its default mix and every threshold are unchanged (`docs/ops/CAPACITY-ACCEPTANCE.md`).

## Out of scope

No ADC, no new components, no billing, no live AI provider, no robotics, no model building. The
Assist service stays disabled and has no provider.
