/*
 * G-2 targeted validation (F-R2-1 impact matrix, F-R2-2 pulseIn bounds). Diagnostic firmware, not
 * a product artifact. Arduino loop task (core 1). Sections start at fixed simulated times so the
 * bridge job can schedule inputs; results are buffered and printed at the end (no UART interrupt
 * during measurements). GPIO23 HIGH at setup: a busy task runs on core 0 (dual-core load variant).
 *   C   20 x: t = micros(); GPIO19 toggled        -> bridge frame time - t = micros() offset
 *   A0  pulseIn's WAIT_FOR_PIN_STATE body on a static pin for 2000 us, interrupts masked -> L
 *   A1  GPIO5: HIGH; delayMicroseconds(w); LOW, w = 2, 10, 50, 500 us, start phase in 7 us steps
 *   A2  GPIO19: 2000 half periods of delayMicroseconds(500) (software 1 kHz tone)
 *   A3  GPIO5: HIGH; delay(1); LOW, 200 x, start phase swept
 *   K   50 FreeRTOS tick changes seen by core 1: micros() at each
 *   A4  GPIO19 follows digitalRead(4) (polled; job pulses on GPIO4)
 *   A5  pulseIn(4, HIGH) x 300, interrupts enabled
 *   A6  pulseIn(4, HIGH) x 300, interrupts masked around each call
 *   A7  GPIO19 HIGH; t0 = micros(); busy loop; t1 = micros(); LOW, 100 x -> micros() vs bridge
 */
#include "esp_cpu.h"

const int OUT = 5, MARK = 19, IN = 4, LOAD = 23;
static volatile uint32_t sink;
static uint32_t cal[20], a0n, kt[50], p5[300], p6[300], u7[100];

static void load(void *) {
  for (;;) {
    uint32_t x = 0;
    for (uint32_t i = 0; i < 100000; i++) x += i ^ (x >> 5);
    sink = x;
    vTaskDelay(1);  // the idle task must run (task watchdog)
  }
}

static void waitUntil(uint32_t ms) {
  while (millis() < ms) delay(1);
}

static void atPhase(uint32_t us) {
  // 20 us window: a 2 us window can be skipped every millisecond by the other core's interval;
  // under core-0 load core 1 can be frozen for up to ~1 ms, so give up after 2 ms (the bridge
  // records the actual start time).
  uint32_t t0 = micros();
  while ((micros() - us) % 1000 >= 20 && micros() - t0 < 2000) {}
}

void setup() {
  Serial.begin(115200);
  pinMode(OUT, OUTPUT);
  pinMode(MARK, OUTPUT);
  digitalWrite(OUT, LOW);
  digitalWrite(MARK, LOW);
  pinMode(IN, INPUT);
  pinMode(LOAD, INPUT);
  bool loaded = digitalRead(LOAD);
  if (loaded) xTaskCreatePinnedToCore(load, "load", 4096, NULL, 1, NULL, 0);
  Serial.printf("TBI-APIMATRIX-READY load %d core %d\n", loaded, xPortGetCoreID());
}

void loop() {
  waitUntil(950);
  for (int i = 0; i < 20; i++) {
    cal[i] = micros();
    digitalWrite(MARK, (i & 1) ? LOW : HIGH);
    delay(2);
  }
  digitalWrite(MARK, LOW);

  waitUntil(1000);
  {
    portDISABLE_INTERRUPTS();
    const uint32_t timeout_cycles = microsecondsToClockCycles(2000);
    const uint32_t start_cycle_count = esp_cpu_get_cycle_count();
    uint32_t n = 0;
    while (digitalRead(IN) != 1) {
      n++;
      if (esp_cpu_get_cycle_count() - start_cycle_count > timeout_cycles) break;
    }
    portENABLE_INTERRUPTS();
    a0n = n;
  }

  waitUntil(1100);
  const uint32_t widths[] = {2, 10, 50, 500};
  for (uint32_t w : widths)
    for (int i = 0; i < 143; i++) {
      atPhase((i * 7) % 1000);
      digitalWrite(OUT, HIGH);
      delayMicroseconds(w);
      digitalWrite(OUT, LOW);
      delay(2);
    }

  waitUntil(3000);
  for (int i = 0; i < 2000; i++) {
    digitalWrite(MARK, (i & 1) ? LOW : HIGH);
    delayMicroseconds(500);
  }
  digitalWrite(MARK, LOW);

  waitUntil(4100);
  for (int i = 0; i < 200; i++) {
    digitalWrite(OUT, HIGH);
    delay(1);
    digitalWrite(OUT, LOW);
    delayMicroseconds((37 * i) % 1000);
  }

  waitUntil(4700);
  for (int i = 0; i < 50; i++) {
    TickType_t t = xTaskGetTickCount();
    while (xTaskGetTickCount() == t) {}
    kt[i] = micros();
  }

  waitUntil(5000);
  for (int k = 0; k < 300 && millis() < 6100; k++) {
    while (digitalRead(IN) != HIGH && millis() < 6100) {}
    digitalWrite(MARK, HIGH);
    while (digitalRead(IN) != LOW && millis() < 6100) {}
    digitalWrite(MARK, LOW);
  }

  waitUntil(6200);
  for (int k = 0; k < 300; k++) p5[k] = pulseIn(IN, HIGH, 8000);

  waitUntil(7700);
  for (int k = 0; k < 300; k++) {
    portDISABLE_INTERRUPTS();
    p6[k] = pulseIn(IN, HIGH, 8000);
    portENABLE_INTERRUPTS();
  }

  waitUntil(9200);
  for (int k = 0; k < 100; k++) {
    digitalWrite(MARK, HIGH);
    uint32_t t0 = micros();
    uint32_t x = 0;
    for (int i = 0; i < 100 + 37 * k; i++) x += i ^ (x >> 3);
    sink = x;
    uint32_t t1 = micros();
    digitalWrite(MARK, LOW);
    u7[k] = t1 - t0;
    delay(1);
  }

  for (int i = 0; i < 20; i++) Serial.printf("C %d %lu\n", i, (unsigned long)cal[i]);
  Serial.printf("A0 %lu\n", (unsigned long)a0n);
  for (int i = 0; i < 50; i++) Serial.printf("K %d %lu\n", i, (unsigned long)kt[i]);
  for (int k = 0; k < 300; k++) Serial.printf("P %d %lu\n", k, (unsigned long)p5[k]);
  for (int k = 0; k < 300; k++) Serial.printf("Q %d %lu\n", k, (unsigned long)p6[k]);
  for (int k = 0; k < 100; k++) Serial.printf("U %d %lu\n", k, (unsigned long)u7[k]);
  Serial.println("DONE");
  for (;;) delay(1000);
}
