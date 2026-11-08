// Sprint 12 runtime test firmware (R3, promoted from the R3 feasibility probe). Not a product
// artifact. Arduino Wire (core 3.3.12, IDF i2c_master) against test targets the host provides:
//   0x27 "port" (PCF8574-like), 0x50 "regs" (register file; data byte 0xEE is NACKed).
#include <Wire.h>

static void result(const char *id, bool ok, const String &detail) {
  Serial.printf("%s %s %s\n", id, ok ? "PASS" : "FAIL", detail.c_str());
}

static uint8_t expectReg(uint8_t r) { return r ^ 0x5a; }

// PCF8574 backpack: P0 RS, P1 RW, P2 E, P3 backlight, P4-P7 D4-D7.
static void lcdPulse(uint8_t v) {
  Wire.beginTransmission(0x27);
  Wire.write(v | 0x04);  // E high
  Wire.write(v & ~0x04); // E low: latch
  Wire.endTransmission();
}
static void lcdNibble(uint8_t nibble, uint8_t rs) { lcdPulse((nibble << 4) | 0x08 | rs); }
static void lcdByte(uint8_t b, uint8_t rs) {
  lcdNibble(b >> 4, rs);
  lcdNibble(b & 0x0f, rs);
}

void setup() {
  Serial.begin(115200);
  Serial.println("PROBE-BEGIN");

  // P-1
  bool began = Wire.begin(21, 22, 100000);
  result("P-1", began, "begin=" + String(began));

  // P-2: 3-byte write to 0x27
  Wire.beginTransmission(0x27);
  Wire.write(0x08);
  Wire.write(0x0c);
  Wire.write(0x08);
  uint8_t e = Wire.endTransmission();
  result("P-2", e == 0, "ret=" + String(e));

  // P-3: absent address
  Wire.beginTransmission(0x3f);
  Wire.write(0x01);
  e = Wire.endTransmission();
  // Core 3.3.12 + IDF i2c_master: a NACK (ACK_ERR interrupt) in a non-empty write is reported as
  // ESP_ERR_INVALID_STATE, which Wire maps to 4 (Wire.cpp endTransmission). Measured in the
  // DebugLevel=error build: "i2c_master_transmit failed: [259] ESP_ERR_INVALID_STATE".
  result("P-3", e == 4, "ret=" + String(e));

  // P-4: data-byte NACK (0x50 NACKs data byte 0xEE)
  Wire.beginTransmission(0x50);
  Wire.write(0x10);
  Wire.write(0xee);
  e = Wire.endTransmission();
  result("P-4", e == 4, "ret=" + String(e));  // same driver path as P-3

  // P-5: set pointer 0x10, then read 4 bytes
  Wire.beginTransmission(0x50);
  Wire.write(0x10);
  e = Wire.endTransmission();
  uint8_t n = Wire.requestFrom((uint8_t)0x50, (uint8_t)4);
  String d = "setptr=" + String(e) + " n=" + String(n) + " bytes=";
  bool ok = e == 0 && n == 4;
  for (int i = 0; i < 4; i++) {
    int v = Wire.read();
    d += String(v, HEX) + ",";
    ok = ok && v == expectReg(0x10 + i);
  }
  result("P-5", ok, d);

  // P-6: repeated START: write pointer 0x05 without STOP, then read 2
  Wire.beginTransmission(0x50);
  Wire.write(0x05);
  e = Wire.endTransmission(false);
  n = Wire.requestFrom((uint8_t)0x50, (uint8_t)2);
  int a = Wire.read(), b = Wire.read();
  result("P-6", e == 0 && n == 2 && a == expectReg(5) && b == expectReg(6),
         "ret=" + String(e) + " n=" + String(n) + " " + String(a, HEX) + "," + String(b, HEX));

  // P-7: 100-byte write (pointer + 99 data) then read the 99 back
  Wire.beginTransmission(0x50);
  Wire.write(0x20);
  for (int k = 0; k < 99; k++) Wire.write((uint8_t)((k * 7 + 1) & 0xff));
  e = Wire.endTransmission();
  Wire.beginTransmission(0x50);
  Wire.write(0x20);
  uint8_t e2 = Wire.endTransmission();
  n = Wire.requestFrom((uint8_t)0x50, (uint8_t)99);
  int bad = 0;
  for (int k = 0; k < 99; k++)
    if (Wire.read() != ((k * 7 + 1) & 0xff)) bad++;
  result("P-7", e == 0 && e2 == 0 && n == 99 && bad == 0,
         "wr=" + String(e) + " ptr=" + String(e2) + " n=" + String(n) + " bad=" + String(bad));

  // P-8: scan
  String found;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) found += String(addr, HEX) + " ";
  }
  found.trim();
  result("P-8", found == "27 50", "acks=[" + found + "]");

  // P-9: HD44780 4-bit init (datasheet Fig. 24) + "Hello"
  delay(50);
  lcdNibble(0x3, 0);
  delay(5);
  lcdNibble(0x3, 0);
  delayMicroseconds(150);
  lcdNibble(0x3, 0);
  lcdNibble(0x2, 0);
  lcdByte(0x28, 0);  // 4-bit, 2 lines
  lcdByte(0x0c, 0);  // display on
  lcdByte(0x01, 0);  // clear
  delay(2);
  lcdByte(0x06, 0);  // entry: increment
  const char *msg = "Hello";
  for (const char *p = msg; *p; p++) lcdByte((uint8_t)*p, 1);
  result("P-9", true, "sent (decoded offline from the target log)");

  Serial.println("PROBE-END");
}

void loop() { delay(1000); }
