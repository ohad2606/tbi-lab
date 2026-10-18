// O-R4-1 bench sketch (BENCH-PROTOCOL.md §4): LEDC duty 0 on a REAL ESP32 DevKitC, GPIO2 -> 10 kOhm
// -> GND. For the bench only: it is not a simulator artifact and is never run on QEMU.
//
// One flash runs the four protocol cases in order, each from a clean reset (the step number
// survives ESP.restart() in RTC memory), so no case inherits LEDC state from the one before:
//   4a  analogWrite(2, 0) once, then hold
//   4b  ledcAttach(2, 5000, 12); ledcWrite(2, 0), then hold
//   4c  ledcAttach(2, 5000, 12); ledcWrite(2, 2048); 1 s; ledcWrite(2, 0), then hold
//   4d  as 4c with ledcWrite(2, 4096) (100 %) before the 0
// Each hold lasts HOLD_MS. Serial (115200) prints "STEP <id> HOLD" when duty 0 is in place: measure
// V(GPIO2) DC (and scope pulses, if available) during the hold, then "STEP <id> END". After 4d the
// sketch prints "ALL DONE" and holds 4d's state. To rerun, power-cycle the board (a power-on
// reset starts again at 4a).
#include <Arduino.h>
#include <esp_system.h>

static const int PIN = 2;
static const uint32_t HOLD_MS = 30000;
static const char *const STEPS[] = {"4a", "4b", "4c", "4d"};
RTC_NOINIT_ATTR static uint32_t step; // survives ESP.restart(), not a power cycle
RTC_NOINIT_ATTR static uint32_t magic;

void setup() {
  Serial.begin(115200);
  delay(500);
  if (esp_reset_reason() == ESP_RST_POWERON || magic != 0x0D0700D0) {
    magic = 0x0D0700D0;
    step = 0;
  }
  if (step > 3) {
    Serial.println("ALL DONE (power-cycle to rerun)");
    return;
  }
  const char *id = STEPS[step];
  Serial.printf("STEP %s START\n", id);
  switch (step) {
    case 0:
      analogWrite(PIN, 0);
      break;
    case 1:
      ledcAttach(PIN, 5000, 12);
      ledcWrite(PIN, 0);
      break;
    case 2:
    case 3:
      ledcAttach(PIN, 5000, 12);
      ledcWrite(PIN, step == 2 ? 2048 : 4096);
      Serial.printf("STEP %s DUTY %d\n", id, step == 2 ? 2048 : 4096);
      delay(1000);
      ledcWrite(PIN, 0);
      break;
  }
  Serial.printf("STEP %s HOLD %lu ms: measure V(GPIO2) now\n", id, (unsigned long)HOLD_MS);
  delay(HOLD_MS);
  Serial.printf("STEP %s END\n", id);
  Serial.flush();
  step++;
  if (step <= 3) ESP.restart();
  Serial.println("ALL DONE (power-cycle to rerun); holding 4d");
}

void loop() { delay(1000); }
