#!/usr/bin/env python3
"""E5: collapse a trace segment after the HIT marker into (cpu, function) runs with TB counts."""
import re, subprocess, sys
seg, elf, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
A2L = '/home/ubuntu/tbi-s12-rt-release/arduino/data/packages/esp32/tools/esp-x32/2601/bin/xtensa-esp32-elf-addr2line'
lines = open(seg).read().splitlines()
start = lines.index(next(l for l in lines if l.startswith('#### HIT')))
rows = []
for l in lines[start + 1:start + 1 + n]:
    m = re.match(r'Trace (\d+): \S+ \[[0-9a-f]+/0*([0-9a-f]+)/', l)
    rows.append(('x', l[:90]) if not m else (int(m[1]), m[2]))
pcs = sorted({r[1] for r in rows if r[0] != 'x'})
out = subprocess.run([A2L, '-f', '-e', elf] + ['0x' + p for p in pcs], capture_output=True, text=True).stdout.splitlines()
fn = {p: out[2 * i] for i, p in enumerate(pcs)}
cur, cnt = None, 0
for c, p in rows:
    key = (c, p if c == 'x' else fn[p])
    if key == cur:
        cnt += 1; continue
    if cur: print(f'{cnt:5d}  cpu{cur[0]}  {cur[1]}')
    cur, cnt = key, 1
print(f'{cnt:5d}  cpu{cur[0]}  {cur[1]}')
