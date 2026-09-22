#!/usr/bin/env python3
"""
Root-cause test for the rare icount divergence (hypothesis: QEMU's main loop warps virtual time
from a stale instruction counter when both cores have just halted).

Configuration known to be deterministic when the host is quiet: plain -icount shift=3,sleep=off,
chardev bridge with vclock, no sync. Stress: a QMP client issues query-status every ~1 ms, which
keeps QEMU's main loop waking. A QMP status query does not touch the guest. If timelines diverge
only under stress, host main-loop activity -- not the guest or the bridge -- is the cause.
"""
import json, os, socket, subprocess, sys, threading, time
QEMU = os.environ.get("TBI_QEMU", "/home/ubuntu/tbi-tools/src/a159-qemu/build/qemu-system-xtensa")
FLASH = "/home/ubuntu/tbi-tools/fw/arduino-gpio-proof-4mb.bin"
RESERVED = (1 << 4) | (1 << 16) | (1 << 27)
N_EVENTS = int(os.environ.get("N_EVENTS", "14"))

def run(stress):
    base = 25000 + int.from_bytes(os.urandom(2), "little") % 20000
    cmd = [QEMU, "-machine", "esp32", "-display", "none", "-drive", f"file={FLASH},if=mtd,format=raw",
           "-serial", "null", "-monitor", "none",
           "-qmp", f"tcp:127.0.0.1:{base+1},server=on,wait=off",
           "-chardev", f"socket,id=g,host=127.0.0.1,port={base},server=on,wait=on",
           "-device", f"tbi-gpio-bridge,chardev=g,ignore-mask={RESERVED},vclock=on",
           "-icount", "shift=3,sleep=off"]
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try: s = socket.create_connection(("127.0.0.1", base), timeout=2); break
        except OSError: time.sleep(0.1)
    stop = threading.Event()
    def qmp_spam():
        for _ in range(100):
            try: q = socket.create_connection(("127.0.0.1", base + 1), timeout=2); break
            except OSError: time.sleep(0.05)
        else: return
        q.settimeout(0.5)
        try:
            q.recv(4096)
            q.sendall(b'{"execute":"qmp_capabilities"}\n')
            while not stop.is_set():
                q.sendall(b'{"execute":"query-status"}\n')
                try: q.recv(65536)
                except socket.timeout: pass
                time.sleep(0.001)
        except OSError:
            return
    if stress: threading.Thread(target=qmp_spam, daemon=True).start()
    s.settimeout(1.0); buf = b""; ev = []; t0 = time.time()
    while len(ev) < N_EVENTS and time.time() - t0 < 180:
        try:
            c = s.recv(4096)
            if not c: break
            buf += c
        except socket.timeout: continue
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1); f = line.decode().split()
            if f and f[0] == "O" and len(f) == 4: ev.append((int(f[1]), int(f[2]), int(f[3])))
    stop.set(); p.kill(); p.wait()
    return tuple(ev), round(time.time() - t0, 1)

if __name__ == "__main__":
    stress = sys.argv[1] == "stress"
    n = int(sys.argv[2])
    seqs = []
    for i in range(n):
        ev, wall = run(stress)
        seqs.append(ev)
        first_app = next((e[2] for e in ev if e[0] == 2), None)
        print(f"run {i+1}: events={len(ev)} firstGpio2={first_app} wall={wall}s", flush=True)
    distinct = len(set(seqs))
    print(json.dumps({"stress": stress, "runs": n, "distinct_timelines": distinct,
                      "all_identical": distinct == 1 and len(seqs[0]) == N_EVENTS}), flush=True)
