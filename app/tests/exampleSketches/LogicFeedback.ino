/*
 * TBI Lab example: firmware drives logic, reads it back, and the logic drives a relay.
 *
 * GPIO18 (REQUEST) drives input A of an SN74LVC1G08 AND gate (U2) at 3.0 V; the PERMIT switch,
 * with its 10 kOhm pull-down, drives input B. U2's output is read back on GPIO4 and drives a
 * second AND gate (U3), which switches a 2N3904 and the relay: the relay's contact lights the LED.
 *
 * The program raises the request, reads the gate right after, and decides:
 *   requested and the gate answers HIGH -> GRANTED (the relay is on)
 *   requested and the gate stays LOW    -> DENIED  (the permit switch is open)
 * then it drops the request and checks that the gate follows (released) - repeatedly.
 * It also reports how many CPU cycles passed between the write and the read.
 *
 * Try: open the PERMIT switch while it runs; change the 100 kOhm pull-down to 22 kOhm and see why
 * the simulator refuses it (the ESP32 output level is relied on only up to 100 uA).
 */
const int REQUEST_PIN = 18;
const int FEEDBACK_PIN = 4;

void setup() {
  Serial.begin(115200);
  pinMode(FEEDBACK_PIN, INPUT);
  pinMode(REQUEST_PIN, OUTPUT);
  digitalWrite(REQUEST_PIN, LOW);
}

unsigned long cycle = 0;
unsigned long granted = 0;
unsigned long denied = 0;

void loop() {
  for (int request = 1; request >= 0; request--) {
    uint32_t t0 = ESP.getCycleCount();
    digitalWrite(REQUEST_PIN, request ? HIGH : LOW);
    int feedback = digitalRead(FEEDBACK_PIN);
    uint32_t dt = ESP.getCycleCount() - t0;
    const char *verdict;
    if (request) {
      if (feedback) {
        granted++;
        verdict = "GRANTED";
      } else {
        denied++;
        verdict = "DENIED";
      }
    } else {
      verdict = feedback ? "FAULT" : "released";
    }
    Serial.printf("#%lu REQ=%d FB=%d %s granted=%lu denied=%lu cycles=%lu\n", cycle, request,
                  feedback, verdict, granted, denied, (unsigned long)dt);
    delay(400);
  }
  cycle++;
}
