/*
 * Sprint 15 runtime test firmware (R4, LEDC PWM). Not a product artifact. Pinned arduino-esp32
 * 3.3.12 core: analogWrite on GPIO2 (1 kHz, 8 bit, REF_TICK) at 64, 128 and 255; ledcAttach(4,
 * 5000, 12) (APB) at 1024, 2048 and 4096; a second channel ledcAttach(5, 1000, 8) at 64; then
 * ledcDetach(4) and GPIO4 driven HIGH as plain GPIO. Each step prints "PWM <tag>" and lasts 50 ms.
 * No duty 0 is ever latched: each attach is followed by its first write within the same cycle.
 */
static void step(const char *tag) {
  Serial.printf("PWM %s\n", tag);
  delay(50);
}

void setup() {
  Serial.begin(115200);
  Serial.println("PWM-READY");
  analogWrite(2, 64);
  step("A64");
  analogWrite(2, 128);
  step("A128");
  analogWrite(2, 255);
  step("A255");
  ledcAttach(4, 5000, 12);
  ledcWrite(4, 1024);
  step("L1024");
  ledcWrite(4, 2048);
  step("L2048");
  ledcWrite(4, 4096);
  step("L4096");
  ledcAttach(5, 1000, 8);
  ledcWrite(5, 64);
  step("L5-64");
  ledcDetach(4);
  pinMode(4, OUTPUT);
  digitalWrite(4, HIGH);
  step("D4-HIGH");
  Serial.println("PWM-DONE");
}

void loop() { delay(1000); }
