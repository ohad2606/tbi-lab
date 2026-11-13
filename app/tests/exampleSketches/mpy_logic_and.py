# TBI Lab example (MicroPython): an ESP32 output and a push button through a logic AND gate.
#
# GPIO18 drives input A of an SN74LVC1G08 AND gate; the push button, with its 10 kOhm pull-down,
# drives input B. The gate's output lights the LED through 220 Ohm and is read back on GPIO4. The
# gate runs from the bench supply at 3.0 V. The program toggles GPIO18 every 500 ms and prints what
# GPIO4 reads right after each change (the same behaviour as the Arduino sketch).
from machine import Pin
import time

a_pin = Pin(18, Pin.OUT, value=0)
y_pin = Pin(4, Pin.IN)

a = 0
while True:
    a = 1 - a
    a_pin.value(a)
    y = y_pin.value()
    print("A=%d Y=%d" % (a, y))
    time.sleep_ms(500)
