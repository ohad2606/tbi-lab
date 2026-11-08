/*
 * Sprint 12 runtime test firmware (R2, DHT22). Not a product artifact.
 * DATA on GPIO4 with an EXTERNAL pull-up (internal pull-ups are not simulated). A library-free
 * read of the AM2302 single-wire protocol every 2.5 s: prints "T <degC x10> H <%RH x10>" or
 * "E <step>" when the sensor does not answer as the datasheet specifies.
 */
const int DATA = 4;

static bool waitLevel(int level, uint32_t timeoutUs) {
  uint32_t t0 = micros();
  while (digitalRead(DATA) != level)
    if (micros() - t0 > timeoutUs) return false;
  return true;
}

static int dhtRead(int16_t *t10, uint16_t *h10) {
  uint8_t d[5] = {0, 0, 0, 0, 0};
  pinMode(DATA, OUTPUT);
  digitalWrite(DATA, LOW);
  delayMicroseconds(1100);  // start signal: at least 1 ms low (AM2302 sheet p.4)
  pinMode(DATA, INPUT);     // release: the pull-up raises the line
  if (!waitLevel(LOW, 200)) return 1;   // sensor response: 80 us low
  if (!waitLevel(HIGH, 200)) return 2;  // 80 us high
  if (!waitLevel(LOW, 200)) return 3;
  for (int i = 0; i < 40; i++) {
    if (!waitLevel(HIGH, 200)) return 4;  // 50 us low before each bit
    uint32_t t0 = micros();
    if (!waitLevel(LOW, 200)) return 5;
    if (micros() - t0 > 48) d[i / 8] |= 0x80 >> (i % 8);  // 26-28 us = 0, 70 us = 1
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
  Serial.println("TBI-DHT22-READY");
  delay(1500);  // no request within 1 s of power-up (AM2302 sheet p.2)
}

void loop() {
  int16_t t10;
  uint16_t h10;
  int e = dhtRead(&t10, &h10);
  if (e) Serial.printf("E %d\n", e);
  else Serial.printf("T %d H %u\n", t10, h10);
  delay(2500);
}
