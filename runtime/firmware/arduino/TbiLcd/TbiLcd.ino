/*
 * Sprint 12 runtime test firmware (R3, I2C LCD 16x2 on a PCF8574 backpack at 0x27). Not a
 * product artifact. Raw Wire writes, no LCD library (D-3). SDA GPIO21, SCL GPIO22, 100 kHz.
 * Writes "Hello, ESP32!" on line 1 and "T=21.5C" on line 2, prints "LCD <ret>" per step and
 * "LCD-DONE"; then switches the backlight off and prints "LCD-DARK".
 */
#include <Wire.h>

const uint8_t ADDR = 0x27;
uint8_t backlight = 0x08;  // P3

static uint8_t lcdWrite(uint8_t v) {
  Wire.beginTransmission(ADDR);
  Wire.write(v | backlight | 0x04);  // E high
  Wire.write((v | backlight) & ~0x04);  // E low: latch
  return Wire.endTransmission();
}
static uint8_t lcdNibble(uint8_t nibble, uint8_t rs) { return lcdWrite((nibble << 4) | rs); }
static uint8_t lcdByte(uint8_t b, uint8_t rs) {
  uint8_t e = lcdNibble(b >> 4, rs);
  return e ? e : lcdNibble(b & 0x0f, rs);
}
static void lcdPrint(const char *s) {
  while (*s) lcdByte((uint8_t)*s++, 1);
}

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22, 100000);
  delay(50);  // HD44780 power-on wait
  // 4-bit initialisation (HD44780U datasheet, Figure 24).
  Serial.printf("LCD %u\n", lcdNibble(0x3, 0));
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
  lcdPrint("Hello, ESP32!");
  lcdByte(0xc0, 0);  // line 2
  lcdPrint("T=21.5C");
  Serial.println("LCD-DONE");
  delay(200);
  backlight = 0;
  Serial.printf("LCD %u\n", lcdWrite(0));
  Serial.println("LCD-DARK");
}

void loop() { delay(1000); }
