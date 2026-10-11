/*
 * G-2 targeted validation (F-R2-1 impact on DHT22). Diagnostic firmware, not a product artifact.
 * TbiDht22's library-free AM2302 read, with each read started at a swept phase within the simulated
 * millisecond, printing the decoded value and every bit's measured high time:
 *   "R <k> <rc> <t10> <h10> <phase us> | <40 high times us>"
 */
const int DATA = 4;

static bool waitLevel(int level, uint32_t timeoutUs) {
  uint32_t t0 = micros();
  while (digitalRead(DATA) != level)
    if (micros() - t0 > timeoutUs) return false;
  return true;
}

static uint8_t hi[40];

static int dhtRead(int16_t *t10, uint16_t *h10) {
  uint8_t d[5] = {0, 0, 0, 0, 0};
  pinMode(DATA, OUTPUT);
  digitalWrite(DATA, LOW);
  delayMicroseconds(1100);
  pinMode(DATA, INPUT);
  if (!waitLevel(LOW, 200)) return 1;
  if (!waitLevel(HIGH, 200)) return 2;
  if (!waitLevel(LOW, 200)) return 3;
  for (int i = 0; i < 40; i++) {
    if (!waitLevel(HIGH, 200)) return 4;
    uint32_t t0 = micros();
    if (!waitLevel(LOW, 200)) return 5;
    uint32_t w = micros() - t0;
    hi[i] = w > 255 ? 255 : w;
    if (w > 48) d[i / 8] |= 0x80 >> (i % 8);
  }
  if (((d[0] + d[1] + d[2] + d[3]) & 0xff) != d[4]) return 6;
  *h10 = (d[0] << 8) | d[1];
  int16_t t = ((d[2] & 0x7f) << 8) | d[3];
  *t10 = (d[2] & 0x80) ? -t : t;
  return 0;
}

void setup() {
  Serial.begin(115200);
  pinMode(DATA, INPUT);
  Serial.println("TBI-DHTSWEEP-READY");
  delay(1500);
}

void loop() {
  static int k = 0;
  uint32_t target = (k * 37 + (k / 27) * 7) % 1000;
  uint32_t w0 = micros();
  while ((micros() - target) % 1000 >= 20 && micros() - w0 < 2000) {}
  uint32_t ph = micros() % 1000;
  int16_t t10 = 0;
  uint16_t h10 = 0;
  memset(hi, 0, sizeof hi);
  int e = dhtRead(&t10, &h10);
  Serial.printf("R %d %d %d %u %lu |", k, e, t10, h10, (unsigned long)ph);
  for (int i = 0; i < 40; i++) Serial.printf(" %u", hi[i]);
  Serial.println();
  k++;
  delay(2100);
}
