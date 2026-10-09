/*
 * TBI Lab example: "Hello" on a 16x2 character LCD over I2C, without an LCD library.
 *
 * The LCD (HD44780 controller) sits behind a PCF8574 I2C backpack at address 0x27. Each byte
 * written to the PCF8574 sets its eight outputs: P0 RS, P1 RW (always 0: write), P2 E,
 * P3 backlight, P4-P7 the LCD's D4-D7. The LCD runs in 4-bit mode: every byte is sent as two
 * nibbles, each latched by a pulse on E.
 * SDA = GPIO21, SCL = GPIO22, 100 kHz; the bus pull-ups are the two 4.7 kOhm resistors to 3.3 V.
 */
#include <Wire.h>

const uint8_t LCD_ADDR = 0x27;
const uint8_t RS = 0x01;
const uint8_t EN = 0x04;
const uint8_t BACKLIGHT = 0x08;

/** Set the PCF8574 outputs (backlight always on). */
static void expanderWrite(uint8_t v) {
  Wire.beginTransmission(LCD_ADDR);
  Wire.write(v | BACKLIGHT);
  Wire.endTransmission();
}

/** Latch one nibble (in the high four bits) with an E pulse. */
static void nibble(uint8_t high4, uint8_t mode) {
  uint8_t v = (high4 & 0xF0) | mode;
  expanderWrite(v | EN);
  delayMicroseconds(1);
  expanderWrite(v);
  delayMicroseconds(50);
}

/** A whole byte: high nibble first. */
static void send(uint8_t value, uint8_t mode) {
  nibble(value & 0xF0, mode);
  nibble(value << 4, mode);
}

static void command(uint8_t c) { send(c, 0); }

static void lcdPrint(const char *s) {
  while (*s) send(*s++, RS);
}

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22, 100000);
  // HD44780 initialisation by instruction, 4-bit interface (datasheet figure 24).
  delay(50);
  expanderWrite(0);
  nibble(0x30, 0);
  delay(5);
  nibble(0x30, 0);
  delayMicroseconds(150);
  nibble(0x30, 0);
  nibble(0x20, 0);  // 4-bit interface from here on
  command(0x28);    // function set: 4-bit, 2 lines, 5x8 dots
  command(0x0C);    // display on, cursor off, blink off
  command(0x01);    // clear display
  delay(2);
  command(0x06);    // entry mode: increment, no shift
  command(0x80);    // line 1, column 1
  lcdPrint("Hello, ESP32!");
  Serial.println("LCD ready");
}

void loop() {
  // Line 2: the uptime in seconds, padded to the 16 characters of the line.
  char text[17];
  char line[17];
  snprintf(text, sizeof text, "Up: %lu s", millis() / 1000);
  snprintf(line, sizeof line, "%-16s", text);
  command(0xC0);  // line 2, column 1
  lcdPrint(line);
  delay(1000);
}
