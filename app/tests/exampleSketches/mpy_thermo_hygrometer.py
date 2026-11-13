# TBI Lab example (MicroPython): ESP32 thermo-hygrometer with a DHT22 / AM2302 sensor.
#
# DATA (GPIO4) has a 10 kOhm pull-up to 3.3 V: the sensor and the ESP32 only ever pull the line low
# or release it. The interpreter's own dht module reads the sensor (AM2302 datasheet p.3-4): it
# holds DATA low to start, releases it, and times the sensor's 40-bit answer (humidity x10,
# temperature x10 with a sign bit, checksum).
# The sensor needs at least 2 s between reads (datasheet p.5); a read that gets no answer raises
# OSError (ETIMEDOUT), a corrupted answer an Exception ("checksum error").
import dht
from machine import Pin
import time

sensor = dht.DHT22(Pin(4))
time.sleep_ms(1500)

while True:
    try:
        sensor.measure()
        print("Temperature: %.1f C  Humidity: %.1f %%" % (sensor.temperature(), sensor.humidity()))
    except Exception as e:
        print("DHT22 read failed (%r)" % (e,))
    time.sleep_ms(2500)
