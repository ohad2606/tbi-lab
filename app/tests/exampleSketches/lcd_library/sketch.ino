/*
 * TBI Lab example: a status display split over three files, using the managed library
 * LiquidCrystal_PCF8574 2.2.0 (BSD-3-Clause, Matthias Hertel) for the LCD1602 I2C module.
 * Nothing was installed: placing the display made the library available to this project.
 *
 * sketch.ino  - setup() and loop()
 * display.h   - the display functions this sketch calls
 * display.cpp - their implementation with the library (address 0x27, 16 x 2)
 *
 * The bus is the ESP32's default I2C pins (SDA GPIO21, SCL GPIO22) at the library's default
 * 100 kHz clock, the PCF8574's rating. The library only writes to the display.
 */
#include "display.h"

void setup() {
  Serial.begin(115200);
  displayBegin();
  displayShow("TBI Lab", "Library LCD");
  Serial.println("LCD-LIB-READY");
}

void loop() {
  delay(1000);
}
