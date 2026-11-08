# The display functions of the example, with the managed library's I2cLcd.
from machine_i2c_lcd import I2cLcd


def start(i2c):
    return I2cLcd(i2c, 0x27, 2, 16)


def show(lcd, line1, line2):
    lcd.clear()
    lcd.move_to(0, 0)
    lcd.putstr(line1)
    lcd.move_to(0, 1)
    lcd.putstr(line2)
