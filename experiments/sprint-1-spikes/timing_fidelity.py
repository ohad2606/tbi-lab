#!/usr/bin/env python3
"""
Sprint 1 closure: timing fidelity of the classic-ESP32 runtime, measured, not assumed.

For each configuration it records, in QEMU virtual time AND wall time:
  - boot phases, via GDB-stub breakpoints (VM stopped at each, virtual clock read exactly):
      reset -> 2nd-stage bootloader entry -> app entry (call_start_cpu0) -> app_main -> setup()
  - the timing sketch's GPIO2 markers (raw edges; the first edge is pinMode's, then M1..M7):
      delay(1000) = M3-M2, 1M-iteration busy loop = M5-M4, 1 s hardware-timer window = M7-M6
  - the firmware's own report of the same intervals (millis, esp_timer, CPU cycles, timer ticks)

Configurations:
  realtime          : no icount (Sprint 0 style), chardev bridge
  icount            : -icount shift=3,sleep=off, chardev bridge
  icount+sync+tick  : closed-loop configuration: icount, synchronous bridge, 10 ms virtual tick
  icount+sync+tick1ms : the same with the recommended V1 1 ms tick
Stdlib only. Not product code.
"""
import hashlib, json, os, re, shutil, socket, subprocess, threading, time
from boot_timing import Gdb, rsp_frame

QEMU = "/home/ubuntu/tbi-tools/src/a159-qemu/build/qemu-system-xtensa"
FLASH = "/home/ubuntu/tbi-tools/fw/arduino-timing-4mb.bin"
# Pristine artifact hash. The guest can write flash (a panic writes the coredump partition, which
# changes later boots), so every run boots from a fresh scratch copy of a hash-verified image.
FLASH_SHA256 = "5ef344ff4a30bf85e976eea7e22a068512c8e6fb77d207a415d81c4aba3ddb34"
SYMS = {"bootloader_entry": 0x4008059C, "app_entry_call_start_cpu0": 0x40081A98,
        "app_main": 0x400D4890, "setup": 0x400D1760}
PHASES = ["reset", "bootloader_entry", "app_entry_call_start_cpu0", "app_main", "setup"]
RESERVED = (1 << 4) | (1 << 16) | (1 << 27)
SCRATCH = "/tmp/claude-1001/-home-ubuntu/fb6dbe94-ad59-43ca-9ee7-50dc1d247eea/scratchpad"

class ChardevBridge:
    """Chardev bridge: GPIO events (vclock) and on-demand virtual clock queries ("Q")."""
    def __init__(self, port):
        for _ in range(100):
            try: self.s = socket.create_connection(("127.0.0.1", port), timeout=5); break
            except OSError: time.sleep(0.1)
        self.buf = b""; self.events = []; self.lock = threading.Lock(); self.v = None
        self.s.settimeout(0.5)
        threading.Thread(target=self._reader, daemon=True).start()
    def _reader(self):
        while True:
            try:
                c = self.s.recv(4096)
                if not c: return
            except socket.timeout: continue
            except OSError: return
            self.buf += c
            while b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1); f = line.decode().split()
                if f and f[0] == "O" and len(f) == 4:
                    with self.lock: self.events.append((int(f[1]), int(f[2]), int(f[3])))
                elif f and f[0] == "V":
                    self.v = int(f[1])
    def vclock(self):
        self.v = None; self.s.sendall(b"Q\n"); t = time.time()
        while self.v is None and time.time() - t < 5: time.sleep(0.01)
        return self.v

class SyncServer:
    """Synchronous-bridge host: records GPIO events and answers every exchange with C."""
    def __init__(self):
        self.srv = socket.socket(); self.srv.bind(("127.0.0.1", 0)); self.srv.listen(1)
        self.port = self.srv.getsockname()[1]; self.events = []; self.lock = threading.Lock()
        threading.Thread(target=self._serve, daemon=True).start()
    def _serve(self):
        c, _ = self.srv.accept(); c.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1); buf = b""
        while True:
            try: d = c.recv(4096)
            except OSError: return
            if not d: return
            buf += d
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1); f = line.decode().split()
                if not f: continue
                if f[0] == "O" and len(f) >= 4:
                    with self.lock: self.events.append((int(f[1]), int(f[2]), int(f[3])))
                if f[0] in ("O", "D", "T"):
                    c.sendall(b"C\n")

def run(name, icount, sync_tick_us, use_gdb=True):
    gport = 26000 + int.from_bytes(os.urandom(2), "little") % 20000
    bport = gport + 1
    serial = f"{SCRATCH}/tf-{name.replace('+','_')}.log"
    if os.path.exists(serial): os.remove(serial)
    if hashlib.sha256(open(FLASH, "rb").read()).hexdigest() != FLASH_SHA256:
        raise SystemExit(f"{FLASH} does not match the pristine sha256 {FLASH_SHA256}")
    flash_copy = f"{SCRATCH}/tf-flash.bin"
    shutil.copyfile(FLASH, flash_copy)
    sync = SyncServer() if sync_tick_us is not None else None
    dev = f"tbi-gpio-bridge,chardev=g,ignore-mask={RESERVED},vclock=on"
    if sync: dev += f",syncport={sync.port},poll-us={sync_tick_us}"
    gdb_args = ["-S", "-gdb", f"tcp:127.0.0.1:{gport}"] if use_gdb else []
    cmd = [QEMU, "-machine", "esp32", "-display", "none", "-monitor", "none", *gdb_args,
           "-drive", f"file={flash_copy},if=mtd,format=raw",
           "-serial", f"file:{serial}",
           "-chardev", f"socket,id=g,host=127.0.0.1,port={bport},server=on,wait=off",
           "-device", dev] + (["-icount", "shift=3,sleep=off"] if icount else [])
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    time.sleep(1.0)
    br = ChardevBridge(bport)
    marks = {"reset": (0, time.time())}
    if use_gdb:
        g = Gdb(gport); g.cmd("?")
        marks = {"reset": (br.vclock(), time.time())}
        for ph in PHASES[1:]:
            a = SYMS[ph]
            g.cmd(f"Z1,{a:x},3"); g.cont_until_stop(900)
            marks[ph] = (br.vclock(), time.time()); g.cmd(f"z1,{a:x},3")
        g.s.sendall(rsp_frame("c"))
    deadline = time.time() + 900
    while time.time() < deadline:
        time.sleep(1)
        try:
            if "TBI-TIMING-DONE" in open(serial, errors="replace").read(): break
        except FileNotFoundError: pass
    t_done = time.time()
    p.kill(); p.wait()
    src = sync.events if sync else br.events
    e = [ev[2] for ev in src if ev[0] == 2]
    fw = [l for l in open(serial, errors="replace").read().splitlines()
          if re.match(r"(CPU_MHZ|AT_SETUP|DELAY1000|BUSY1M|TIMER100MS|TBI-TIMING-DONE)", l)]
    t0 = marks["reset"][1]
    if not use_gdb:
        marks["setup"] = (None, t0)
        wall_total = round(t_done - t0, 1)
    out = {"config": name + ("" if use_gdb else " (no gdb)"),
           "segments_ms": ({f"{a} -> {b}": {"sim": round((marks[b][0] - marks[a][0]) / 1e6, 3),
                                           "wall": round((marks[b][1] - marks[a][1]) * 1e3, 1)}
                           for a, b in zip(PHASES, PHASES[1:])} if use_gdb else {}),
           "first_gpio2_edge_sim_s": None,
           "gpio2_edges": len(e), "finished": any("TBI-TIMING-DONE" in l for l in fw),
           "firmware": fw, "wall_s_setup_to_done": round(t_done - marks["setup"][1], 1)}
    if e: out["first_gpio2_edge_sim_s"] = round(e[0] / 1e9, 6)
    if len(e) >= 8:
        out["virtual_intervals_ms"] = {"delay1000": round((e[3] - e[2]) / 1e6, 3),
                                       "busy_1M_iterations": round((e[5] - e[4]) / 1e6, 3),
                                       "timer_window": round((e[7] - e[6]) / 1e6, 3)}
    return out

if __name__ == "__main__":
    import sys
    cfgs = {"realtime": (False, None), "icount": (True, None), "icount+sync+tick": (True, 10000), "icount+sync+tick1ms": (True, 1000)}
    args = sys.argv[1:] or list(cfgs)
    nogdb = "--no-gdb" in args
    for name in [a for a in args if a != "--no-gdb"]:
        print(json.dumps(run(name, *cfgs[name], use_gdb=not nogdb)), flush=True)
