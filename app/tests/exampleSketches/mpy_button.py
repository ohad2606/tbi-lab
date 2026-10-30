# TBI Lab example (MicroPython): a push button lights an LED.
#
# The button connects 3.3 V through 1 kOhm to GPIO34; a 10 kOhm resistor pulls GPIO34 down to GND,
# so the pin reads 0 while the button is released and 1 while it is held. GPIO34 is an input-only
# pin with no internal pull resistor, which is why the pull-down is a real resistor in the circuit.
# GPIO4 drives a red LED through 220 Ohm. The program reads the button every 10 ms.
from machine import Pin
import time

button = Pin(34, Pin.IN)
led = Pin(4, Pin.OUT)

last = None
while True:
    held = button.value()
    led.value(held)
    if held != last:
        print("button", "held" if held else "released")
        last = held
    time.sleep_ms(10)
