# Gate C — MCU <-> Electrical Bridge (and Phase 2/3 runtime work)

Feasibility experiment. **Not product code.**

## Verdict: PASS

Both directions proven on the **real classic-ESP32 runtime** with real firmware. No stand-in
runtime, no C3/S3 substitution.

```
npm run test:esp32     # 16 tests: 9 Phase 2 runtime, 7 Gate C integration
```

## Phase 2 — existing classic-ESP32 GPIO implementations, reproduced

Full survey: `docs/research/classic-esp32-gpio-implementations.md`.

Headline: `a159x36/qemu`, `lcgamboa/qemu` (PICSimLab) and `espressif/qemu` are **all on QEMU
9.2.2**, so moving code between them is a same-version change. The GPIO/IOMUX surface we
need is ~1,150 lines across three files; the rest of a159x36's +60k diff is board artwork.

Runtime used: **a159x36/qemu @ `esp-develop-9.2`, commit `03be9af0` (2026-07-07)**, built
from source on this ARM64 host. GPL-2.0.

### The five required capabilities, all proven

| | Requirement | Evidence |
|---|---|---|
| A | firmware configures a normal output GPIO and toggles it | `machine.Pin(2, Pin.OUT).value(1/0)` on GPIO2, GPIO18, GPIO19 |
| B | host observes those transitions externally | `O <pin> <level>` events over the bridge socket |
| C | firmware configures a normal input GPIO | `machine.Pin(5, Pin.IN)`, `machine.Pin(35, Pin.IN)` |
| D | host injects low/high states | `I <pin> <level>` over the bridge socket |
| E | firmware observes those states correctly | `p5.value()` / `p35.value()` return the injected level |

Pins deliberately span **both register banks** so a bank/indexing bug could not hide:
GPIO2/18/19 and GPIO5 use `GPIO_OUT`/`GPIO_IN`; GPIO33 uses `GPIO_OUT1` and GPIO35 uses
`GPIO_IN1`. Both the ordinary driver API and direct `GPIO_OUT_W1TS` register writes were
exercised.

### A real electrical defect, found and fixed

The brief warned against "a visually convenient but electrically incorrect abstraction".
A fidelity test looked for exactly that, and found one.

On real hardware a pad drives the net **only when its output enable is set**. The upstream
a159x36 model emitted a drive event on any `GPIO_OUT` change with no `gpio_enable` term, and
its `W1TS`/`W1TC` paths forced `GPIO_IN` regardless of direction. Measured before the fix:

```
output-enable gating: writing GPIO_OUT_W1TS on a non-output pin DID produce a drive event
  (NOT TRM-correct: pad drives while configured as input)
```

For TBI Lab this is not cosmetic: a pin configured as an input would have appeared to drive
the simulated network, injecting a phantom source and producing wrong voltages and currents.

`qemu-patch/gpio-enable-gating.patch` (**38 lines changed in `esp32_gpio.c`, 4 in its
header**) gates drive events on `GPIO_ENABLE`, masks the `GPIO_IN` mirror with the enable,
and adds `esp32_gpios_dir` lines so a consumer learns when a pad goes high impedance. The
same test afterwards:

```
output-enable gating: writing GPIO_OUT_W1TS on a non-output pin did NOT produce a drive event
  (TRM-correct)
```

Register-map fidelity was checked separately: all 20 offsets match ESP-IDF's authoritative
`soc/gpio_reg.h` exactly.

## Phase 3 — QEMU GPIO direction chosen

**Decision: Preference B for Sprint 0** — use the existing GPIO-capable fork as the
feasibility runtime, plus our 42-line correctness patch — **with Preference A recommended
for production.**

Reasoning, stated plainly:

- Preference A (port onto a maintained Espressif baseline) is the right *production* shape
  and is cheap in principle: identical QEMU 9.2.2 base, ~1,150 lines across three files.
- But Phase 5 asks whether classic ESP32 can run **in the browser**, and any browser build
  needs a **wasm-capable QEMU (10.1+)**, not 9.2.2. Porting GPIO onto a 9.2.2 Espressif
  baseline now could be work thrown away if the baseline has to move anyway. Doing it first
  would add risk without proving anything Gate C does not already prove.
- Preference C (write it ourselves) is unjustifiable: working, TRM-faithful implementations
  exist under a compatible licence.

**Maintenance burden if Preference A is taken:** one carried patch (~1,150 lines) against a
GPLv2 fork that Espressif rebases periodically, plus our 42-line correctness fix and the
192-line bridge device. The correctness fix is worth offering upstream to a159x36/lcgamboa.

## Phase 4 — Gate C bridge

### Architecture

```
real ESP32 firmware
  -> emulated GPIO controller (QEMU)
  -> tbi-gpio-bridge device  (qemu-patch/tbi_gpio_bridge.c, 192 lines, GPL-2.0)
  -> chardev socket
  -> QemuGpioLink (src/qemuLink.ts)
  -> McuElectricalBridge (src/bridge.ts)
  -> GpioPin electrical model (src/pinModel.ts)
  -> Gate A MNA solver
```

and symmetrically back. The bridge device holds **no board- or test-specific knowledge**: it
discovers the GPIO controller by QOM type and forwards whatever happens. The host bridge is
driven purely by the pin map and solver state.

### The pin is modelled electrically, not as an ideal rail

Every constant is derived from **ESP32 Series Datasheet v5.3, Table 5-3**, with the
arithmetic shown in `src/pinModel.ts`:

| Quantity | Datasheet | Model |
|---|---|---|
| Output HIGH | V_OH >= 2.64 V at I_OH = 40 mA | Thevenin: 3.3 V behind **16.5 ohm** = (3.3 - 2.64)/0.040 |
| Output LOW | V_OL = 0.495 V at I_OL = 28 mA | Thevenin: 0 V behind **17.679 ohm** = 0.495/0.028 |
| Input HIGH | V_IH = 0.75 x VDD | **2.475 V** |
| Input LOW | V_IL = 0.25 x VDD | **0.825 V** |
| Input leakage | <= 50 nA | 1.515e-8 S to ground |
| Internal pull | 45 kOhm typ | 45 kOhm |

Tests assert the model *reproduces the datasheet's own guarantees*: loading a driven-high pin
with 66 ohm yields exactly 2.64 V at 40 mA, and sinking 28 mA yields exactly 0.495 V.

**Documented approximations:** these are maximum-drive-strength, worst-case guarantees, so a
real driver is stronger than the model; ESP-IDF's default drive strength is one step lower,
which would be weaker. Drive-strength selection is not modelled (backlog). The linear
resistance is an approximation of a MOSFET driver, valid near the datasheet operating points.

**Digital input threshold semantics:** at or above V_IH reads 1; at or below V_IL reads 0;
**between them the datasheet guarantees nothing, so the model holds the previous level.**
That hold is deliberate documented behaviour, not an accident, and it is asserted by a test.

### The six required integration cases

| # | Case | Result |
|---|---|---|
| 1 | firmware drives HIGH into resistor + LED | V(io2) = **3.205059 V**, I = **5.753982 mA**, V(LED) = 1.939183 V |
| 2 | firmware drives LOW | V(io2) = 0 V, I = 0 A |
| 3 | external circuit below V_IL | V(io5) = **0.299995 V** -> firmware reads **LOW** |
| 4 | external circuit above V_IH | V(io5) = **3.299950 V** -> firmware reads **HIGH** |
| 5 | electrical state changed while firmware runs | firmware follows HIGH -> LOW -> HIGH |
| 6 | firmware changes output while running | 220 ohm -> **5.7540 mA**; 1 kohm -> **1.4064 mA** |

Case 1's pin voltage is *not* 3.3 V: it sags to 3.205 V because 5.754 mA through the
datasheet-derived 16.5 ohm driver resistance drops 0.095 V. That is the model doing its job.

**Nothing is hardcoded.** Expected values come from an independent bisection solve of the
same physical equation, sharing no code path with the MNA solver; agreement is asserted to
1e-6 relative. Case 6 changes a component value the firmware knows nothing about and the
result tracks it, which a replayed or precomputed answer could not do.

### Timing and synchronisation

| Path | Measured |
|---|---|
| firmware register write -> host observes the event | **< 1 ms** |
| electrical change -> solve + push level into the MCU | **3 ms** |

Semantics are **event-driven and deterministic**, not real-time: a GPIO write synchronously
updates the pin model and triggers a fresh DC solve; a solver change pushes a level only
when the interpreted digital level actually changes. Sprint 0 makes no real-time claim. The
fixed sleeps in the tests are harness settle time and are excluded from the figures above.

## Known limitations

- The external interface exposes 32 output lines (bank 0). GPIO32-39 outputs are not
  reported as events; GPIO33 was verified through `GPIO_OUT1` register reads instead.
- DC operating points only: no timing, no propagation delay, no edge shape, no capacitance.
- Drive-strength selection, open-drain mode and internal pull configuration are not driven
  from firmware register state; pull resistors exist in the model but are set by the host.
- `IOMUX`, `RTCIO`, `analog`, `APB` and `I2S` remain unimplemented in the runtime.
