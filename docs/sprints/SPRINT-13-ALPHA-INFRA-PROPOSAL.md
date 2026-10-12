# Sprint 13 — Alpha infrastructure proposal (for owner approval; nothing provisioned)

PM decision 2026-10-12: a dedicated Oracle A1.Flex alpha VM is the preferred architecture, with
6 OCPU / 16 GB as the initial **benchmark** target (compared against 4 OCPU / 16 GB). **No
purchase, resize or migration is authorized**; this is the approval package.

## 1. Facts: verified vs. owner-to-verify

| Item | Value | Source |
|---|---|---|
| Current VM | `VM.Standard.A1.Flex`, **1 OCPU, 4 GB**, il-jerusalem-1, AD-1, fault domain 2, boot volume 100 GB; hosts dev-lab, staging and builds | instance metadata (read-only), `lsblk` |
| A1 price | $0.01 per OCPU-hour, $0.0015 per GB-hour (≈ $7.30 per OCPU-month, ≈ $1.10 per GB-month at 730 h) | Oracle A1 pricing / Arm compute pages |
| A1 free allowance | **Conflicting:** the Always Free documentation says 1,500 OCPU-h / 9,000 GB-h a month (2 OCPU / 12 GB); the A1 pricing page says 3,000 / 18,000 (4 OCPU / 24 GB). **Owner to read the tenancy's actual value** | Oracle docs vs pricing page |
| The allowance is **per tenancy, shared by all A1 instances in the home region**; the current VM already uses 1 OCPU / 4 GB of it | — | Oracle docs ("all tenancies get…", home region) |
| Block storage | 200 GB free per tenancy (boot + block combined, home region), 5 backups; beyond: $0.0255 per GB-month + performance units (balanced ≈ $0.017 per GB-month) | Oracle docs / block volume pricing |
| Outbound data | 10 TB a month free | Oracle docs |
| Account type, A1 core quota / service limit in il-jerusalem-1, current A1 usage, host capacity ("out of host capacity" risk) | **Owner (console, read-only)**; this VM has no OCI CLI or API key and none will be created | — |

## 2. Measured basis (current host, Runtime v2, paced, ratified rule)

| Measurement | Result |
|---|---|
| CPU per paced session | sonar 0.41, DHT22 0.38, GPIO 0.35, LCD 0.34 of one core; QEMU RSS 77–85 MB |
| One session | 5 s p5 0.998–0.9997, tick-gap p99 2–4 ms: **PASS** |
| Two sessions on 1 core | fail (p5 0.87 / 0.94); CPU saturates at 2–3 sessions |
| Real build | ≈ 30–37 s compile, ≈ 0.7 GB peak; 4 simultaneous builds on 1 core: worst user 129–135 s (fails the 120 s target) |
| Builds in parallel | 2 workers produce **bit-identical** images to serial builds |
| Faults | Stop → runtime gone; QEMU SIGKILL → `runtime_crashed` reported in 0.2 s, runtime gone; no leftovers |

These are 1-core facts. **Five-session acceptance is not claimed from them** (PM: no extrapolation).
The projection (≈ 0.41 core per session + 0.8 core per build worker ⇒ 5 sessions + 2 builds ≈
3.8 cores) only sizes the benchmark host.

## 3. Proposal: dedicated alpha VM

| Item | Proposal |
|---|---|
| Shape | `VM.Standard.A1.Flex`, **6 OCPU / 16 GB** for the benchmark; re-measured at **4 OCPU / 16 GB** (a shape change on an idle alpha VM before any tester uses it). Keep the smaller one that passes all of §5 with margin |
| Image | Ubuntu 26.04 LTS (as today), home region il-jerusalem-1, same VCN, its own public IP |
| Boot volume | 60 GB (toolchain ≈ 7.7 GB, runtime ≈ 9 GB incl. sources, release set, logs) → tenancy total 160 GB ≤ 200 GB free |
| Software | the **exact** Gate B/C release: commit `ba0f4a6` (+ the H5 build-worker change once gated), Runtime v2 `b5b34b49cb7e4049` copied byte-for-byte and hash-verified (no rebuild), release set `767d3715fdaaef10`; `install.sh` (dev-lab target) with `TBI_S8_POLICY=policy.alpha.json` (queue 10, 2–3 build workers per benchmark) |
| Current VM | unchanged (1/4): dev-lab and staging stay as they are (PM: no DEV upgrade for concurrency) |

### Monthly cost (730 h; compute dominates)

| Configuration | Allowance 4 OCPU / 24 GB | Allowance 2 OCPU / 12 GB |
|---|---|---|
| Alpha 6/16 + current 1/4 (tenancy 7/20) | **≈ $21.90** (3 OCPU over) | **≈ $45.30** (5 OCPU + 8 GB over) |
| Alpha 4/16 + current 1/4 (tenancy 5/20) | ≈ $7.30 | ≈ $30.70 |
| Block storage (160 GB total) | $0 (≤ 200 GB) | $0 |
| Outbound data (≪ 10 TB) | $0 | $0 |
| **Maximum** (6/16, worst allowance, 744 h month, incl. a ≤ 40 GB block overrun) | | **≈ $48** |

**Requested ceiling: $50 per month** while the alpha VM runs. A **stopped** A1 instance does not
bill OCPU or memory; only its boot volume counts, and that stays inside the free 200 GB.

## 4. Deployment, DNS, OAuth, security, backup

| Area | Plan |
|---|---|
| Deployment | Provision (owner or with owner approval) → OS hardening (unattended security updates, SSH keys only, no password login) → users and groups as `install.sh` → copy and verify the runtime, toolchain and release set → `install.sh dev-lab` with the alpha policy → health checks → the Gate B suite subset on the new host → C-5 acceptance (§5) → alpha Gate C. About 1–2 days of engineering after the VM exists |
| Gate | The same model as dev-lab: Caddy (TLS, automatic certificates) → oauth2-proxy (Google, email allowlist) → internal origin; no other port open (security list / iptables 80/443, SSH restricted) |
| DNS | A record `alpha.tbi-tech.net` → the alpha VM's public IP (owner, DNS provider) |
| OAuth | Add `https://alpha.tbi-tech.net/oauth2/callback` to the Google OAuth client's redirect URIs (owner); allowlist = the five testers + owner |
| Secrets | New oauth2-proxy cookie secret on the alpha host; the client secret copied over SSH, never committed; per-instance identity and ticket keys generated by `install.sh` (never copied from dev-lab) |
| Isolation | Separate VM: dev-lab or staging tests cannot perturb alpha pacing; separate artifact store, keys and policy |
| Backup | Server state (`/etc/tbi`, units, policy, release links, artifact store manifests) archived after install and before every change (`/var/backups/tbi-lab/…`) and copied to the dev VM; the boot volume can use one of the 5 free backups before go-live. Tester projects: local-first, export/import verified (`s13-export-real.spec.ts`) |
| Monitoring | `/health`, journal, disk/memory checks in the H6 runbook; no new paid monitoring |

## 5. Capacity acceptance on the alpha VM (before any tester)

C-5 harness (`a3c8554`), ratified rule (p5 ≥ 0.995× over 5 s windows), tick-gap p99 ≤ 100 ms:
1. N = 1…6, mixed R1/R2/R3, 150 s, 3 repeats.
2. N = 5 + 5 simultaneous builds (`TBI_C5_BUILDS=5`, 2 and 3 workers): all succeed, none refused, worst user ≤ 120 s.
3. N = 5 + faults (`TBI_C5_FAULTS=1`): cleanup, others unaffected.
4. Soak: N = 5, 2 h, build burst every 10 min.
5. Deployed suites under load: s8-deployed-policy (alpha policy), s8-containment (non-restart), s11-deployed, real-browser EN/HE journey with 5 concurrent users.

All with the host configuration recorded. Then both 6 and 4 OCPU; the decision table goes to the PM
by **5 Nov**.

## 6. Rollback and shutdown

| Case | Action | Effect |
|---|---|---|
| Benchmark fails at 6 OCPU | Stop the VM (no compute charges); report; fallback 30 Nov or a larger shape (new approval) | Dev-lab untouched |
| 4 OCPU passes | Shape change to 4/16 (≈ 5 min restart, idle VM) | Lower cost |
| Alpha incident | The runbook rollbacks (runtime / frontend / full) on the alpha VM, as on dev-lab | Same scripts |
| End of alpha | Export nothing server-side (projects are local); archive logs and evidence; **terminate** the instance and its boot volume (owner) | Cost returns to the current VM only |
| Abort before alpha | Terminate; DNS record and OAuth redirect removed | No residue |

## 7. Owner decisions requested

1. Console facts: account type, A1 allowance shown, A1 core limit and availability in il-jerusalem-1, current usage, block storage used.
2. Approve: dedicated alpha VM 6/16 for benchmarking, the $50 per month ceiling, and Pay As You Go if the account is Always-Free-only.
3. DNS name and OAuth redirect URI.
4. Who provisions the VM (owner in the console, or engineering with a temporary, scoped approval).
