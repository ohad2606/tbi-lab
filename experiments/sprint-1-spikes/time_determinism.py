#!/usr/bin/env python3
"""
Sprint 1 spike: can the classic-ESP32 runtime give a DETERMINISTIC simulation-time contract?

Runs the Sprint 0 Arduino GPIO firmware (classic ESP32, esp32 machine) on the a159x36-based
runtime with the tbi-gpio-bridge `vclock=on` spike property, which stamps every GPIO event with
QEMU_CLOCK_VIRTUAL. Each timing mode runs twice; if the virtual timestamps of the first N GPIO
transitions are identical across runs, simulated time is reproducible in that mode.

Also samples the QEMU process's RSS and CPU while the firmware runs, for the resource model.

Stdlib only. Not product code.
"""
import os, socket, subprocess, sys, time, json

QEMU = os.environ.get("TBI_QEMU", "/home/ubuntu/tbi-tools/src/a159-qemu/build/qemu-system-xtensa")
FLASH = os.environ.get("TBI_ARDUINO_FLASH", "/home/ubuntu/tbi-tools/fw/arduino-gpio-proof-4mb.bin")
RESERVED = (1 << 4) | (1 << 16) | (1 << 27)
N_EVENTS = 24
CLK = os.sysconf("SC_CLK_TCK")

MODES = {
    "realtime (Sprint 0 default)": [],
    "icount shift=3 sleep=off": ["-icount", "shift=3,sleep=off"],
    "icount shift=3 sleep=on": ["-icount", "shift=3,sleep=on"],
}

def proc_stats(pid):
    with open(f"/proc/{pid}/stat") as f:
        fields = f.read().split(") ")[1].split()
    ticks = int(fields[11]) + int(fields[12])
    with open(f"/proc/{pid}/status") as f:
        rss = next(int(l.split()[1]) for l in f if l.startswith("VmRSS:"))
    return ticks, rss

def run(extra, run_idx):
    port = 23000 + int.from_bytes(os.urandom(2), "little") % 20000
    serial_log = f"/tmp/claude-1001/-home-ubuntu/fb6dbe94-ad59-43ca-9ee7-50dc1d247eea/scratchpad/s1-serial-{run_idx}.log"
    cmd = [QEMU, "-machine", "esp32", "-display", "none",
           "-drive", f"file={FLASH},if=mtd,format=raw",
           "-serial", f"file:{serial_log}", "-monitor", "none",
           "-chardev", f"socket,id=g,host=127.0.0.1,port={port},server=on,wait=on",
           "-device", f"tbi-gpio-bridge,chardev=g,ignore-mask={RESERVED},vclock=on", *extra]
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    sock = None
    for _ in range(100):
        try:
            sock = socket.create_connection(("127.0.0.1", port), timeout=2); break
        except OSError:
            time.sleep(0.1)
    if sock is None:
        p.kill(); return {"error": "could not connect", "stderr": p.stderr.read().decode()[-400:]}
    t0 = time.time(); ticks0, _ = proc_stats(p.pid)
    sock.settimeout(1.0)
    buf, events, peak_rss = b"", [], 0
    deadline = t0 + 60
    while len(events) < N_EVENTS and time.time() < deadline:
        try:
            chunk = sock.recv(4096)
            if not chunk: break
            buf += chunk
        except socket.timeout:
            pass
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            parts = line.decode().split()
            if parts and parts[0] == "O" and len(parts) == 4:
                events.append((int(parts[1]), int(parts[2]), int(parts[3])))
        try:
            peak_rss = max(peak_rss, proc_stats(p.pid)[1])
        except FileNotFoundError:
            break
    wall = time.time() - t0
    try:
        ticks1, rss = proc_stats(p.pid); peak_rss = max(peak_rss, rss)
    except FileNotFoundError:
        ticks1 = ticks0
    p.kill(); p.wait()
    last_v = events[-1][2] if events else 0
    return {"events": events, "wall_s": round(wall, 2), "cpu_s": round((ticks1 - ticks0) / CLK, 2),
            "peak_rss_mb": round(peak_rss / 1024, 1), "virtual_s_covered": round(last_v / 1e9, 3)}

def main():
    report = {}
    idx = 0
    for name, extra in MODES.items():
        runs = []
        for _ in range(2):
            idx += 1
            runs.append(run(extra, idx))
        a, b = runs
        same = a.get("events") == b.get("events") and len(a.get("events", [])) == N_EVENTS
        deltas = []
        if a.get("events") and b.get("events"):
            deltas = [abs(x[2] - y[2]) for x, y in zip(a["events"], b["events"])]
        report[name] = {
            "identical_virtual_timestamps": same,
            "events_captured": [len(r.get("events", [])) for r in runs],
            "max_timestamp_divergence_us": round(max(deltas) / 1000, 1) if deltas else None,
            "first_events_run1": a.get("events", [])[:6],
            "virtual_s_covered": [r.get("virtual_s_covered") for r in runs],
            "wall_s": [r.get("wall_s") for r in runs],
            "cpu_s": [r.get("cpu_s") for r in runs],
            "peak_rss_mb": [r.get("peak_rss_mb") for r in runs],
            "errors": [r.get("error") for r in runs if r.get("error")],
        }
        print(f"--- {name} ---", flush=True)
        print(json.dumps(report[name], indent=1), flush=True)
    return 0

if __name__ == "__main__":
    sys.exit(main())
