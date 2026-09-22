#!/usr/bin/env python3
"""
Root-cause probe: does host->QEMU traffic alone perturb the icount timeline?
Plain icount (no sync/inline), but the host writes a no-op line ("N") to the bridge socket every
5 ms of WALL time. The bridge ignores unknown lines, so any divergence comes from QEMU's main loop
reacting to host I/O, not from anything the device does.
"""
import json, os, socket, subprocess, sys, threading, time
QEMU = "/home/ubuntu/tbi-tools/src/a159-qemu/build/qemu-system-xtensa"
FLASH = "/home/ubuntu/tbi-tools/fw/arduino-gpio-proof-4mb.bin"
RESERVED = (1 << 4) | (1 << 16) | (1 << 27)
N = 24

def run(noise, idx):
    port = 23000 + int.from_bytes(os.urandom(2), "little") % 20000
    cmd = [QEMU, "-machine", "esp32", "-display", "none", "-drive", f"file={FLASH},if=mtd,format=raw",
           "-serial", "null", "-monitor", "none",
           "-chardev", f"socket,id=g,host=127.0.0.1,port={port},server=on,wait=on",
           "-device", f"tbi-gpio-bridge,chardev=g,ignore-mask={RESERVED},vclock=on",
           "-icount", "shift=3,sleep=off"]
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try: s = socket.create_connection(("127.0.0.1", port), timeout=2); break
        except OSError: time.sleep(0.1)
    stop = threading.Event()
    def noiser():
        while not stop.is_set():
            try: s.sendall(b"N\n")
            except OSError: return
            time.sleep(0.005)
    if noise: threading.Thread(target=noiser, daemon=True).start()
    s.settimeout(1.0); buf=b""; ev=[]; t0=time.time()
    while len(ev) < N and time.time()-t0 < 120:
        try:
            c = s.recv(4096)
            if not c: break
            buf += c
        except socket.timeout: continue
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1); f = line.decode().split()
            if f and f[0] == "O" and len(f) == 4: ev.append((int(f[1]), int(f[2]), int(f[3])))
    stop.set(); p.kill(); p.wait()
    return ev

for noise in (False, True):
    runs = [run(noise, i) for i in range(3)]
    div = [next((i for i,(a,b) in enumerate(zip(runs[0], r)) if a!=b), None) for r in runs[1:]]
    print(json.dumps({"host_traffic": noise, "identical": all(r == runs[0] for r in runs) and len(runs[0]) == N,
                      "first_divergence_index_vs_run1": div,
                      "first_app_gpio_s": [round(next((e[2] for e in r if e[0]==2), 0)/1e9, 6) for r in runs]}), flush=True)
