/*
 * TBI Lab example: copy the input GPIO34 to the output GPIO4.
 *
 * Ordinary Arduino API only (pinMode / digitalWrite / digitalRead).
 *   Outputs: GPIO4 (the LED), and GPIO16, GPIO27, GPIO25, GPIO32, GPIO33 (swept at start-up).
 *   Input:   GPIO34 (input-only pad; the circuit holds it with a pull-down resistor).
 * Setup sweeps every output HIGH then LOW and reads each back (a driving pad reads its own level).
 * Loop copies GPIO34 to GPIO4 and reports each change.
 *
 * Sprint 25: the input-only pads GPIO35, GPIO36 and GPIO39 are no longer read. Nothing is
 * connected to them, and a real ESP32 reads an undefined level from an unconnected input.
 */
const int OUTS[] = {4, 16, 27, 25, 32, 33};
const int IN_PIN = 34;

void setup() {
  Serial.begin(115200);
  for (int o : OUTS) {
    pinMode(o, OUTPUT);
    digitalWrite(o, LOW);
  }
  pinMode(IN_PIN, INPUT);
  Serial.println("TBI-BANKS-READY");
  for (int o : OUTS) {
    digitalWrite(o, HIGH);
    delay(10);
    Serial.printf("RB%d=%d\n", o, digitalRead(o));
    digitalWrite(o, LOW);
    delay(10);
  }
  Serial.println("TBI-BANKS-SWEEP-DONE");
}

void loop() {
  static int last34 = -1;
  int v34 = digitalRead(IN_PIN);
  if (v34 != last34) {
    digitalWrite(4, v34);
    last34 = v34;
    Serial.printf("ECHO34=%d\n", v34);
  }
  delay(5);
}
