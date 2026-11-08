/*
 * G-2 round 3 diagnostic firmware (F-R2-1 / F-R2-2), not a product artifact.
 * Arduino pulseIn on GPIO4, in the Arduino loop task (core 1). Prints "P <us>" per pulse, then
 * yields one tick, so the idle task runs.
 */
const int PIN = 4;

void setup() {
  Serial.begin(115200);
  pinMode(PIN, INPUT);
  Serial.printf("TBI-PULSEIN-READY core %d\n", xPortGetCoreID());
}

void loop() {
  unsigned long us = pulseIn(PIN, HIGH, 200000);
  if (us) Serial.printf("P %lu\n", us);
  vTaskDelay(1);
}
