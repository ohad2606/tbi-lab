# R1: tone() and analogRead() stay refused (verified on built ELFs, 2026-10-08)

R1 enables the buzzer and the photoresistor in ESP32 projects as **digital** parts only. Two probe
sketches were built with the pinned toolchain (arduino-cli 1.5.1, arduino-esp32 3.3.12,
`esp32:esp32:esp32:FlashMode=dio`), their symbols listed exactly as the build service does
(`xtensa-esp32-elf-nm --defined-only --format=posix`), and passed to the build service's own
`analyzeFeatures()` (`runtime/builder/features.ts`). The probes are not part of the product.

| Probe | Source | Relevant linked symbols | `analyzeFeatures().unsupported` |
|---|---|---|---|
| ToneProbe | `tone(4, 2000, 100);` | `ledcAttach`, `ledcAttachChannel`, `ledcWrite`, `ledcWriteTone` | `["pwm"]` |
| AdcProbe | `analogRead(35);` | `__analogRead`, `adc_oneshot_read`, `analogRead` | `["adc"]` |

So a sketch using `tone()` (LEDC-based in arduino-esp32 3.3.12: `cores/esp32/Tone.cpp` calls
`ledcAttach` / `ledcAttachChannel` / `ledcWriteTone`) or `analogRead()` is refused at Run with
the feature named, exactly as before R1; the buzzer is on/off and the photoresistor a digital level.
