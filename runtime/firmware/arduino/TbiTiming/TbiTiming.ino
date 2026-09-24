/*
 * Sprint 1 timing-fidelity probe for the classic-ESP32 runtime. Not product code.
 *
 * GPIO2 edges are markers: the bridge timestamps them in QEMU virtual time. The firmware prints
 * its OWN view of the same intervals (millis, esp_timer, CPU cycle counter, hardware timer ticks),
 * so the two can be compared without assuming either is right.
 */
#include "esp_timer.h"

volatile uint32_t ticks = 0;
hw_timer_t *tim = nullptr;
void IRAM_ATTR onTimer() { ticks++; }
static inline void mark(int level) { digitalWrite(2, level); }

void setup() {
  pinMode(2, OUTPUT);
  mark(1);                                              // M1 setup() entered
  Serial.begin(115200);
  Serial.printf("CPU_MHZ=%u XTAL_MHZ=%u APB_HZ=%u\n", getCpuFrequencyMhz(), getXtalFrequencyMhz(), getApbFrequency());
  Serial.printf("AT_SETUP millis=%u micros=%lld\n", millis(), esp_timer_get_time());

  uint32_t m0 = millis(); int64_t u0 = esp_timer_get_time(); uint32_t c0 = ESP.getCycleCount();
  mark(0);                                              // M2 before delay(1000)
  delay(1000);
  mark(1);                                              // M3 after delay(1000)
  uint32_t m1 = millis(); int64_t u1 = esp_timer_get_time(); uint32_t c1 = ESP.getCycleCount();
  Serial.printf("DELAY1000 millis=%u micros=%lld cycles=%u\n", m1 - m0, u1 - u0, c1 - c0);

  volatile uint32_t x = 0;
  int64_t u2 = esp_timer_get_time(); uint32_t c2 = ESP.getCycleCount();
  mark(0);                                              // M4 busy loop start
  for (uint32_t i = 0; i < 1000000; i++) x += i;
  mark(1);                                              // M5 busy loop end
  int64_t u3 = esp_timer_get_time(); uint32_t c3 = ESP.getCycleCount();
  Serial.printf("BUSY1M micros=%lld cycles=%u\n", u3 - u2, c3 - c2);

  tim = timerBegin(1000000);                            // 1 MHz timer base
  timerAttachInterrupt(tim, &onTimer);
  timerAlarm(tim, 100000, true, 0);                     // alarm every 100 ms
  mark(0);                                              // M6 timer window start
  delay(1000);
  mark(1);                                              // M7 timer window end
  Serial.printf("TIMER100MS ticks_in_1s=%u\n", ticks);
  Serial.println("TBI-TIMING-DONE");
}

void loop() { delay(1000); }
