/*
 * TBI Lab runtime R1: guest-initiated reset probe. Runtime test firmware, not product code.
 *
 * Full-chip reset is unsupported in V1 (ADR-007). This firmware requests one (esp_restart) so the
 * runtime can prove the request ends the session explicitly instead of silently rebooting.
 */
void setup() {
  Serial.begin(115200);
  pinMode(2, OUTPUT);
  digitalWrite(2, HIGH);
  Serial.println("TBI-RESTART-REQUEST");
  Serial.flush();
  delay(10);
  esp_restart();
}

void loop() {}
