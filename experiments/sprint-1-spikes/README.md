# Sprint 1 spikes — simulation time and determinism

Tiny executable spikes that answer one architectural question, which Sprint 0 left open: **can the
classic-ESP32 runtime give a deterministic simulation-time contract?** Findings:
`docs/research/sprint-1-simulation-time.md`. Decision: `docs/architecture/adr/ADR-007-simulation-time-contract.md`.

Not product code. Stdlib Python only; uses the runtime and firmware in `/home/ubuntu/tbi-tools/`
(outside git).

| File | What it measures |
|---|---|
| `time_determinism.py` | GPIO event virtual timestamps across runs in real-time and `-icount` modes, plus QEMU CPU and RSS |
| `repeat_check.py` | Repeats the icount modes and checks `delay()` spacing in virtual time |
| `lockstep_check.py` | Closed-loop determinism: host-injected responses in `sync` and `inline` modes. **This is the acceptance test for guarantee G2.** |
| `tbi_gpio_bridge.sprint1-spike.diff` | The opt-in bridge properties (`vclock`, `sync`, `inline`), all **off by default**; the Sprint 0 ESP32 suite passes 19/19 with them built in |
