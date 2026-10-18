# O-R4-1 bench result sheet (LEDC duty 0)

To be filled in **on the bench** by the owner. Procedure: `../BENCH-PROTOCOL.md` §4 (safety rules
first). Until this sheet holds a real measurement, O-R4-1 stays **open** and the simulator keeps
refusing duty 0 when a load can tell (D6).

## Setup

1. ESP32 DevKitC (Classic ESP32; record the module marking): GPIO2 → 10 kΩ → GND. Nothing else on GPIO2
   (the on-board LED of some DevKits sits on GPIO2: note whether this board has one).
2. Flash `TbiBenchDuty0/TbiBenchDuty0.ino` (board "ESP32 Dev Module", FQBN `esp32:esp32:esp32`).
   It compiles on DEV with the project's pinned toolchain (arduino-cli 1.5.1, esp32 core 3.3.12;
   278 127 bytes). No image is committed: record the sha256 of the image actually flashed.
3. Open the serial monitor at 115200, then **power-cycle** the board: steps 4a → 4d run in order,
   each from a clean reset, each holding duty 0 for 30 s after `STEP <id> HOLD`.
4. During each hold: meter V(GPIO2) DC to GND; with a scope (or logic analyser ≥ 10 MS/s) on GPIO2,
   normal trigger on a rising edge above 0.5 V, 1 µs/div then 100 µs/div, for the whole hold.

## Record

| Field | Value |
|---|---|
| Date, operator | |
| Board / module marking | |
| On-board LED on GPIO2 (yes/no) | |
| Meter (model, range, accuracy) | |
| Scope / logic analyser (model, sample rate) or "none" | |
| V(3V3) | |
| Image flashed: toolchain versions and sha256 | |

| Step | V(GPIO2) DC | Pulses seen (yes/no) | Width / period (if any) | Trigger settings | Notes |
|---|---|---|---|---|---|
| 4a `analogWrite(2, 0)` | | | | | |
| 4b `ledcAttach` + `ledcWrite(0)` | | | | | |
| 4c 50 % → 0 | | | | | |
| 4d 100 % → 0 | | | | | |

Attach the serial log (`STEP … START/HOLD/END`) and any scope captures.

## Reading the result (SPRINT-15-R4.md §9)

- **All four steps constant low**, no pulses on a scope: supports "duty 0 = static low"; engineering
  proposes the one-line `zero` rule change in `pwm.ts` with this sheet as evidence, as a PM decision,
  then re-runs T-R4-1/-5.
- **Constant low on a meter only (no scope):** supports the *average* only; sub-microsecond glitches
  are not excluded (protocol limit 7). PM decides whether that is enough.
- **Anything else** (a DC level above ~0, pulses, a step that differs): keep the refusal; record the
  measured behaviour in SPRINT-15-R4.md.
