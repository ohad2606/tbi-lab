/*
 * Sprint 25 runtime test firmware (Runtime v5). Not a product artifact.
 *
 * A LEVEL interrupt (ONHIGH): the ESP32 TRM does not state how a cleared status bit behaves while
 * the level persists, so Runtime v5 does not deliver it; it reports the facility unmodelled at the
 * register write and the host ends the session there, naming it.
 */
volatile uint32_t n = 0;
void IRAM_ATTR onHigh() { n++; }

void setup() {
  Serial.begin(115200);
  pinMode(4, INPUT);
  Serial.println("TBI-IRQ-LEVEL-READY");
  attachInterrupt(digitalPinToInterrupt(4), onHigh, ONHIGH);
  Serial.println("TBI-IRQ-LEVEL-ATTACHED");
}

void loop() { delay(100); }
