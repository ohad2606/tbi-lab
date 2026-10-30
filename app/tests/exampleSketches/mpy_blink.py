# TBI Lab example (MicroPython): blink an LED.
#
# GPIO2 drives a red LED through a 220 ohm resistor to GND. Pin.OUT makes the pin a push-pull
# output; value(1) drives it to 3.3 V, value(0) to 0 V. main.py runs once when the board starts,
# so the loop is part of the program.
from machine import Pin
import time

led = Pin(2, Pin.OUT)

while True:
    led.value(1)
    print("LED on")
    time.sleep_ms(500)
    led.value(0)
    print("LED off")
    time.sleep_ms(500)
