/*
 * TBI Lab example: an ESP32 watches a logic half adder and shows its sum (the Arduino version of
 * the MicroPython example).
 *
 * Two switches (A, B) feed a half adder built from four real single logic gates: an OR, a NAND
 * and an AND make the sum bit S = A xor B, and a second AND makes the carry bit C = A and B.
 * The ESP32 reads the switches on GPIO32/GPIO33 and the gates' outputs on GPIO34/GPIO35 (inputs
 * only: the gates drive them, the ESP32 never drives the logic). It prints every new state and
 * sets the brightness of the LED on GPIO18 (1 kHz PWM, 16 bit) from the number the adder computed.
 */
const int A_PIN = 32;
const int B_PIN = 33;
const int S_PIN = 34;
const int C_PIN = 35;
const int LED = 18;

// Brightness for the adder's sum 0, 1, 2, out of 65536 (never a duty of 0: not simulated).
const uint32_t LEVELS[] = {2048, 24576, 63488};

void setup() {
  Serial.begin(115200);
  pinMode(A_PIN, INPUT);
  pinMode(B_PIN, INPUT);
  pinMode(S_PIN, INPUT);
  pinMode(C_PIN, INPUT);
  ledcAttach(LED, 1000, 16);
  ledcWrite(LED, LEVELS[0]);
}

void loop() {
  static int last = -1;
  int a = digitalRead(A_PIN);
  int b = digitalRead(B_PIN);
  int s = digitalRead(S_PIN);
  int c = digitalRead(C_PIN);
  int now = (a << 3) | (b << 2) | (s << 1) | c;
  if (now != last) {
    int total = 2 * c + s;
    int expected = a + b;
    Serial.printf("A=%d B=%d -> C=%d S=%d = %d %s\n", a, b, c, s, total,
                  total == expected ? "ok" : "MISMATCH");
    ledcWrite(LED, LEVELS[total]);
    last = now;
  }
  delay(20);
}
