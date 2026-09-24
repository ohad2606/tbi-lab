/*
 * TBI Lab runtime R1: session isolation probe. Runtime test firmware, not product code.
 *
 * Increments a boot counter in NVS (a real flash write by the guest) and reports it. Every session
 * boots from a fresh private copy of the immutable artifact, so every session must report 1: a
 * value above 1 would mean a previous session's flash writes survived.
 */
#include <Preferences.h>

Preferences prefs;

void setup() {
  Serial.begin(115200);
  prefs.begin("tbi", false);
  uint32_t boots = prefs.getUInt("boots", 0) + 1;
  prefs.putUInt("boots", boots);
  prefs.end();
  Serial.printf("TBI-NVS-BOOTS=%u\n", boots);
  pinMode(2, OUTPUT);
  digitalWrite(2, HIGH);  // marker: the write is done
  Serial.println("TBI-NVS-DONE");
}

void loop() { delay(1000); }
