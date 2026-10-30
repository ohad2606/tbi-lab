# TBI Lab example (MicroPython): fade an LED with PWM.
#
# PWM drives GPIO18 with a 1 kHz signal (the ESP32's LEDC peripheral). duty_u16 (0-65535) sets
# how long each 1 ms period is high; the LED's average current, and so its brightness, follows it.
#
# The fade runs between 2048 and 63488, never 0: what a real ESP32 outputs at duty 0 is not
# verified yet, so the simulator refuses a duty of 0 that drives a load instead of guessing.
from machine import Pin, PWM
import time

pwm = PWM(Pin(18), freq=1000, duty_u16=2048)

while True:
    for duty in range(2048, 65536, 2048):
        pwm.duty_u16(duty)
        time.sleep_ms(20)
    for duty in range(63488, 0, -2048):
        pwm.duty_u16(duty)
        time.sleep_ms(20)
