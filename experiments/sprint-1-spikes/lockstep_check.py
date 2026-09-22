#!/usr/bin/env python3
"""
Sprint 1 spike: does a LOCKSTEP bridge make the MCU <-> electrical loop deterministic?

With tbi-gpio-bridge sync=on, the VM pauses after every GPIO event and resumes only when the
host sends "C". The host plays the role of the co-located solver: on each GPIO2 transition it
computes an input level for GPIO5 and injects it BEFORE resuming. Under -icount (sleep=off)
virtual time is frozen while paused, so the injection should land at exactly the virtual time
of the triggering event, identically on every run.

The host's response function here is a pure function (GPIO5 = NOT GPIO2). The real Gate A
solver is also pure and was shown bit-identical across runs in Sprint 0; this spike tests the
TIMING contract, not the physics.
"""
import json, os, socket, subprocess, sys, time

QEMU = "/home/ubuntu/tbi-tools/src/a159-qemu/build/qemu-system-xtensa"
FLASH = "/home/ubuntu/tbi-tools/fw/arduino-gpio-proof-4mb.bin"
RESERVED = (1 << 4) | (1 << 16) | (1 << 27)
TARGET_ACKS = 12
SCRATCH = "/tmp/claude-1001/-home-ubuntu/fb6dbe94-ad59-43ca-9ee7-50dc1d247eea/scratchpad"

def run(icount, idx, mode="sync"):
    port = 23000 + int.from_bytes(os.urandom(2), "little") % 20000
    serial_log = f"{SCRATCH}/lockstep-serial-{idx}.log"
    extra = ["-icount", "shift=3,sleep=off"] if icount else []
    cmd = [QEMU, "-machine", "esp32", "-display", "none",
           "-drive", f"file={FLASH},if=mtd,format=raw",
           "-serial", f"file:{serial_log}", "-monitor", "none",
           "-chardev", f"socket,id=g,host=127.0.0.1,port={port},server=on,wait=on",
           "-device", f"tbi-gpio-bridge,chardev=g,ignore-mask={RESERVED},vclock=on,{mode}=on", *extra]
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    sock = None
    for _ in range(100):
        try:
            sock = socket.create_connection(("127.0.0.1", port), timeout=2); break
        except OSError:
            time.sleep(0.1)
    sock.settimeout(1.0)
    t0 = time.time()
    buf, events, acks, pauses = b"", [], [], 0
    while len(acks) < TARGET_ACKS and time.time() - t0 < 120:
        try:
            chunk = sock.recv(4096)
            if not chunk: break
            buf += chunk
        except socket.timeout:
            continue
        reply = []
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            f = line.decode().split()
            if not f: continue
            if f[0] in ("O", "D"):
                pauses += 1
                pin, level, vns = int(f[1]), int(f[2]), int(f[3])
                events.append((f[0], pin, level, vns))
                if f[0] == "O" and pin == 2:
                    reply.append(f"I 5 {1 - level}")      # the stand-in "solver" response
            elif f[0] == "A":
                acks.append((int(f[1]), int(f[2]), int(f[3])))
            if f[0] in ("O", "D"):
                reply.append("C")                           # resume after responding
        if reply:
            sock.sendall(("\n".join(reply) + "\n").encode())
    wall = time.time() - t0
    p.kill(); p.wait()
    serial = open(serial_log, errors="replace").read()
    trig = [e for e in events if e[0] == "O" and e[1] == 2]
    lag = [a[2] - t[3] for t, a in zip(trig, acks)]
    return {"acks": acks, "events": events, "wall_s": round(wall, 2), "pauses": pauses,
            "ack_minus_trigger_ns": lag[:6], "serial_IN_lines": [l for l in serial.splitlines() if l.startswith("IN=")][:4]}

def main():
    out = {}
    modes = sys.argv[1:] or ["sync"]
    for mode in modes:
      for icount in (True, False):
        name = f"{mode} + " + ("icount" if icount else "realtime")
        runs = [run(icount, i + (10 if icount else 20), mode) for i in range(3)]
        ref = runs[0]
        out[name] = {
            "ack_lag_ns_all_runs_max": max(max(r["ack_minus_trigger_ns"] or [0]) for r in runs),
            "acks_identical_across_runs": all(r["acks"] == ref["acks"] for r in runs) and len(ref["acks"]) == TARGET_ACKS,
            "events_identical_across_runs": all(r["events"] == ref["events"] for r in runs),
            "acks_captured": [len(r["acks"]) for r in runs],
            "first_acks_run1": ref["acks"][:4],
            "ack_minus_trigger_ns_run1": ref["ack_minus_trigger_ns"],
            "firmware_saw": ref["serial_IN_lines"],
            "wall_s": [r["wall_s"] for r in runs],
            "pauses": [r["pauses"] for r in runs],
        }
        print(name, json.dumps(out[name]), flush=True)

if __name__ == "__main__":
    main()
