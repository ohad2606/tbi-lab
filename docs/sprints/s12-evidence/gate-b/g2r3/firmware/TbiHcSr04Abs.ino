/*
 * G-2 round 3 diagnostic firmware (F-R2-2), not a product artifact.
 * TbiHcSr04's loop, with pulseIn's source (cores/esp32/wiring_pulse.c, arduino-esp32 3.3.12)
 * inlined so that the cycle counts at which it sees the echo rise and fall are recorded:
 *   "A <k> <us> <trigger-fall cycles> <rise cycles> <fall cycles>"  (absolute cycle counts)
 * Even k: delay(100) as TbiHcSr04 (tick-aligned start). Odd k: delay(100) plus
 * delayMicroseconds((37 k) mod 1000), which sweeps the trigger phase within the millisecond.
 */
#include "esp_cpu.h"

const int TRIG = 5;
const int ECHO = 18;
static uint32_t cRise, cFall;

#define WAIT_FOR_PIN_STATE(state)                                         \
  while (digitalRead(pin) != (state)) {                                   \
    if (esp_cpu_get_cycle_count() - start_cycle_count > timeout_cycles) { \
      return 0;                                                           \
    }                                                                     \
  }

static unsigned long pulseInTraced(uint8_t pin, uint8_t state, unsigned long timeout) {
  const uint32_t max_timeout_us = clockCyclesToMicroseconds(UINT_MAX);
  if (timeout > max_timeout_us) {
    timeout = max_timeout_us;
  }
  const uint32_t timeout_cycles = microsecondsToClockCycles(timeout);
  const uint32_t start_cycle_count = esp_cpu_get_cycle_count();
  WAIT_FOR_PIN_STATE(!state);
  WAIT_FOR_PIN_STATE(state);
  const uint32_t pulse_start_cycle_count = esp_cpu_get_cycle_count();
  WAIT_FOR_PIN_STATE(!state);
  const uint32_t end = esp_cpu_get_cycle_count();
  cRise = pulse_start_cycle_count;
  cFall = end;
  return clockCyclesToMicroseconds(end - pulse_start_cycle_count);
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
  digitalWrite(TRIG, LOW);
  Serial.println("TBI-HCSR04A-READY");
}

void loop() {
  static uint32_t k = 0;
  digitalWrite(TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  const uint32_t cTrig = esp_cpu_get_cycle_count();
  cRise = cFall = cTrig;
  unsigned long us = pulseInTraced(ECHO, HIGH, 30000);
  Serial.printf("A %lu %lu %lu %lu %lu\n", (unsigned long)k, us, (unsigned long)cTrig, (unsigned long)cRise,
                (unsigned long)cFall);
  delay(100);
  if (k & 1) delayMicroseconds((37 * k) % 1000);
  k++;
}
