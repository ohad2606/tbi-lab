/*
 * Sprint 25 runtime test firmware (Runtime v5, gpio-irq). Not a product artifact.
 *
 * Ordinary Arduino interrupts (attachInterrupt) on three inputs, each with a different edge type;
 * every ISR answers on an output with one register write, so the host sees the exact virtual time
 * the ISR ran (its G frame) and compares it with the scheduled edge:
 *   GPIO4  CHANGE  -> GPIO2 mirrors GPIO4's level
 *   GPIO5  RISING  -> GPIO18 toggles
 *   GPIO13 FALLING -> GPIO19 toggles
 * The loop prints the three ISR counts every 50 ms while they change.
 */
#include "soc/gpio_struct.h"

volatile uint32_t nChange = 0, nRise = 0, nFall = 0;
volatile bool t18 = false, t19 = false;

void IRAM_ATTR onChange() {
  if (GPIO.in & (1u << 4)) GPIO.out_w1ts = 1u << 2;
  else GPIO.out_w1tc = 1u << 2;
  nChange++;
}

void IRAM_ATTR onRise() {
  t18 = !t18;
  if (t18) GPIO.out_w1ts = 1u << 18;
  else GPIO.out_w1tc = 1u << 18;
  nRise++;
}

void IRAM_ATTR onFall() {
  t19 = !t19;
  if (t19) GPIO.out_w1ts = 1u << 19;
  else GPIO.out_w1tc = 1u << 19;
  nFall++;
}

void setup() {
  Serial.begin(115200);
  for (int p : {2, 18, 19}) {
    pinMode(p, OUTPUT);
    digitalWrite(p, LOW);
  }
  for (int p : {4, 5, 13}) pinMode(p, INPUT);
  attachInterrupt(digitalPinToInterrupt(4), onChange, CHANGE);
  attachInterrupt(digitalPinToInterrupt(5), onRise, RISING);
  attachInterrupt(digitalPinToInterrupt(13), onFall, FALLING);
  Serial.println("TBI-IRQ-READY");
}

void loop() {
  static uint32_t a = 0, b = 0, c = 0;
  if (nChange != a || nRise != b || nFall != c) {
    a = nChange;
    b = nRise;
    c = nFall;
    Serial.printf("IRQ change=%lu rise=%lu fall=%lu\n", (unsigned long)a, (unsigned long)b,
                  (unsigned long)c);
  }
  delay(50);
}
