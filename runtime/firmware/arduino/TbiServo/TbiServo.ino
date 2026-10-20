/*
 * Sprint 15 runtime test firmware (R4, SG90 on LEDC). Not a product artifact. ledcAttach(18, 50,
 * 16): APB 80 MHz / 24.4140625 / 65536 = 50 Hz exactly. Pulses of 1.0, 2.0 and 1.5 ms (duty 3277,
 * 6554, 4915 = 65536 x width / 20 ms), 400 ms each; prints "SERVO <duty>" per step and
 * "SERVO-DONE". The first write follows the attach within the same cycle (no duty 0 latched).
 */
void setup() {
  Serial.begin(115200);
  Serial.println("SERVO-READY");
  ledcAttach(18, 50, 16);
  const uint32_t duties[] = {3277, 6554, 4915};
  for (uint32_t d : duties) {
    ledcWrite(18, d);
    Serial.printf("SERVO %lu\n", (unsigned long)d);
    delay(400);
  }
  Serial.println("SERVO-DONE");
}

void loop() { delay(1000); }
