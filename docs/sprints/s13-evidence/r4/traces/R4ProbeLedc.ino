// R4 PROBE (scratch): ledcAttach 5 kHz / 12-bit on GPIO4, four duties; then 1 kHz / 8-bit on GPIO5.
void setup() {
  Serial.begin(115200);
  Serial.println("R4P-LEDC-READY");
  ledcAttach(4, 5000, 12);
  const int duties[] = {0, 1024, 2048, 4095};
  for (int d : duties) {
    ledcWrite(4, d);
    Serial.printf("L %d\n", d);
    delay(50);
  }
  ledcAttach(5, 1000, 8);
  ledcWrite(5, 64);
  Serial.println("L5 64");
  delay(50);
  Serial.println("R4P-DONE");
}
void loop() { delay(1000); }
