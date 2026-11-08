/*
 * Sprint 12 runtime test firmware (bridge v2, scheduled inputs). Not a product artifact.
 *
 * Busy-polls GPIO4 and records each level change with its micros() time; every change is
 * printed once the line has been quiet for 20 ms (printing never delays an edge capture).
 * The host compares the spacing of the recorded edges with the spacing it scheduled.
 */
const int PIN = 4;
const int MAX_EDGES = 64;

void setup() {
  Serial.begin(115200);
  pinMode(PIN, INPUT);
  Serial.println("TBI-EDGE-READY");
}

void loop() {
  static uint32_t t[MAX_EDGES];
  static uint8_t v[MAX_EDGES];
  static int n = 0;
  static int last = digitalRead(PIN);
  static uint32_t quietSince = micros();
  int now = digitalRead(PIN);
  uint32_t us = micros();
  if (now != last) {
    last = now;
    if (n < MAX_EDGES) {
      t[n] = us;
      v[n] = now;
      n++;
    }
    quietSince = us;
  } else if (n > 0 && us - quietSince > 20000) {
    for (int i = 0; i < n; i++) Serial.printf("E %d %lu\n", v[i], (unsigned long)t[i]);
    n = 0;
  }
}
