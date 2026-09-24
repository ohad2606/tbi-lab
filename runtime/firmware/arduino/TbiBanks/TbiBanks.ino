/*
 * TBI Lab runtime R1: classic-ESP32 GPIO bank coverage. Runtime test firmware, not product code.
 *
 * Ordinary Arduino API only (pinMode / digitalWrite / digitalRead).
 *   Outputs: GPIO4, GPIO16, GPIO27 (bank 0; masked by the Sprint 0/1 feasibility runtime),
 *            GPIO25 (bank 0), GPIO32, GPIO33 (bank 1: GPIO_OUT1 / GPIO_ENABLE1).
 *   Inputs:  GPIO34, GPIO35, GPIO36, GPIO39 (bank 1, input-only pads, GPIO_IN1).
 * Setup sweeps every output HIGH then LOW and reads each back (a driving pad reads its own level).
 * Loop echoes inputs to outputs across banks (GPIO35 -> GPIO33, GPIO34 -> GPIO4), so a host
 * circuit that drives the inputs closes a two-way loop through the firmware.
 */
const int OUTS[] = {4, 16, 27, 25, 32, 33};
const int INS[] = {34, 35, 36, 39};

void setup() {
  Serial.begin(115200);
  for (int o : OUTS) {
    pinMode(o, OUTPUT);
    digitalWrite(o, LOW);
  }
  for (int i : INS) pinMode(i, INPUT);
  Serial.println("TBI-BANKS-READY");
  for (int o : OUTS) {
    digitalWrite(o, HIGH);
    delay(10);
    Serial.printf("RB%d=%d\n", o, digitalRead(o));
    digitalWrite(o, LOW);
    delay(10);
  }
  Serial.printf("IN36=%d IN39=%d\n", digitalRead(36), digitalRead(39));
  Serial.println("TBI-BANKS-SWEEP-DONE");
}

void loop() {
  static int last35 = -1, last34 = -1;
  int v35 = digitalRead(35);
  int v34 = digitalRead(34);
  if (v35 != last35) {
    digitalWrite(33, v35);
    last35 = v35;
    Serial.printf("ECHO35=%d\n", v35);
  }
  if (v34 != last34) {
    digitalWrite(4, v34);
    last34 = v34;
    Serial.printf("ECHO34=%d\n", v34);
  }
  delay(5);
}
