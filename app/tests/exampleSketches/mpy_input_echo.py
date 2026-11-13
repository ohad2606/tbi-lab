# TBI Lab example (MicroPython): copy the input GPIO34 to the output GPIO4.
#
# The MicroPython version of the Arduino InputEcho sketch, on the same circuits (switch input to LED
# output, the bench, the motion alarm, the RGB night light). GPIO34 is an input-only pin with no
# internal pull resistor: the circuit holds it (a pull-down resistor, the PIR sensor's output, the
# light-sensor divider). The program reads it every 5 ms, copies it to GPIO4 and prints each change.
# (The Arduino sketch also switches five unconnected outputs once at start-up, a self-check of the
# runtime; nothing is connected to them, so this program leaves them alone.)
from machine import Pin
import time

source = Pin(34, Pin.IN)
out = Pin(4, Pin.OUT, value=0)

last = -1
while True:
    level = source.value()
    if level != last:
        out.value(level)
        last = level
        print("ECHO34=%d" % level)
    time.sleep_ms(5)
