#!/usr/bin/env python3
"""
Sprint 1 timing-fidelity probe: where does simulated boot time go, and how does firmware-observed
time relate to QEMU virtual time?

Boot phases are measured with QEMU's GDB stub: the VM starts halted (-S), a breakpoint is placed on
each phase-entry address, and at each stop the bridge is asked for QEMU_CLOCK_VIRTUAL ("Q" -> "V n")
while the VM is stopped (so the reading is exact). Wall-clock time is recorded alongside.

After setup(), breakpoints are removed and the firmware's GPIO2 edges (virtual-time stamped by the
bridge) and serial report are collected.

Modes compare: real-time vs -icount shift=3,sleep=off, and icount with/without a do-nothing
periodic virtual timer ("keepalive") to test whether pending timer deadlines change boot duration.
Stdlib only. Not product code.
"""
import json, os, re, socket, subprocess, sys, time

QEMU = "/home/ubuntu/tbi-tools/src/a159-qemu/build/qemu-system-xtensa"
FLASH = os.environ.get("TBI_TIMING_FLASH", "/home/ubuntu/tbi-tools/fw/arduino-timing-4mb.bin")
SYMS = json.loads(os.environ.get("TBI_TIMING_SYMS", "{}"))
RESERVED = (1 << 4) | (1 << 16) | (1 << 27)
SCRATCH = "/tmp/claude-1001/-home-ubuntu/fb6dbe94-ad59-43ca-9ee7-50dc1d247eea/scratchpad"

def rsp_frame(p):
    return f"${p}#{sum(p.encode()) & 0xff:02x}".encode()

class Gdb:
    def __init__(self, port):
        for _ in range(100):
            try:
                self.s = socket.create_connection(("127.0.0.1", port), timeout=5); break
            except OSError:
                time.sleep(0.1)
        self.buf = b""
    def _read_packet(self, timeout):
        self.s.settimeout(timeout)
        while True:
            m = re.search(rb"\$([^#]*)#..", self.buf)
            if m:
                self.buf = self.buf[m.end():]
                self.s.sendall(b"+")
                return m.group(1).decode()
            chunk = self.s.recv(4096)
            if not chunk:
                raise EOFError
            self.buf += chunk
    def cmd(self, p, timeout=10):
        self.s.sendall(rsp_frame(p))
        return self._read_packet(timeout)
    def cont_until_stop(self, timeout):
        self.s.sendall(rsp_frame("c"))
        return self._read_packet(timeout)

class Bridge:
    def __init__(self, port):
        for _ in range(100):
            try:
                self.s = socket.create_connection(("127.0.0.1", port), timeout=5); break
            except OSError:
                time.sleep(0.1)
        self.buf = b""
        self.events = []
    def _lines(self, timeout):
        self.s.settimeout(timeout)
        try:
            chunk = self.s.recv(4096)
            if chunk:
                self.buf += chunk
        except socket.timeout:
            pass
        out = []
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            out.append(line.decode())
        return out
    def vclock(self):
        self.s.sendall(b"Q\n")
        deadline = time.time() + 5
        while time.time() < deadline:
            for l in self._lines(0.5):
                f = l.split()
                if f[0] == "V":
                    return int(f[1])
                if f[0] == "O" and len(f) == 4:
                    self.events.append((int(f[1]), int(f[2]), int(f[3])))
        raise TimeoutError("no V reply")
    def drain(self, secs):
        end = time.time() + secs
        while time.time() < end:
            for l in self._lines(0.5):
                f = l.split()
                if f and f[0] == "O" and len(f) == 4:
                    self.events.append((int(f[1]), int(f[2]), int(f[3])))

PHASES = ["rom_reset", "bootloader_entry", "app_entry_call_start_cpu0", "app_main", "setup"]

def run(mode, keepalive_us):
    gport = 24000 + int.from_bytes(os.urandom(2), "little") % 20000
    bport = gport + 1
    serial = f"{SCRATCH}/timing-serial-{mode}-{keepalive_us}.log"
    extra = ["-icount", "shift=3,sleep=off"] if mode == "icount" else []
    dev = f"tbi-gpio-bridge,chardev=g,ignore-mask={RESERVED},vclock=on"
    if keepalive_us:
        dev += f",keepalive-us={keepalive_us}"
    cmd = [QEMU, "-machine", "esp32", "-display", "none", "-monitor", "none", "-S",
           "-gdb", f"tcp:127.0.0.1:{gport}",
           "-drive", f"file={FLASH},if=mtd,format=raw", "-serial", f"file:{serial}",
           "-chardev", f"socket,id=g,host=127.0.0.1,port={bport},server=on,wait=off",
           "-device", dev, *extra]
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    time.sleep(1.0)
    br = Bridge(bport)
    g = Gdb(gport)
    g.cmd("?")
    marks = {"rom_reset": (br.vclock(), time.time())}
    wall0 = marks["rom_reset"][1]
    for name in PHASES[1:]:
        addr = SYMS[name]
        g.cmd(f"Z1,{addr:x},3")
        stop = g.cont_until_stop(600)
        marks[name] = (br.vclock(), time.time())
        g.cmd(f"z1,{addr:x},3")
    g.s.sendall(rsp_frame("c"))
    # let the sketch run to completion (serial reports TBI-TIMING-DONE)
    deadline = time.time() + 300
    while time.time() < deadline:
        br.drain(1.0)
        try:
            if "TBI-TIMING-DONE" in open(serial, errors="replace").read():
                break
        except FileNotFoundError:
            pass
    wall_done = time.time()
    p.kill(); p.wait()
    stderr = p.stderr.read().decode(errors="replace")
    ser = open(serial, errors="replace").read()
    report = {k: {"sim_s": round(v[0] / 1e9, 6), "wall_s": round(v[1] - wall0, 3)} for k, v in marks.items()}
    seg = {}
    for a, b in zip(PHASES, PHASES[1:]):
        seg[f"{a} -> {b}"] = {"sim_ms": round((marks[b][0] - marks[a][0]) / 1e6, 3),
                              "wall_ms": round((marks[b][1] - marks[a][1]) * 1000, 1)}
    g2 = [e for e in br.events if e[0] == 2]
    m = [e[2] for e in g2]
    markers = {}
    if len(m) >= 7:
        markers = {"delay1000_sim_ms": round((m[2] - m[1]) / 1e6, 3),
                   "busy1M_sim_ms": round((m[4] - m[3]) / 1e6, 3),
                   "timer_window_sim_ms": round((m[6] - m[5]) / 1e6, 3)}
    lines = [l for l in ser.splitlines() if re.match(r"(CPU_MHZ|AT_SETUP|DELAY1000|BUSY1M|TIMER100MS)", l)]
    warnings = [l for l in stderr.splitlines() if "icount" in l.lower() or "warn" in l.lower()][:3]
    return {"mode": mode, "keepalive_us": keepalive_us, "phases": report, "segments": seg,
            "gpio_marker_intervals": markers, "gpio2_edges": len(g2), "firmware_report": lines,
            "total_wall_s_to_done": round(wall_done - wall0, 1), "qemu_warnings": warnings}

if __name__ == "__main__":
    cfgs = [("realtime", 0), ("icount", 0), ("icount", 10000)]
    for mode, ka in cfgs:
        r = run(mode, ka)
        print(json.dumps(r), flush=True)
