# TBI Lab example (MicroPython): a status display split over two files, using the managed library
# python_lcd (MIT, Dave Hylands; pinned commit 7affb0b) for the LCD1602 I2C module. Nothing was
# installed: placing the display made the library available to this project (in /lib).
#
# main.py    - opens the bus and shows the text
# display.py - the display functions, with the library's I2cLcd (address 0x27, 2 x 16)
#
# Hardware I2C bus 0: SCL GPIO22, SDA GPIO21, 100 kHz (the PCF8574's rating). The library only
# writes to the display.
from machine import I2C, Pin
import display

i2c = I2C(0, scl=Pin(22), sda=Pin(21), freq=100000)
lcd = display.start(i2c)
display.show(lcd, "TBI Lab", "MicroPython lib")
print("LCD-LIB-READY")
