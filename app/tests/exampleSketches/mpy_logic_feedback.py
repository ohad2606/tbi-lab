# TBI Lab example (MicroPython): firmware drives logic, reads it back, and the logic drives a relay.
#
# GPIO18 (REQUEST) drives input A of an SN74LVC1G08 AND gate (U2) at 3.0 V; the PERMIT switch, with
# its 10 kOhm pull-down, drives input B. U2's output is read back on GPIO4 and drives a second AND
# gate (U3), which switches a 2N3904 and the relay: the relay's contact lights the LED.
#
# The program raises the request, reads the gate right after, and decides GRANTED (the gate answers
# HIGH) or DENIED (it stays LOW: the permit switch is open); then it drops the request and checks
# that the gate follows. It reports the microseconds between the write and the read.
#
# Try: open the PERMIT switch while it runs; change the 100 kOhm pull-down to 22 kOhm and see why
# the simulator refuses it (the ESP32 output level is relied on only up to 100 uA).
from machine import Pin
import time

feedback = Pin(4, Pin.IN)
request = Pin(18, Pin.OUT, value=0)

cycle = 0
granted = 0
denied = 0
while True:
    for req in (1, 0):
        t0 = time.ticks_us()
        request.value(req)
        fb = feedback.value()
        dt = time.ticks_diff(time.ticks_us(), t0)
        if req:
            if fb:
                granted += 1
                verdict = "GRANTED"
            else:
                denied += 1
                verdict = "DENIED"
        else:
            verdict = "FAULT" if fb else "released"
        print("#%d REQ=%d FB=%d %s granted=%d denied=%d us=%d" % (cycle, req, fb, verdict, granted, denied, dt))
        time.sleep_ms(400)
    cycle += 1
