# Sprint 13 DEV deployment: `dc1bff8` on dev-lab (2026-10-12)

**PM authorization:** "GO for DEV deployment of dc1bff8 — DEV-LAB ONLY".

Not done, and not authorized: production, merge, tag, infrastructure, runtime or firmware-lock change, schema, security or policy change. **No rollback was needed.**

## Final DEV state

| Item | Value | Verified by |
|---|---|---|
| Session Host / build service | **`dc1bff8c3f1480fd4063e1e77a2c3234b0592e6c`**, 0.10-dev | `/health` |
| Service bundles | `/srv/tbi-lab/services/dc1bff8…/` (root, 0644; `MANIFEST.json`): session-host `288c2ddc…`, build-service `04052fe3…`, build-job `011f703c…` | **byte-identical to the approved package** and to the staging-validated bundles |
| Frontend | `/srv/tbi-lab/dev-lab/dc1bff8…/`, built by `publish-frontend.sh` from a clean worktree of R with the package's `TBI_BUILD_TIME` | **byte-identical to the approved package (22 files)**; `/version.json` = R, `dev-lab`, not dirty; the gate serves it byte for byte |
| Runtime | v2 `b5b34b49cb7e4049`, unchanged (`tbi-qemu@` bind and `/etc/tbi/runtime.json`) | |
| Release artifact set | `767d3715fdaaef10` = R's lock; 13 images self-verified | |
| Units, polkit rule, `/etc/tbi` (keys, policy) | **Byte-equal to the pre-deploy backup**: no unit, policy, key or security change | `cmp` |
| Service users | `tbi-build`, `tbi-runtime` (sandbox users) | `ps` |
| Leftovers | No session, QEMU unit or process, build job, or relay | |

## Steps

| # | Step | Result |
|---|---|---|
| 1 | Baseline | **PASS**: host and frontend `ba0f4a6`, Runtime v2, idle |
| 2 | Backup | **PASS**: `/var/backups/tbi-lab/pre-s13-dev-20261012T213407Z`: 4 units, polkit rule, `/etc/tbi`, both release-link targets. 11 files verified byte-equal (`backup-hashes.txt`). Both previous release directories stay on disk. Rollback: `tools/rollback-s13-dev.sh` (prepared before the deployment; frontend first) |
| 3 | Artifact verification | **PASS**: the staging bundles equal the package; the artifact set equals R's lock |
| 4 | Backend | **PASS**: new release directory from byte copies of the staging-validated bundles; `services/current` switched; both services restarted together, healthy in 1.1 s |
| 5 | Host checks | **PASS**: `/health` = R; sandbox users; deployed suites on dev-lab (`TBI_S8_INSTANCE=tbi`, restart and stop cases excluded per the runbook): **21 passed**, 5 skipped (3 excluded + 2 standard): s11-deployed, s8-qemu-tasks, s8-deployed-policy, s8-containment, all with real QEMU sessions |
| 6 | Frontend | **PASS**: `publish-frontend.sh dc1bff8…`, all its checks (build identity, assets, gate origin byte for byte, public site up and gated) |
| 7 | Live acceptance through the gate's internal origin (bounded relay, stopped by PID) | **PASS**. Gate C regression `live-s12.mjs`: **47/47**. Sprint 13 `tools/live-s13.ts`: **38/38** in one clean run (`live-s13-final.txt`) |
| 8 | Compatibility and hashes | **PASS**: frontend and host on the same commit R; every deployed byte equals the package |
| 9 | Clean-up | **PASS**: nothing left |

**Live acceptance, first run (32/35), recorded in `live-s13-first-run.txt`.** All three failures were in my test, not the product.

1. **OS-08 "no build" / "building": a warm build cache.** The Gate C regression had just built the example's exact source, so the build-service lookup legitimately recovered that build: Run available at once, and a near-instant rebuild. With a unique source edit, all OS-08 checks pass on the real build service.
2. **P2/P3: an invalid project id in the test document** (`prj_live_<n>`; ids must match `^prj_[A-Za-z0-9]+$`). The product correctly refused the import ("cannot accept… nothing was imported"). With a valid id, it passes.

## OS-01 … OS-10, P2–P4 on DEV (deployed stack, real build service and QEMU)

| Item | Live result |
|---|---|
| OS-01 | `4k7` entered → 4.7 kΩ on the part |
| OS-02 | 3D first frame reached, 1.7 s on this host's software renderer (reduced tier). **GPU timing is the owner's to measure** (target ≤ 2 s) |
| OS-03 | Slider dragged during a live ESP32 session; session never refused or failed |
| OS-04 | Drop onto a part refused with the reason |
| OS-05 | Not exercised live (frontend routing, identical bytes verified in CI) |
| OS-06 | Plain metres; exact 5 mm steps to 0.10 m; the alarm LED lights on real QEMU |
| OS-07 | PIR inspector, 0 px overflow, EN and HE |
| OS-08 | Run unavailable without a build and during the build; available when built; unavailable again after an edit |
| OS-09 | Swapped VCC/SDA: miswiring named (GPIO21, SDA, VCC), SDA absolute-maximum row |
| OS-10 | Armed tile pressed, check mark, fill distinct from resting and hover, invalid preview over a part, Escape disarms; EN and HE |
| P2/P3 | Pin short: named, "current not known", no value |
| P4 | Build lists `drive_strength`; Run refused naming it |

**Staging and production unchanged.**

- Staging: bundles, `/etc/tbi-s8`, units and `/health` (R) are identical before and after (`staging-diff.txt` is empty).
- Production gate: Caddy and oauth2-proxy have the same PIDs and configuration; the dev-lab snapshot diff shows only the intended release switch.

**Owner retest:** `docs/alpha/OWNER-RETEST-S13.md` on dev-lab (`https://dev-lab.tbi-tech.net`, version shown bottom right: `dc1bff8`). Owner acceptance stays OPEN until then.
