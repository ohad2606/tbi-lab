# TBI Lab example (MicroPython): sweep an SG90 servo with PWM.
#
# A servo reads the width of a pulse repeated every 20 ms (50 Hz): 1.0 ms is one end of its travel
# (0 degrees), 2.0 ms the other (180 degrees), 1.5 ms the middle. machine.PWM makes a 50 Hz signal
# on GPIO18; duty_u16 is the fraction of the 20 ms period, out of 65536.
# The servo runs from the 5 V bench supply; its ground is shared with the ESP32.
from machine import Pin, PWM
import time


def duty_for(us):
    """duty_u16 for a pulse of `us` microseconds in the 20 ms period."""
    return us * 65536 // 20000


servo = PWM(Pin(18), freq=50, duty_u16=duty_for(1500))

while True:
    for us in (1000, 2000, 1500):
        servo.duty_u16(duty_for(us))
        time.sleep_ms(1000)
