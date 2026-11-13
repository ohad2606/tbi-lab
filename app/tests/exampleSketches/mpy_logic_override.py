# TBI Lab example (MicroPython): an ESP32 output and a manual switch through a logic OR gate.
#
# GPIO18 drives input A of an SN74LVC1G32 OR gate; the toggle switch drives input B (a manual
# override). Each input has a 10 kOhm pull-down. The gate's output lights the LED through 220 Ohm
# and is read back on GPIO19. The gate runs from the bench supply at 3.0 V. The program blinks
# GPIO18 and prints what the gate's output really is (the same behaviour as the Arduino sketch).
from machine import Pin
import time

a_pin = Pin(18, Pin.OUT, value=0)
y_pin = Pin(19, Pin.IN)

a = 0
while True:
    a = 1 - a
    a_pin.value(a)
    y = y_pin.value()
    print("A=%d Y=%d%s" % (a, y, " (switch override)" if (not a and y) else ""))
    time.sleep_ms(1000)
