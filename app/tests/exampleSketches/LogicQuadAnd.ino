/*
 * TBI Lab example: two ESP32 outputs into a quad AND gate IC (SN74LVC08A).
 *
 * GPIO18 drives input 1A and GPIO19 input 1B of gate 1; its output 1Y lights LED D1 through
 * 220 Ohm and also feeds input 2A of gate 2. The push button, with its 10 kOhm pull-down, drives
 * input 2B, so LED D2 lights only while the button is held (2Y = 1Y AND button). Gates 3 and 4
 * are unused: their inputs are tied to GND, as the datasheet requires. The IC runs from the bench
 * supply at 3.0 V, the supply where its datasheet guarantees the outputs for real loads.
 */
const int A_PIN = 18;
const int B_PIN = 19;

void setup() {
  Serial.begin(115200);
  pinMode(A_PIN, OUTPUT);
  pinMode(B_PIN, OUTPUT);
  digitalWrite(A_PIN, HIGH);
  digitalWrite(B_PIN, HIGH);
  Serial.println("1A=1 1B=1: D1 on; hold the button to light D2");
}

void loop() {
  delay(1000);
}
