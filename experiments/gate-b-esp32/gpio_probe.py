#!/usr/bin/env python3
"""
Gate B experiment: can classic ESP32 GPIO be driven by firmware and observed/controlled
from outside the emulator?

Runs real classic-ESP32 firmware under Espressif's QEMU fork, drives a GPIO from guest
firmware, then checks whether the resulting state is visible (a) to the guest itself and
(b) to the host through QEMU's monitor.

Host-side stdlib only: no virtualenv, no third-party packages, no changes to system Python.
"""

import argparse
import re
import socket
import subprocess
import sys
import time

# ESP32 (classic) GPIO register addresses, TRM v5.3 section 4.11 "Register Summary".
GPIO_OUT_REG = 0x3FF44004        # output state, R/W
GPIO_OUT_W1TS_REG = 0x3FF44008   # write-1-to-set output
GPIO_ENABLE_REG = 0x3FF44020     # output enable
GPIO_IN_REG = 0x3FF4403C         # input state, read-only on real hardware
TEST_GPIO = 2                    # GPIO2: broken out on virtually every DevKit board


def read_until(sock, marker, timeout=90.0):
    sock.settimeout(1.0)
    buf = b''
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            chunk = sock.recv(4096)
            if not chunk:
                time.sleep(0.05)
                continue
            buf += chunk
            if marker in buf:
                return buf.decode('utf-8', 'replace')
        except socket.timeout:
            continue
    return buf.decode('utf-8', 'replace')


def normalise(value):
    """REPL values come back as printed reprs; hex() yields a quoted string."""
    return value.strip().strip("'\"").strip()


def is_nonzero(value):
    v = normalise(value)
    if not v:
        return False
    try:
        return int(v, 16) != 0
    except ValueError:
        try:
            return int(v) != 0
        except ValueError:
            return False


def gdb_session(port, packets, timeout=10.0):
    """
    Minimal GDB remote-serial-protocol session against QEMU's gdbstub.

    Attaching to the stub halts the guest, so all packets are sent over ONE connection and
    the session ends with a detach ('D') to resume execution. Otherwise the guest would
    still be stopped when we next talk to its REPL.
    """
    def frame(packet):
        return f'${packet}#{sum(packet.encode()) & 0xFF:02x}'.encode()

    replies = []
    with socket.create_connection(('127.0.0.1', port), timeout=timeout) as sock:
        sock.settimeout(timeout)
        sock.sendall(b'+')
        for packet in [*packets, 'D']:
            sock.sendall(frame(packet))
            buf = b''
            deadline = time.time() + timeout
            while time.time() < deadline:
                try:
                    chunk = sock.recv(4096)
                except socket.timeout:
                    break
                if not chunk:
                    break
                buf += chunk
                if b'#' in buf.split(b'$', 1)[-1]:
                    break
            text = buf.decode('latin-1')
            m = re.search(r'\$([^#]*)#', text)
            replies.append(m.group(1) if m else text.strip())
            sock.sendall(b'+')
    return replies[:-1]


def repl(sock, command, timeout=30.0):
    """Send one REPL line, return whatever the guest printed for it."""
    sock.sendall(command.encode() + b'\r\n')
    out = read_until(sock, b'>>> ', timeout)
    lines = [ln.strip() for ln in out.splitlines()]
    # Drop the echoed command and the trailing prompt.
    body = [ln for ln in lines if ln and ln != command.strip() and not ln.startswith('>>>')]
    return '\n'.join(body)


def monitor(sock, command, timeout=10.0):
    sock.sendall(command.encode() + b'\n')
    return read_until(sock, b'(qemu)', timeout)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--qemu', required=True)
    ap.add_argument('--flash', required=True)
    ap.add_argument('--serial-port', type=int, default=5555)
    ap.add_argument('--monitor-port', type=int, default=5556)
    ap.add_argument('--gdb-port', type=int, default=5557)
    args = ap.parse_args()

    proc = subprocess.Popen(
        [
            args.qemu, '-machine', 'esp32', '-display', 'none',
            '-drive', f'file={args.flash},if=mtd,format=raw',
            '-serial', f'tcp::{args.serial_port},server,nowait',
            '-monitor', f'tcp::{args.monitor_port},server,nowait',
            '-gdb', f'tcp::{args.gdb_port},server,nowait',
        ],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    results = {}
    try:
        time.sleep(2)
        ser = socket.create_connection(('127.0.0.1', args.serial_port), timeout=30)
        mon = socket.create_connection(('127.0.0.1', args.monitor_port), timeout=30)
        read_until(mon, b'(qemu)', 15)

        boot = read_until(ser, b'>>> ', 120)
        print('=== guest boot log ===')
        print(boot.strip()[-600:])
        if '>>>' not in boot:
            print('\nFAIL: firmware did not reach a REPL prompt', file=sys.stderr)
            return 2
        results['firmware_executes'] = True
        m = re.search(r'MicroPython \S+ on \S+; ([^\r\n]+)', boot)
        results['firmware_banner'] = m.group(1).strip() if m else 'unknown'

        print('\n=== GPIO experiment ===')
        repl(ser, 'import machine')
        results['gpio_out_before'] = repl(ser, f'hex(machine.mem32[{GPIO_OUT_REG}])')
        results['gpio_in_before'] = repl(ser, f'hex(machine.mem32[{GPIO_IN_REG}])')

        # 1. Drive the pin through the normal firmware API.
        repl(ser, f'p = machine.Pin({TEST_GPIO}, machine.Pin.OUT)')
        repl(ser, 'p.value(1)')
        results['gpio_out_after_api'] = repl(ser, f'hex(machine.mem32[{GPIO_OUT_REG}])')
        results['gpio_enable_after_api'] = repl(ser, f'hex(machine.mem32[{GPIO_ENABLE_REG}])')
        results['pin_value_readback'] = repl(ser, 'p.value()')

        # 2. Drive it by writing the hardware register directly, bypassing the driver.
        repl(ser, f'machine.mem32[{GPIO_OUT_W1TS_REG}] = {1 << TEST_GPIO}')
        results['gpio_out_after_w1ts'] = repl(ser, f'hex(machine.mem32[{GPIO_OUT_REG}])')
        repl(ser, f'machine.mem32[{GPIO_OUT_REG}] = {1 << TEST_GPIO}')
        results['gpio_out_after_direct'] = repl(ser, f'hex(machine.mem32[{GPIO_OUT_REG}])')

        # 3. Host-side observation of the same register through the QEMU monitor.
        out = monitor(mon, f'xp/1wx 0x{GPIO_OUT_REG:08x}')
        mm = re.findall(r'[0-9a-f]{8,16}:\s+(0x[0-9a-f]+)', out)
        results['host_observed_gpio_out'] = mm[-1] if mm else f'UNPARSED: {out.strip()[-80:]}'

        # 4. Can the host INJECT an input level? Attempt a host-side write to GPIO_IN
        #    through QEMU's gdbstub, then read the register back from inside the guest.
        write_word = f'{1 << TEST_GPIO:08x}'
        le_bytes = ''.join(reversed([write_word[i:i + 2] for i in range(0, 8, 2)]))
        write_reply, readback = gdb_session(
            args.gdb_port,
            [f'M{GPIO_IN_REG:x},4:{le_bytes}', f'm{GPIO_IN_REG:x},4'],
        )
        results['gdb_write_reply'] = write_reply
        results['gdb_host_readback'] = readback
        time.sleep(1)  # let the guest resume after the detach
        results['gpio_in_after_host_write'] = repl(ser, f'hex(machine.mem32[{GPIO_IN_REG}])')

        print('\n=== RESULTS ===')
        for k, v in results.items():
            print(f'{k:28s} = {v}')

        print('\n=== VERDICT ===')
        checks = {
            'firmware executes real classic-ESP32 code':
                results['firmware_executes'],
            'firmware-driven GPIO output retained (driver API)':
                is_nonzero(results['gpio_out_after_api']),
            'firmware-driven GPIO output retained (direct register write)':
                is_nonzero(results['gpio_out_after_direct']),
            'GPIO output enable retained':
                is_nonzero(results['gpio_enable_after_api']),
            'host can observe GPIO output state':
                is_nonzero(results['host_observed_gpio_out']),
            'host can inject a GPIO input level':
                is_nonzero(results['gpio_in_after_host_write']),
        }
        for label, ok in checks.items():
            print(f'{"PASS" if ok else "FAIL"}  {label}')

        gpio_usable = all(v for k, v in checks.items() if k != 'firmware executes real classic-ESP32 code')
        print()
        print('GPIO bidirectional bridge usable as-is:', gpio_usable)
        # Exit non-zero when GPIO is unusable so this cannot be mistaken for a pass.
        return 0 if gpio_usable else 1
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == '__main__':
    sys.exit(main())
