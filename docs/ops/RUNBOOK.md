# TBI Lab — operations runbook (dev-lab, staging, alpha)

Sprint 13 H6. Every command here was used in Sprint 12 Gates B/C, unless marked *(new)*.
Instances:

| Instance | Units | Sockets | Release links |
|---|---|---|---|
| dev-lab / alpha | `tbi-build`, `tbi-session-host`, `tbi-build-job@`, `tbi-qemu@` | `/run/tbi-build/api.sock`, `/run/tbi-runtime/api.sock` | backend `/srv/tbi-lab/services/current`, frontend `/srv/tbi-lab/dev-lab/current` |
| staging | `tbi-s8-build`, `tbi-s8-session-host`, `tbi-s8-build-job@`, `tbi-s8-qemu@` | `/run/tbi-s8-build/…`, `/run/tbi-s8-runtime/…` | bundles in `/srv/tbi-lab/s8-staging` |

Gate (dev-lab / alpha): Caddy :443 → oauth2-proxy (Google, email allowlist) → internal origin.
Production does not exist; nothing here touches it.

## 1. Health and state

```bash
sudo curl -s --unix-socket /run/tbi-runtime/api.sock http://x/health      # protocol, live sessions, runtime.commit
sudo cat /srv/tbi-lab/dev-lab/current/version.json                          # frontend commit
readlink -f /srv/tbi-lab/services/current                                   # backend release
sudo sed -n 's|^BindReadOnlyPaths=\(.*\):/opt/tbi-runtime$|\1|p' /etc/systemd/system/tbi-qemu@.service   # QEMU runtime
sudo python3 -c "import json;print(json.load(open('/etc/tbi/runtime.json'))['runtimeId'])"
systemctl is-active tbi-build tbi-session-host caddy oauth2-proxy
systemctl list-units 'tbi-qemu@*' --no-legend                               # live sessions (QEMU units)
bash ~/tbi-s12-rel/devlab-snapshot.sh                                       # full read-only fingerprint
```

Resources:
```bash
free -m; df -h /; uptime
systemctl show -p MemoryCurrent tbi-session-host tbi-build
journalctl -u tbi-session-host -u tbi-build --since -1h --no-pager | tail -50
```
Limits enforced by policy (`/etc/tbi/policy.json`): sessions refuse below 256 MB available memory
or 1 GB free disk. Keep ≥ 5 GB disk free (a deploy needs scratch space; FU-11-2).

## 2. Deploy (only with the gate approvals)

Order: backend → runtime → frontend (an older frontend on a newer host is safe; the reverse
refuses new parts explicitly).

| Step | Command | Verify |
|---|---|---|
| Back up | `B=/var/backups/tbi-lab/pre-<what>-$(date -u +%Y%m%dT%H%M%SZ)`; copy the 4 units, `50-tbi.rules`, `/etc/tbi`, both release links (Gate C pattern) | hashes recorded |
| Backend | new `/srv/tbi-lab/services/<sha>/` with the **staging-validated** bundles + `MANIFEST.json`; switch `services/current`; `systemctl restart tbi-build tbi-session-host` together | `/health` commit = `<sha>` |
| Runtime | `deploy/dev-lab/s8/switch-runtime.sh dev-lab <runtime dir>` (refuses with a live session) | prints `OK … in <ms>`; `/etc/tbi/runtime.json` id |
| Frontend | `deploy/dev-lab/publish-frontend.sh <sha>` (verifies and auto-rolls back) | "dev-lab now serves <sha>" |
| Checks | deployed suites without service restarts: `TBI_S8_INSTANCE=tbi … s11-deployed s8-qemu-tasks s8-deployed-policy s8-containment -t '^(?!.*(stale runtime health\|a restarted build service\|a restarted Session Host)).*$'` | all pass |

Never on dev-lab or alpha: the s8 cases that stop or restart services; `install.sh dev-lab` on an
existing instance (it rewrites policy and gate files); `publish.sh`.

## 3. Rollback (three scopes)

| Scope | Command | Time |
|---|---|---|
| Runtime | `deploy/dev-lab/s8/switch-runtime.sh dev-lab /home/ubuntu/tbi-s8-rt/qemu-33e35e4ac5e798d7` (v1) or the previous dir printed by the last switch | ≈ 1 s |
| Frontend | `sudo ln -sfn /srv/tbi-lab/dev-lab/<prev> /srv/tbi-lab/dev-lab/current.tmp && sudo mv -T /srv/tbi-lab/dev-lab/current.tmp /srv/tbi-lab/dev-lab/current` | instant |
| Full (to the pre-deploy backup) | the deploy's `rollback-*.sh` (Gate C: `docs/sprints/s12-evidence/gate-c/tools/rollback-gatec.sh`): frontend first, units, `runtime.json`, services link, restart | < 1 min |

After any rollback: `/health`, `version.json`, one example Run (§5).

## 4. Restart and incidents

| Symptom | Action |
|---|---|
| Session Host unhealthy | `sudo systemctl restart tbi-session-host` (ends live sessions: they are ephemeral; users press Run again) |
| Builds stuck | `/health` of the build service; `systemctl list-units 'tbi-build-job@*'`; `sudo systemctl restart tbi-build` (stops its predecessor's sandboxed steps, removes their jobs) |
| A QEMU left running | `sudo systemctl stop tbi-qemu@<id>` (never `pkill -f`) |
| Disk low | `df -h /`; the artifact store sweeps by retention; remove old `/srv/tbi-lab/dev-lab/<sha>` releases only if they are not the current or the rollback target |
| Gate down | `systemctl status caddy oauth2-proxy`; restart only with owner approval (they serve all routes) |
| Testers report "simulator busy" | Expected above capacity (policy `maxLiveSessions`); check `/health` sessions |

## 5. Smoke after any change

The live acceptance script (Gate C), through a bounded relay to the gate:
```bash
NODE=$(command -v node); sudo -n timeout 1500 "$NODE" ~/tbi-s12-rel/relay.cjs 4656 /run/tbi-gate/internal.sock & r=$!
node .tmp/s12/live-s12.mjs http://127.0.0.1:4656/ <shots dir> <user prefix>
for c in $(pgrep -P $r); do sudo -n kill $c; done
```
(A copy of the script is kept in `docs/sprints/s12-evidence/gate-c/tools/live-s12.mjs`.)

## 6. Backup and restore

| Data | Where | Backup | Restore |
|---|---|---|---|
| Tester projects | the tester's browser (local-first) | **The user exports** (Projects → Export; the app menu → export the current project) `.tbilab` files | Import in any browser; verified end to end (`app/e2e/s13-export-real.spec.ts`) |
| Server state | `/etc/tbi` (keys, policy, `runtime.json`), units, polkit rule, release links | `/var/backups/tbi-lab/<name>-<UTC>/` before every change *(new: also nightly while the alpha runs, copied to the other VM)* | copy back and `daemon-reload` / restart (the rollback scripts) |
| Releases | `/srv/tbi-lab/services/<sha>`, `/srv/tbi-lab/dev-lab/<sha>`, `/srv/tbi-lab/release-artifacts/<lock id>` | immutable; kept | re-point links |
| Artifact store | `/var/lib/tbi-lab/artifacts` | rebuildable (builds are reproducible; reference images come from the release set) | `install.sh` imports the reference images; users rebuild |
| Runtime | `~/tbi-s12-rt-release/qemu-<id>`, `~/tbi-s8-rt/qemu-<id>` | never deleted while referenced | `switch-runtime.sh` |

**Restore rehearsal (H6 acceptance, staging):** back up `/etc/tbi-s8` and the units → delete the
copy's `runtime.json` and swap the policy → restore from the backup → `systemctl restart` → the
staging suites `s11-deployed`, `s8-qemu-tasks` pass *(to run)*.
