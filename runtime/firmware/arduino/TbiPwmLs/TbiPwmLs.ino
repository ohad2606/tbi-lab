/*
 * Sprint 15 runtime test firmware (R4, a refusal). Not a product artifact. Nine channels at 1 kHz /
 * 8 bit: on the classic ESP32 the 3.3.12 core gives the first eight high-speed channels and the
 * ninth a low-speed one, which the runtime reports as unsupported (separate update rules). Prints
 * "LS <pin>" per channel and "LS-DONE".
 */
void setup() {
  Serial.begin(115200);
  Serial.println("LS-READY");
  const uint8_t pins[] = {2, 4, 5, 12, 13, 14, 15, 16, 17};
  for (uint8_t p : pins) {
    ledcAttach(p, 1000, 8);
    ledcWrite(p, 128);
    Serial.printf("LS %u\n", p);
  }
  Serial.println("LS-DONE");
}

void loop() { delay(1000); }
