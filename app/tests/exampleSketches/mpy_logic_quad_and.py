# TBI Lab example (MicroPython): two ESP32 outputs into a quad AND gate IC (SN74LVC08A).
#
# GPIO18 drives input 1A and GPIO19 input 1B of gate 1; its output 1Y lights LED D1 through 220 Ohm
# and also feeds input 2A of gate 2. The push button, with its 10 kOhm pull-down, drives input 2B,
# so LED D2 lights only while the button is held (2Y = 1Y AND button). Gates 3 and 4 are unused:
# their inputs are tied to GND. The IC runs from the bench supply at 3.0 V. (The same behaviour as
# the Arduino sketch.)
from machine import Pin
import time

Pin(18, Pin.OUT, value=1)
Pin(19, Pin.OUT, value=1)
print("1A=1 1B=1: D1 on; hold the button to light D2")

while True:
    time.sleep_ms(1000)
