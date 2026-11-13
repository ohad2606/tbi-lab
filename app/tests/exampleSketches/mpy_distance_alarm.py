# TBI Lab example (MicroPython): ESP32 distance alarm with an HC-SR04 ultrasonic module.
#
# Every 100 ms a 10 us HIGH pulse on TRIG (GPIO5) starts a measurement (HC-SR04 datasheet:
# "10 us TTL pulse"). The module answers with a HIGH pulse on ECHO whose width is the sound's
# round trip. ECHO reaches GPIO18 through a 1 kOhm / 2 kOhm divider: the module runs from 5 V,
# the ESP32 pin must stay within its 3.3 V supply range.
# machine.time_pulse_us(pin, 1, 30000) waits up to 30 ms for ECHO to go HIGH and returns how long it
# stays HIGH, in microseconds; a negative value means no echo within 30 ms (nothing in range).
# Distance in cm = pulse width in us / 58 (datasheet). The red LED on GPIO2 lights when something is
# closer than 20 cm.
from machine import Pin, time_pulse_us
import time

ALARM_CM = 20.0

trig = Pin(5, Pin.OUT, value=0)
echo = Pin(18, Pin.IN)
led = Pin(2, Pin.OUT, value=0)

while True:
    # The trigger pulse.
    trig.value(1)
    time.sleep_us(10)
    trig.value(0)
    # The echo pulse width in microseconds; negative when no echo starts and ends within 30 ms.
    us = time_pulse_us(echo, 1, 30000)
    if us < 0:
        print("No echo")
        led.value(0)
    else:
        cm = us / 58.0
        print("Distance: %.1f cm" % cm)
        led.value(1 if cm < ALARM_CM else 0)
    time.sleep_ms(100)
