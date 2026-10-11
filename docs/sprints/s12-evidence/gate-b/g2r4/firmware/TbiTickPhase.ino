/*
 * G-2 targeted validation (F-R2-1 impact on delay()/vTaskDelay). Diagnostic firmware, not a
 * product artifact. Each core spins on its cycle counter for 3 ms and records every gap > 1 us
 * (time it did not execute): its own interrupt handlers and, under QEMU, the other core's run.
 * Done with interrupts enabled ("G <core> 1 ...") and masked ("G <core> 0 ..."):
 *   "G <core> <irqs on> <micros at gap end> <gap ns>"
 */
#include "esp_cpu.h"

struct Gap { uint32_t us, ns; };
static Gap gaps[2][2][64];
static int ng[2][2];

static void spin(int core, int irq) {
  if (!irq) portDISABLE_INTERRUPTS();
  uint32_t start = esp_cpu_get_cycle_count(), prev = start;
  while (prev - start < 3000u * 240u) {
    uint32_t c = esp_cpu_get_cycle_count();
    if (c - prev > 240 && ng[core][irq] < 64) {
      gaps[core][irq][ng[core][irq]++] = {micros(), (c - prev) * 25 / 6};
    }
    prev = c;
  }
  if (!irq) portENABLE_INTERRUPTS();
}

static volatile bool c0done = false;
static void core0(void *) {
  delay(5);
  spin(0, 1);
  delay(5);
  spin(0, 0);
  c0done = true;
  vTaskDelete(NULL);
}

void setup() {
  Serial.begin(115200);
  Serial.println("TBI-TICKPHASE-READY");
}

void loop() {
  delay(50);
  spin(1, 1);
  delay(5);
  spin(1, 0);
  xTaskCreatePinnedToCore(core0, "c0", 4096, NULL, 2, NULL, 0);
  while (!c0done) delay(1);
  for (int c = 0; c < 2; c++)
    for (int q = 1; q >= 0; q--)
      for (int i = 0; i < ng[c][q]; i++)
        Serial.printf("G %d %d %lu %lu\n", c, q, (unsigned long)gaps[c][q][i].us, (unsigned long)gaps[c][q][i].ns);
  Serial.println("DONE");
  for (;;) delay(1000);
}
