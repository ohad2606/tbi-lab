/*
 * TBI Lab example: an ESP32 output and a manual switch through a logic OR gate.
 *
 * GPIO18 drives input A of an SN74LVC1G32 OR gate; the toggle switch drives input B (a manual
 * override). Each input has a 10 kOhm pull-down, so it is defined before setup() runs. The gate's
 * output lights the LED through 220 Ohm and is read back on GPIO19. The gate runs from the bench
 * supply at 3.0 V, the supply where its datasheet guarantees the output for real loads.
 * The firmware blinks GPIO18 and prints what the gate's output really is: with the switch closed
 * the LED stays on whatever the ESP32 does.
 */
const int A_PIN = 18;
const int Y_PIN = 19;

void setup() {
  Serial.begin(115200);
  pinMode(A_PIN, OUTPUT);
  pinMode(Y_PIN, INPUT);
}

void loop() {
  static bool a = false;
  a = !a;
  digitalWrite(A_PIN, a ? HIGH : LOW);
  int y = digitalRead(Y_PIN);
  Serial.print("A=");
  Serial.print(a ? 1 : 0);
  Serial.print(" Y=");
  Serial.print(y);
  if (!a && y) Serial.print(" (switch override)");
  Serial.println();
  delay(1000);
}
