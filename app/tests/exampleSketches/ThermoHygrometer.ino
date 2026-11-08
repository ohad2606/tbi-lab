/*
 * TBI Lab example: ESP32 thermo-hygrometer with a DHT22 / AM2302 sensor, without a library.
 *
 * DATA (GPIO4) has a 10 kOhm pull-up to 3.3 V: the sensor and the ESP32 only ever pull the line
 * low or release it. One read (AM2302 datasheet p.3-4):
 *   - the host pulls DATA low for at least 1 ms, then releases it;
 *   - the sensor answers 80 us low, 80 us high;
 *   - 40 bits follow, each a 50 us low then a high of 26-28 us ("0") or 70 us ("1");
 *   - bytes: humidity x10 (16 bits), temperature x10 (16 bits, bit 15 = sign), checksum (the
 *     low 8 bits of the sum of the four data bytes).
 * The sensor needs 1 s after power-up and at least 2 s between reads (datasheet p.2, p.5).
 */
const int DATA = 4;

/** Wait until DATA reads `level`; false after `timeoutUs`. */
static bool waitLevel(int level, uint32_t timeoutUs) {
  uint32_t t0 = micros();
  while (digitalRead(DATA) != level)
    if (micros() - t0 > timeoutUs) return false;
  return true;
}

/** One AM2302 read: 0 on success, else the step that failed. */
static int dhtRead(int16_t *t10, uint16_t *h10) {
  uint8_t d[5] = {0, 0, 0, 0, 0};
  // Start signal: DATA low for 1.1 ms (at least 1 ms), then released to the pull-up.
  pinMode(DATA, OUTPUT);
  digitalWrite(DATA, LOW);
  delayMicroseconds(1100);
  pinMode(DATA, INPUT);
  // Response: the sensor pulls low (80 us), releases (80 us), then the first bit starts low.
  if (!waitLevel(LOW, 200)) return 1;
  if (!waitLevel(HIGH, 200)) return 2;
  if (!waitLevel(LOW, 200)) return 3;
  for (int i = 0; i < 40; i++) {
    if (!waitLevel(HIGH, 200)) return 4;
    uint32_t t0 = micros();
    if (!waitLevel(LOW, 200)) return 5;
    // A high longer than 48 us is a "1" (70 us), shorter a "0" (26-28 us).
    if (micros() - t0 > 48) d[i / 8] |= 0x80 >> (i % 8);
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
  delay(1500);
}

void loop() {
  int16_t t10;
  uint16_t h10;
  int err = dhtRead(&t10, &h10);
  if (err)
    Serial.printf("DHT22 read failed (step %d)\n", err);
  else
    Serial.printf("Temperature: %.1f C  Humidity: %.1f %%\n", t10 / 10.0, h10 / 10.0);
  delay(2500);
}
