/*
 * G-2 round 3 diagnostic firmware (F-R2-1), not a product artifact.
 * As TbiPulseIn, but measuring in a task pinned to core 0 (the Arduino loop task on core 1
 * sleeps), to show which core's activity freezes the other.
 */
const int PIN = 4;

static void measure(void *) {
  Serial.printf("TBI-PULSEIN-READY core %d\n", xPortGetCoreID());
  for (;;) {
    unsigned long us = pulseIn(PIN, HIGH, 200000);
    if (us) Serial.printf("P %lu\n", us);
    vTaskDelay(1);
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN, INPUT);
  xTaskCreatePinnedToCore(measure, "measure", 4096, NULL, 1, NULL, 0);
}

void loop() {
  vTaskDelay(portMAX_DELAY);
}
