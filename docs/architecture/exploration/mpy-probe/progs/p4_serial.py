# Sprint 18 probe P4: serial input integrity (the host sends 1000 bytes; we count what arrives).
import sys, time
print('SER-READY')
got = 0
crc = 0
t = time.ticks_ms()
while got < 1000 and time.ticks_diff(time.ticks_ms(), t) < 4000:
    c = sys.stdin.buffer.read(1)
    if c:
        got += 1
        crc = (crc * 31 + c[0]) & 0xFFFFFFFF
print('SER-GOT', got, crc)
