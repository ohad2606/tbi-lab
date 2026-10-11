/*
 * G-2 round 3 diagnostic firmware (F-R2-1), not a product artifact.
 * TbiEdgeTime's masked-interrupt capture, run in a task pinned to core 0 (the Arduino loop task on
 * core 1 sleeps), to locate the other core's frozen interval. Yields one tick after each capture.
 */
#include "esp_cpu.h"
#include "soc/gpio_reg.h"
#include "soc/soc.h"

const int PIN = 4;
const int MAX_EDGES = 64;
const uint32_t HZ = 240000000u;

static inline uint32_t level() { return (REG_READ(GPIO_IN_REG) >> PIN) & 1u; }

static void capture() {
  static uint32_t t[MAX_EDGES];
  static uint8_t v[MAX_EDGES];
  int n = 0;
  portDISABLE_INTERRUPTS();
  uint32_t last = level();
  uint32_t wait0 = esp_cpu_get_cycle_count();
  for (;;) {
    uint32_t now = level();
    uint32_t c = esp_cpu_get_cycle_count();
    if (now != last) {
      t[0] = c;
      v[0] = now;
      last = now;
      n = 1;
      break;
    }
    if (c - wait0 > HZ / 5) break;
  }
  if (n == 1) {
    for (;;) {
      uint32_t now = level();
      uint32_t c = esp_cpu_get_cycle_count();
      if (now != last) {
        t[n] = c;
        v[n] = now;
        last = now;
        if (++n == MAX_EDGES) break;
      }
      if (c - t[0] > HZ / 10) break;
    }
  }
  portENABLE_INTERRUPTS();
  if (n == 0) {
    vTaskDelay(1);
    return;
  }
  Serial.printf("C %d\n", n);
  for (int i = 0; i < n; i++) Serial.printf("e %d %lu\n", v[i], (unsigned long)(t[i] - t[0]));
  vTaskDelay(1);
}

static void task(void *) {
  Serial.printf("TBI-EDGETIME-READY core %d\n", xPortGetCoreID());
  for (;;) capture();
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN, INPUT);
  xTaskCreatePinnedToCore(task, "edgetime", 4096, NULL, 1, NULL, 0);
}

void loop() {
  vTaskDelay(portMAX_DELAY);
}
