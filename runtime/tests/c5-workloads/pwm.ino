/*
 * C-5 capacity workload (Runtime v5): LEDC PWM on one LED, as a dimming project does. Bounded: one duty
 * change every 500 ms, so the cost measured is the session's, not a harness flood. Prints a marker per step.
 */
static int duty = 0;
void setup() {
  Serial.begin(115200);
  Serial.println("C5-PWM-READY");
  if (!ledcAttach(2, 1000, 8)) Serial.println("C5-PWM-ATTACH-FAILED");
  ledcWrite(2, 64);
}
void loop() {
  duty = (duty + 32) % 224;
  ledcWrite(2, 32 + duty);
  Serial.println("C5-PWM-STEP");
  delay(500);
}
