#include <Arduino.h>
#include <LiquidCrystal_PCF8574.h>
#include "display.h"

static LiquidCrystal_PCF8574 lcd(0x27);

void displayBegin() {
  lcd.begin(16, 2);
  lcd.setBacklight(255);
  lcd.clear();
}

void displayShow(const char *line1, const char *line2) {
  lcd.home();
  lcd.setCursor(0, 0);
  lcd.print(line1);
  lcd.setCursor(0, 1);
  lcd.print(line2);
}
