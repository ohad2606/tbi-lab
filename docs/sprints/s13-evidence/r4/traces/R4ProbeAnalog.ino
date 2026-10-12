// R4 PROBE (scratch, not a product artifact): analogWrite on GPIO2 at four duties.
void setup() {
  Serial.begin(115200);
  Serial.println("R4P-ANALOG-READY");
  const int duties[] = {64, 128, 255, 0};
  for (int d : duties) {
    analogWrite(2, d);
    Serial.printf("A %d\n", d);
    delay(50);
  }
  Serial.println("R4P-DONE");
}
void loop() { delay(1000); }
