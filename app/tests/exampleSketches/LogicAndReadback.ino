/*
 * TBI Lab example: an ESP32 output and a push button through a logic AND gate.
 *
 * GPIO18 drives input A of an SN74LVC1G08 AND gate; the push button, with its 10 kOhm
 * pull-down, drives input B. The gate's output lights the LED through 220 Ohm and is read back
 * on GPIO4. The gate runs from the bench supply at 3.0 V, the supply where its datasheet
 * guarantees the output for real loads. Hold the button: the LED blinks with GPIO18, and the
 * serial monitor shows what GPIO4 reads right after each change of GPIO18.
 */
const int A_PIN = 18;
const int Y_PIN = 4;

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
  Serial.println(y);
  delay(500);
}
