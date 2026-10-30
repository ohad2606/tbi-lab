# TBI Lab example (MicroPython): a potentiometer read as a digital level.
#
# A 10 kOhm PTV09A potentiometer sits across the 3.3 V supply (end A to GND, end B to +3.3 V); its
# wiper goes to GPIO34, an input-only pin. The ESP32 reads the wiper as a DIGITAL level, using the
# datasheet thresholds: at or below V_IL = 0.825 V it reads 0, at or above V_IH = 2.475 V it reads
# 1. In between the datasheet guarantees nothing, and the simulator keeps the last level. GPIO4
# drives a red LED through 220 Ohm and follows the level. machine.ADC is not supported.
from machine import Pin
import time

wiper = Pin(34, Pin.IN)
led = Pin(4, Pin.OUT)

print("POT-READY")
last = None
while True:
    level = wiper.value()
    led.value(level)
    if level != last:
        print("LEVEL=%d" % level)
        last = level
    time.sleep_ms(5)
