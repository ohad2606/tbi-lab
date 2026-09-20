/*
 * Phase 6 — Arduino compatibility proof for the classic ESP32 runtime.
 *
 * Deliberately minimal: it only has to show that ordinary Arduino-style GPIO firmware
 * executes through the runtime we selected, using the normal Arduino API rather than
 * register pokes. This is not a product feature and there is no Arduino IDE involved.
 *
 * Output pins are toggled in a fixed, recognisable pattern so the host bridge can assert
 * the exact sequence it observes. An input pin is read back and echoed over serial so the
 * host can prove injection reaches Arduino's digitalRead().
 */

const int OUT_PIN_A = 2;   // bank 0
const int OUT_PIN_B = 18;  // bank 0, different register bit
const int IN_PIN    = 5;   // bank 0 input

void setup() {
  Serial.begin(115200);
  pinMode(OUT_PIN_A, OUTPUT);
  pinMode(OUT_PIN_B, OUTPUT);
  pinMode(IN_PIN, INPUT);

  digitalWrite(OUT_PIN_A, LOW);
  digitalWrite(OUT_PIN_B, LOW);
  Serial.println("TBI-ARDUINO-READY");
}

void loop() {
  // A recognisable, asymmetric pattern: A and B must not be confusable.
  digitalWrite(OUT_PIN_A, HIGH);
  delay(200);
  digitalWrite(OUT_PIN_B, HIGH);
  delay(200);
  digitalWrite(OUT_PIN_A, LOW);
  delay(200);
  digitalWrite(OUT_PIN_B, LOW);
  delay(200);

  Serial.print("IN=");
  Serial.println(digitalRead(IN_PIN));
}
