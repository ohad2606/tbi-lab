# TBI Lab example (MicroPython): an ESP32 watches a logic half adder and shows its sum.
#
# Two switches (A, B) feed a half adder built from four real single logic gates: an OR, a NAND
# and an AND make the sum bit S = A xor B, and a second AND makes the carry bit C = A and B.
# The ESP32 reads the switches on GPIO32/GPIO33 and the gates' outputs on GPIO34/GPIO35 (inputs
# only: the gates drive them, the ESP32 never drives the logic). It prints every new state and
# sets the brightness of the LED on GPIO18 from the number the adder computed (C S, in binary).
#
# Try: change the duty levels, print the truth table you have seen so far, or rebuild the adder
# from NAND gates only and check the ESP32 still agrees.
from machine import Pin, PWM
import time

a = Pin(32, Pin.IN)
b = Pin(33, Pin.IN)
s = Pin(34, Pin.IN)
c = Pin(35, Pin.IN)
led = PWM(Pin(18), freq=1000, duty_u16=2048)

# Brightness for the adder's sum 0, 1, 2 (never a duty of 0: see the mpy-fade example).
LEVELS = (2048, 24576, 63488)

last = None
while True:
    now = (a.value(), b.value(), s.value(), c.value())
    if now != last:
        total = 2 * now[3] + now[2]
        expected = now[0] + now[1]
        print("A=%d B=%d -> C=%d S=%d = %d" % (now[0], now[1], now[3], now[2], total),
              "ok" if total == expected else "MISMATCH")
        led.duty_u16(LEVELS[total])
        last = now
    time.sleep_ms(20)
