// R4 PROBE (scratch): a 50 Hz / 16-bit servo signal on GPIO18 at 1.0, 1.5 and 2.0 ms.
void setup() {
  Serial.begin(115200);
  Serial.println("R4P-SERVO-READY");
  ledcAttach(18, 50, 16);
  const uint32_t duties[] = {3277, 4915, 6554};  // 65536 * {1.0, 1.5, 2.0} / 20 ms
  for (uint32_t d : duties) {
    ledcWrite(18, d);
    Serial.printf("S %lu\n", (unsigned long)d);
    delay(100);
  }
  Serial.println("R4P-DONE");
}
void loop() { delay(1000); }
