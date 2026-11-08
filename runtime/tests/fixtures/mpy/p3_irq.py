# Sprint 18 probe P3: GPIO interrupt (the host toggles GPIO4 at 3.0 s and 3.1 s).
from machine import Pin
import time
n = [0]
def cb(p):
    n[0] += 1
pin = Pin(4, Pin.IN)
pin.irq(cb, Pin.IRQ_RISING | Pin.IRQ_FALLING)
print('IRQ-ARMED', time.ticks_ms())
t = time.ticks_ms()
while time.ticks_diff(time.ticks_ms(), t) < 2500:
    time.sleep_ms(100)
print('IRQ-COUNT', n[0], 'LEVEL', pin.value())
