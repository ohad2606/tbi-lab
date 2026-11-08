# TBI Lab example (MicroPython): "Hello" on a 16x2 character LCD over I2C, without an LCD library.
#
# The LCD (HD44780 controller) sits behind a PCF8574 I2C backpack at address 0x27. Each byte
# written to the PCF8574 sets its eight outputs: P0 RS, P1 RW (always 0: write), P2 E,
# P3 backlight, P4-P7 the LCD's D4-D7. The LCD runs in 4-bit mode: every byte is sent as two
# nibbles, each latched by a pulse on E.
# Hardware I2C bus 0: SCL = GPIO22, SDA = GPIO21, 100 kHz (the PCF8574's rated clock); the bus
# pull-ups are the two 4.7 kOhm resistors to 3.3 V.
from machine import Pin, I2C
import time

LCD_ADDR = 0x27
RS = 0x01
EN = 0x04
BACKLIGHT = 0x08

i2c = I2C(0, scl=Pin(22), sda=Pin(21), freq=100000)


def expander_write(v):
    # Set the PCF8574 outputs (backlight always on).
    i2c.writeto(LCD_ADDR, bytes([v | BACKLIGHT]))


def nibble(high4, mode):
    # Latch one nibble (in the high four bits) with an E pulse.
    v = (high4 & 0xF0) | mode
    expander_write(v | EN)
    time.sleep_us(1)
    expander_write(v)
    time.sleep_us(50)


def send(value, mode):
    # A whole byte: high nibble first.
    nibble(value & 0xF0, mode)
    nibble((value << 4) & 0xF0, mode)


def command(c):
    send(c, 0)


def lcd_print(text):
    for ch in text:
        send(ord(ch), RS)


print("I2C scan:", [hex(a) for a in i2c.scan()])
# HD44780 initialisation by instruction, 4-bit interface (datasheet figure 24).
time.sleep_ms(50)
expander_write(0)
nibble(0x30, 0)
time.sleep_ms(5)
nibble(0x30, 0)
time.sleep_us(150)
nibble(0x30, 0)
nibble(0x20, 0)  # 4-bit interface from here on
command(0x28)  # function set: 4-bit, 2 lines, 5x8 dots
command(0x0C)  # display on, cursor off, blink off
command(0x01)  # clear display
time.sleep_ms(2)
command(0x06)  # entry mode: increment, no shift
command(0x80)  # line 1, column 1
lcd_print("Hello, ESP32!")
print("LCD ready")

start = time.ticks_ms()
while True:
    # Line 2: the uptime in seconds, padded to the 16 characters of the line.
    up = time.ticks_diff(time.ticks_ms(), start) // 1000
    command(0xC0)  # line 2, column 1
    lcd_print("{:<16}".format("Up: {} s".format(up)))
    time.sleep_ms(1000)
