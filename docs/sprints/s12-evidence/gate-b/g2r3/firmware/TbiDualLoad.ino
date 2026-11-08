/*
 * G-2 round 3 diagnostic firmware (F-R2-1), not a product artifact.
 * Core 1 (Arduino loop) times a fixed busy loop with the cycle counter, interrupts masked:
 *   "L <phase> <cycles>"  phase 0: core 0 idle; phase 1: a busy task runs on core 0.
 * On silicon both cores run concurrently, so the cycles are the same in both phases.
 */
#include "esp_cpu.h"

static volatile uint32_t sink;
static volatile bool loadOn = false;

static uint32_t timed() {
  portDISABLE_INTERRUPTS();
  uint32_t c0 = esp_cpu_get_cycle_count();
  uint32_t x = 0;
  for (uint32_t i = 0; i < 20000; i++) x += i ^ (x >> 3);
  sink = x;
  uint32_t c1 = esp_cpu_get_cycle_count();
  portENABLE_INTERRUPTS();
  return c1 - c0;
}

static void load(void *) {
  for (;;) {
    if (!loadOn) {
      vTaskDelay(1);
      continue;
    }
    uint32_t x = 0;
    for (uint32_t i = 0; i < 100000; i++) x += i ^ (x >> 5);
    sink = x;
    vTaskDelay(1);  // let the idle task run (task watchdog)
  }
}

void setup() {
  Serial.begin(115200);
  xTaskCreatePinnedToCore(load, "load", 4096, NULL, 1, NULL, 0);
  Serial.println("TBI-DUALLOAD-READY");
}

void loop() {
  static int n = 0;
  if (n == 10) loadOn = true;
  if (n < 20) Serial.printf("L %d %lu\n", n >= 10, (unsigned long)timed());
  n++;
  delay(20);
}
