# Sprint 18 probe P1: GPIO blink and PWM duty steps, delivered as main.py in the filesystem image.
from machine import Pin, PWM
import time
print('MP-START', time.ticks_ms())
led = Pin(2, Pin.OUT)
for i in range(6):
    led.value(i % 2)
    time.sleep_ms(50)
p = PWM(Pin(18), freq=1000, duty_u16=8192)
for d in (16384, 32768, 49152):
    time.sleep_ms(20)
    p.duty_u16(d)
time.sleep_ms(20)
p.deinit()
print('MP-DONE', time.ticks_ms())
