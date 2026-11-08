/*
 * TBI Lab runtime test firmware (Sprint 11, R1 slice 6): 8x8 LED matrix load. Not product code.
 *
 * Ordinary Arduino API only (pinMode / digitalWrite / digitalRead / delayMicroseconds).
 *   Columns (dot anodes, HIGH = on):  GPIO 4, 16, 27, 25, 32, 33, 18, 19
 *   Rows (dot cathodes, LOW = on):    GPIO 23, 22, 21, 17, 13, 14, 26, 5
 *   Mode input:                       GPIO 34 (input-only pad)
 * GPIO34 LOW: a STATIC pattern (row 1 and row 2 on, columns 1-4 on) written once per change.
 * GPIO34 HIGH: a MULTIPLEXED checkerboard, one row per millisecond (1 kHz row rate, 125 Hz
 * frames), every line written with its own digitalWrite (the worst case for edge count).
 * Serial: TBI-R1SCAN-READY, then STATIC / SCAN on each mode change, and FRAMES=<n> every 125 frames.
 */
const int COLS[] = {4, 16, 27, 25, 32, 33, 18, 19};
const int ROWS[] = {23, 22, 21, 17, 13, 14, 26, 5};
const int MODE = 34;

static void allOff() {
  for (int c : COLS) digitalWrite(c, LOW);
  for (int r : ROWS) digitalWrite(r, HIGH);
}

static void staticPattern() {
  allOff();
  for (int j = 0; j < 4; j++) digitalWrite(COLS[j], HIGH);
  digitalWrite(ROWS[0], LOW);
  digitalWrite(ROWS[1], LOW);
}

void setup() {
  Serial.begin(115200);
  for (int c : COLS) pinMode(c, OUTPUT);
  for (int r : ROWS) pinMode(r, OUTPUT);
  pinMode(MODE, INPUT);
  allOff();
  Serial.println("TBI-R1SCAN-READY");
}

void loop() {
  static int mode = -1;
  static unsigned long frames = 0;
  int m = digitalRead(MODE);
  if (m != mode) {
    mode = m;
    if (mode) {
      Serial.println("SCAN");
    } else {
      Serial.println("STATIC");
      staticPattern();
    }
  }
  if (!mode) {
    delay(1);
    return;
  }
  for (int i = 0; i < 8; i++) {
    for (int j = 0; j < 8; j++) digitalWrite(COLS[j], ((i + j) % 2 == 0) ? HIGH : LOW);
    digitalWrite(ROWS[i], LOW);
    delayMicroseconds(1000);
    digitalWrite(ROWS[i], HIGH);
  }
  if (++frames % 125 == 0) Serial.printf("FRAMES=%lu\n", frames);
}
