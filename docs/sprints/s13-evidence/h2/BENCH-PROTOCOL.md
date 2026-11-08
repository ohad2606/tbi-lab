# ESP32 pad drive and LEDC duty-0: bench measurement protocol (PM D-P1, option A)

**Purpose:**

1. Measure the source and sink characteristic of an ordinary GPIO and of a VDD_SDIO-domain GPIO (GPIO17) at the **default** drive strength (2), the strength Arduino sketches run at. This is P1.
2. Measure the output level for an LEDC duty of 0 (R4 open item O-R4-1).

No model parameter changes until these results are reviewed (PM).

## Safety rules (mandatory)

- **Never connect a GPIO directly to GND or to 3V3** (PM: no deliberate short). Every measurement goes through a resistor of **at least 150 Ω**.
- The resistor values below keep the pad current at or below about 20 mA for an ordinary GPIO, and at or below about 10 mA for GPIO17, **even with the strongest model**:
  - ordinary GPIO: 3.3 V / (150 + 16.5) Ω ≈ 19.8 mA;
  - GPIO17: 3.3 V / (330 + 16.5) Ω ≈ 9.5 mA.

  So no measurement is taken beyond the datasheet's characterized drive. This is *not* a statement that higher currents are safe: none are attempted.
- The board is powered from USB only. No external supply is connected to any pin.
- Change wiring only with USB unplugged. Re-check every connection before reconnecting.
- One pin and one resistor at a time. Every other pin is left unconnected.

## Equipment

- **Board:** one ESP32-DevKitC (WROOM-32). Record the module marking, the board revision and a photo.
- **Multimeter:** record its model and DC voltage accuracy. Ideally use two meters, or measure sequentially.
- **Resistors, ±1 %:** 150, 220, 330, 470, 1 kΩ and 10 kΩ. **Measure each resistor's actual value with the meter first** and record it.
- **Optional, for step 4:** an oscilloscope or logic analyser. Without one, step 4 relies on DC levels only (see its limits).
- **Software:** Arduino core 3.3.12, the version the product pins. Record the exact sketch files.

## Procedure

**Before each series**, record:

- the ambient temperature;
- V(3V3) to GND with no load on any GPIO;
- that 3V3 value again after the series.

### 1. Source curve, ordinary GPIO (GPIO5) at default strength

```cpp
void setup() { pinMode(5, OUTPUT); digitalWrite(5, HIGH); }
void loop() {}
```

For R in 10 kΩ, 1 kΩ, 470, 330, 220, 150 Ω, connected from GPIO5 to GND:

- measure V(GPIO5) to GND;
- measure V(3V3) to GND.

Compute I = V(GPIO5) / R_measured.

### 2. Sink curve, GPIO5 at default strength

Same sketch with `digitalWrite(5, LOW)`.

For R in 10 kΩ, 1 kΩ, 470, 330, 220, 150 Ω, connected from **3V3** to GPIO5:

- measure V(GPIO5) to GND;
- measure V(3V3) to GND.

Compute I = (V(3V3) − V(GPIO5)) / R_measured.

### 3. GPIO17 (VDD_SDIO domain): repeat steps 1 and 2 on GPIO17

Use only R in 10 kΩ, 1 kΩ, 470, 330 Ω (minimum 330 Ω).

### 4. LEDC duty 0 (R4 O-R4-1), GPIO2, with GPIO2 → 10 kΩ → GND

Run each sketch, and for each record V(GPIO2) DC. Where a scope is available, also record any pulses, with time scale and trigger:

- **4a.** `analogWrite(2, 0);` once, then hold.
- **4b.** `ledcAttach(2, 5000, 12); ledcWrite(2, 0);` then hold.
- **4c.** `ledcAttach(2, 5000, 12); ledcWrite(2, 2048); delay(1000); ledcWrite(2, 0);` then hold. Duty 0 reached from a non-zero duty.
- **4d.** As 4c, with `ledcWrite(2, 4096)` (100 %) before the 0.

## Results template (one row per measurement)

| Pin | Mode | R nominal | R measured | V(pin) | V(3V3) | I computed | T ambient |
|---|---|---|---|---|---|---|---|

For step 4, record per row: sketch, V(GPIO2) DC, scope observation (pulses yes/no, width, period) or "no scope".

## Analysis

**Drive model:**

- For each pin and mode, fit the Thévenin chord R_out = (V(3V3) − V(pin)) / I for HIGH, and V(pin) / I for LOW.
- Report every point and the spread over the loads. The spread is the stated non-linearity.
- Compare with:
  - today's model: 16.5 Ω / 17.7 Ω (strength 3);
  - the unvalidated inference: 33 Ω / 35.4 Ω (strength 2).

**Duty 0:** a DC level near 0 V with no pulses (scope) supports "constant low". With a DMM only, "constant low" is supported for the **average** level, not for the absence of short glitches.

## Limits of extrapolating from one development board (to be stated with any model change)

1. **One sample.** Chip process variation, the board's regulator and the module are not characterized. The datasheet's values are typical, not guaranteed.
2. **Temperature.** One ambient temperature only. Drive strength varies with temperature.
3. **Supply.** The 3V3 rail of a USB-powered DevKitC sags under load. The chord is computed against the measured rail, and other supplies are not covered.
4. **Range.** The fit is valid only between the measured loads, at most about 20 mA (about 10 mA on GPIO17). Beyond the last measured point the model remains an extrapolation. P2's "outside the characterized region" boundary would be re-defined at the **measured** limit, never widened by inference.
5. **Instrument.** The meter's accuracy bounds each point. Report it with the results.
6. **Other pins and strengths.** Strengths 0, 1 and 3, and the RTC-domain pins, are not measured. P4 keeps refusing explicit strength selection.
7. **Duty 0 without a scope** cannot exclude sub-microsecond glitches.

## After the measurement

Engineering proposes the model change with this data, the fit, the uncertainty and the impact, as a PM decision. The deterministic re-baseline of pinned fingerprints follows only after the PM accepts the corrected model (about 2 days).
