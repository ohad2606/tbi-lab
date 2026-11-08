/*
 * G-2 round 3 diagnostic firmware (F-R2-2 anomaly), not a product artifact.
 * The TbiHcSr04Trace trigger sequence with the cycle counter read around each write:
 *   "W <k> <c0> <c1> <c2> <c3> <c4>"  c0 before HIGH, c1 after HIGH, c2 after delayMicroseconds(10),
 *   c3 after LOW, c4 after a second read; all relative to c0. Iterations as TbiHcSr04Trace.
 */
#include "esp_cpu.h"

const int TRIG = 5;

void setup() {
  Serial.begin(115200);
  pinMode(TRIG, OUTPUT);
  digitalWrite(TRIG, LOW);
  Serial.println("TBI-TRIGCLOCK-READY");
}

void loop() {
  static uint32_t k = 0;
  uint32_t c0 = esp_cpu_get_cycle_count();
  digitalWrite(TRIG, HIGH);
  uint32_t c1 = esp_cpu_get_cycle_count();
  delayMicroseconds(10);
  uint32_t c2 = esp_cpu_get_cycle_count();
  digitalWrite(TRIG, LOW);
  uint32_t c3 = esp_cpu_get_cycle_count();
  uint32_t c4 = esp_cpu_get_cycle_count();
  Serial.printf("W %lu %lu %lu %lu %lu\n", (unsigned long)k, (unsigned long)(c1 - c0),
                (unsigned long)(c2 - c0), (unsigned long)(c3 - c0), (unsigned long)(c4 - c0));
  delay(100);
  if (k & 1) delayMicroseconds((37 * k) % 1000);
  k++;
}
