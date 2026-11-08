/*
 * Sprint 17C runtime test firmware (R4 review item M2: the APB clock changes while PWM runs). Not a
 * product artifact. ledcAttach(18, 5000, 8) (APB 80 MHz) at duty 64 (25 %), then
 * setCpuFrequencyMhz(40): below 80 MHz the APB clock follows the CPU (40 MHz), which the host must
 * refuse. Each step prints "APB <tag> <getApbFrequency()>". The emulator stops making progress
 * within ~1.5 s after the clock change (finding F-17C-1, Runtime v2 and v3 alike), so the tests
 * stop at the "APB 40" marker; "APB-DONE" is not reached.
 */
static void step(const char *tag) {
  Serial.printf("APB %s %lu\n", tag, (unsigned long)getApbFrequency());
  delay(50);
}

void setup() {
  Serial.begin(115200);
  Serial.println("APB-READY");
  ledcAttach(18, 5000, 8);
  ledcWrite(18, 64);
  step("80");
  setCpuFrequencyMhz(40);
  step("40");
  Serial.println("APB-DONE");
}

void loop() { delay(1000); }
