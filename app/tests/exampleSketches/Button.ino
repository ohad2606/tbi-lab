/*
 * TBI Lab example: a push button lights an LED (the Arduino version of the MicroPython example).
 *
 * The button connects 3.3 V through 1 kOhm to GPIO34; a 10 kOhm resistor pulls GPIO34 down to GND,
 * so the pin reads LOW while the button is released and HIGH while it is held. GPIO34 is an
 * input-only pin with no internal pull resistor, which is why the pull-down is a real resistor in
 * the circuit. GPIO4 drives a red LED through 220 Ohm. The sketch reads the button every 10 ms.
 */
const int BUTTON = 34;
const int LED = 4;

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON, INPUT);
  pinMode(LED, OUTPUT);
  digitalWrite(LED, LOW);
}

void loop() {
  static int last = -1;
  int held = digitalRead(BUTTON);
  digitalWrite(LED, held);
  if (held != last) {
    Serial.println(held ? "button held" : "button released");
    last = held;
  }
  delay(10);
}
