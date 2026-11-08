# Alpha cohort acceptance: 7 authorized accounts, 6 simultaneous simulations (procedure)

Sprint 14 (PM-approved cohort, 2026-10-15). Supersedes the six-account procedure
(`SIX-ACCOUNT-ACCEPTANCE.md`, operator folder) and the earlier five-user one.
Host tbi-lab-prod-srv, `https://lab.tbi-tech.net`, release under test RC3 `802befe`.
**Status: not run.** This is a human-paced procedure: every sign-in is done by the account's own
person in their own browser. Engineering never signs in on anyone's behalf. Running it is not an
invitation of external testers; the owner/PM decides when testers are contacted.

## Configuration under test

| Item | Value | Source |
|---|---|---|
| Owner accounts | 1 (`owner`) | tester registry |
| External Alpha testers | 6 (`alpha_tester`, cohort `alpha_2026`) | tester registry, cap 6 (owner decision 2026-10-15, PM-approved) |
| Authorized accounts | 7 = exact-email allowlist entries | `/etc/oauth2-proxy/allowed-emails` |
| Unauthorized account | 1, in neither the allowlist nor the registry | for the rejection test |
| Simultaneous simulations | **6** host-wide (`TBI_HOST_MAX_SESSIONS=6` = policy `maxLiveSessions` "cpus" = 6) | unchanged |
| Per user | 1 live simulation; 30-minute lifetime | policy `f55d14d4`, unchanged |
| Builds | at most 2 active, queue 10; **deferred while 6 simulations are live** | policy, unchanged |

Seven authorized accounts but six simulation slots: when all six are taken, the seventh Run is
refused with `runtime_capacity` (HTTP 429, retry after 15 s). The user sees "The ESP32 runtime
service is busy. Try again in a moment. The project is not affected." (HE: "שירות הריצה של ESP32
עמוס כרגע. נסו שוב בעוד רגע. הפרויקט לא נפגע."). Nobody else's simulation is stopped or named.
No capacity, allowlist, registry or policy change is part of this procedure.

## People and roles

Numbering keeps the owner/tester distinction and hides addresses in all evidence:

- **O**: the owner (coordinator; performs the seventh admission attempt).
- **T1–T6**: the six external Alpha testers (registry `alpha_tester`). Which person is T1…T6 is
  decided by the owner and kept off the evidence; evidence names only O, T1–T6, X.
- **X**: the unauthorized account (any Google account not on the allowlist).
- **Operator**: runs the server commands below (read-only except the sampler it starts and stops).

## Prerequisites

1. Each of the 7 authorized people has their own Google account and browser profile (no shared
   cookies), desktop Chrome/Edge/Firefox, current version. X likewise.
2. If the Alpha OAuth consent screen is in **Testing** mode: all 7 authorized addresses are Google
   test users (owner, Google Cloud Console); X is **not** (Google may then refuse X before the
   gate: record which refusal was observed).
3. Host idle (no `tbi-qemu@` units), RC3 installed, gate checks pass, registry check passes.
4. A coordinator channel (call or chat) so steps start together; a clock visible to all.

## Operator, before the run

```
E=~/tbi-alpha-rel/evidence/cohort-acceptance-$(date -u +%Y%m%dT%H%MZ); mkdir -p $E
sudo python3 -I ~/tbi-alpha-rel/ops/tester-registry.py check > $E/registry-check-before.txt
#   must print: authorized: owner 1, alpha_tester 6/6, total 7; allowlist entries 7; mismatches 0
#   (counts only; addresses appear only on a mismatch and then stay in this root-read evidence)
~/tbi-alpha-rel/ops/gate-checks.sh > $E/gate-checks-before.log      # ALL MANDATORY CHECKS PASS
systemctl list-units 'tbi-qemu@*' --no-legend | wc -l                  # 0
~/tbi-alpha-rel/ops/backup-config.sh cohort-pre
setsid nohup sudo python3 -I ~/tbi-alpha-rel/ops/sample-host.py $E/host-samples.jsonl 5 \
  >$E/sampler.err 2>&1 </dev/null &
date -u +%FT%TZ > $E/T0
```

Fault alerts (Telegram, `tbi-alertd`) stay **unmuted**: step E is expected to produce one
🟠 "server full" warning, which also verifies the alert path. Any 🔴 alert during the run is a
finding.

## Steps

| Step | Who | Action | Expected |
|---|---|---|---|
| A1 | O, T1–T6 | Open `https://lab.tbi-tech.net/editor?x=1`, choose own Google account | back on `/editor?x=1` (not `/oauth2/callback`); TBI Lab logo; the app works |
| A2 | X | Same URL with the unauthorized account | gate 403 page (or Google's Testing-mode refusal, recorded as such); no app page, no asset, no API answer |
| B1 | T1–T6 | Each opens a different ESP32 example: Blink, Input echo, HC-SR04 distance alarm, DHT22 thermo-hygrometer, I2C LCD, night light | example opens; EN/HE switch works |
| B2 | O | Opens a seventh example (any) and presses **Build**; waits for success. **Before** the testers run: builds are deferred while 6 simulations are live | build succeeds |
| B3 | T1–T6 | Edit the sketch (a comment with own number: a real compile), press **Build** within the same 10 s | all six builds succeed, none refused; slowest ≤ 120 s (record each) |
| C1 | T1–T6 | **Run** | six simulations running at once (6/6); each behaves as its example describes |
| C2 | Operator | Count runtime units and admissions (commands below) | 6 `tbi-qemu@` units; 6 distinct principals admitted |
| D1 | O | Press **Run** (the seventh simultaneous admission attempt) | refused safely: the busy message above; no session for O; O's project unchanged |
| D2 | T1–T6 | Keep watching their running simulation during D1 | none stops, restarts or shows an error; serial output continues |
| D3 | Operator | Check the refusal | one `runtime_capacity` admission line for O's principal; still 6 units; Telegram 🟠 "server full" warning arrives within ~1 min |
| D4 | O | After ≥ 15 s, press **Run** again (still full) | refused again the same way (stable, no queueing, no partial session) |
| E1 | T1–T6 | Interact 10 minutes (buttons, sensor sliders, serial) | smooth pacing; no error banner |
| E2 | T2, T3 | Isolation: each sees only their own project, serial output and sensor values; T3 changes the DHT22 temperature, T2's session is unaffected | no cross-user data |
| F1 | T3 | **Close the tab** (disconnect, no Stop) | within ~30–40 s the session ends `lease_expired`; the others continue |
| F2 | Operator | Verify release (commands below) | 5 `tbi-qemu@` units; T3's session directory removed; no leftover process |
| F3 | O | Press **Run** | admitted (the freed slot): O's simulation runs; 6/6 again |
| F4 | T2 | **Stop**, then **Run** | Stop frees the slot at once; Run is admitted (fresh session) |
| G1 | T4 | Sign out (`/oauth2/sign_out`), then reload | Google account chooser; app only after sign-in |
| G2 | T5 | After signing out: two tabs signing in at once | both land in the app; still at most one simulation for T5 |
| G3 | T6 | Leave the simulation running to the 30-minute limit | one-minute notice, then "reached its maximum duration"; Run starts fresh; project intact |
| G4 | everyone | Stop; export the project (`.tbilab`), reload, compare | project unchanged |

A closed tab holds its slot until the lease expires (~30–40 s); a Run inside that window can be
refused as busy: record it, wait, retry once (the only permitted retry).

## Operator, during and after

```
# C2 / D3 / F2 — counts only, no identities beyond the 10-character principal prefix
systemctl list-units 'tbi-qemu@*' --no-legend | wc -l
sudo journalctl -u tbi-session-host --since "$(cat $E/T0)" -o short-iso | grep '"event":"admission"' > $E/admission.log
grep -c '"action":"session-create","outcome":"admitted"' $E/admission.log
grep '"outcome":"runtime_capacity"' $E/admission.log                      # D1/D4: O's prefix only
sudo ls /var/lib/tbi-runtime/sessions | wc -l                              # F2: one fewer directory
# after the run
sudo journalctl -u oauth2-proxy --since "$(cat $E/T0)" -o cat | grep -cE 'AuthSuccess'   # >= 7
sudo journalctl -u oauth2-proxy --since "$(cat $E/T0)" -o cat | grep -cE 'AuthFailure|403' # >= 1 (X)
sudo python3 -I ~/tbi-alpha-rel/ops/tester-registry.py sync-ids
sudo python3 -I ~/tbi-alpha-rel/ops/tester-registry.py check > $E/registry-check-after.txt   # 0 mismatches
~/tbi-alpha-rel/ops/gate-checks.sh > $E/gate-checks-after.log
# after everyone stopped: no tbi-qemu@ / tbi-build-job@ units, empty /var/lib/tbi-runtime/sessions
sudo kill <sampler pid>; python3 -I ~/tbi-alpha-rel/ops/analyze-samples.py $E
sudo python3 -I ~/tbi-alpha-rel/ops/tester-usage.py --since "$(cat $E/T0)" > $E/usage.txt   # masked
```

## Pass criteria

- O and T1–T6 sign in and return to their URL; X is refused with no application content.
- Six tester simulations run at once with no admission refusal; all six tester builds succeed,
  none refused, slowest ≤ 120 s.
- The seventh simultaneous attempt (O) is refused with `runtime_capacity` and the busy message,
  twice, with no effect on the six running simulations, no partial session and no leftover.
- A disconnected tester's slot is released by lease expiry (~30–40 s) with its directory and
  runtime process gone, and the freed slot admits the next Run; Stop frees a slot immediately.
- Isolation holds; no error banners; sign-out, two-tab sign-in, 30-minute limit and export behave
  as listed; gate checks pass before and after; no OAuth code/state/token/secret in logs.
- The registry records a Google account id for all 7 authorized accounts; 0 mismatches.
- Evidence: the directory above (counts, principal prefixes and O/T1–T6/X labels only) plus each
  person's short written confirmation. Any failure is recorded as found (time, person label,
  screenshot); nothing is retried silently except the single lease-window retry.

## Not covered here

Load beyond six simulations (refused by design), the capacity acceptance (`docs/ops/CAPACITY-ACCEPTANCE.md`
covers measured limits), and any change of the six-simulation limit: such a proposal needs a
measured failure from this run and owner cost approval.
