/*
 * TBI Lab example: blink two ESP32 outputs in a recognisable pattern.
 *
 * Ordinary Arduino API only. GPIO2 drives the LED on the breadboard; GPIO18 toggles too, a
 * quarter period later, so the two outputs cannot be confused on the pin view.
 *
 * Sprint 25: this example no longer reads GPIO5. Nothing is connected to that pin, and a real
 * ESP32 reads an undefined level from an unconnected input, so the simulator stops a run that
 * reads it instead of reporting LOW.
 */

const int OUT_PIN_A = 2;   // the LED
const int OUT_PIN_B = 18;  // a second output, toggled a quarter period later

void setup() {
  Serial.begin(115200);
  pinMode(OUT_PIN_A, OUTPUT);
  pinMode(OUT_PIN_B, OUTPUT);
  digitalWrite(OUT_PIN_A, LOW);
  digitalWrite(OUT_PIN_B, LOW);
  Serial.println("TBI-ARDUINO-READY");
}

void loop() {
  digitalWrite(OUT_PIN_A, HIGH);
  delay(200);
  digitalWrite(OUT_PIN_B, HIGH);
  delay(200);
  digitalWrite(OUT_PIN_A, LOW);
  delay(200);
  digitalWrite(OUT_PIN_B, LOW);
  delay(200);
  Serial.println("BLINK");
}
