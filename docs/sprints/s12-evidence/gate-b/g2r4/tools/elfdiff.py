#!/usr/bin/env python3
"""Canonical-firmware equivalence: compare two ELFs function by function. Code is compared with
addresses and literal-pool targets normalised, so a pure relocation is not a difference."""
import re, subprocess, sys
T = '/home/ubuntu/tbi-s12-rt-release/arduino/data/packages/esp32/tools/esp-x32/2601/bin/xtensa-esp32-elf-'

def syms(elf):
    out = subprocess.run([T + 'nm', '-S', '--defined-only', elf], capture_output=True, text=True).stdout
    d = {}
    for l in out.splitlines():
        p = l.split()
        if len(p) == 4 and p[2] in 'tTwW':
            d.setdefault(p[3], (int(p[0], 16), int(p[1], 16)))
    return d

def code(elf):
    """function name -> normalised instruction list"""
    out = subprocess.run([T + 'objdump', '-d', '--no-show-raw-insn', elf], capture_output=True, text=True).stdout
    fn, d = None, {}
    for l in out.splitlines():
        m = re.match(r'^[0-9a-f]+ <(.+)>:$', l)
        if m:
            fn = m[1]; d.setdefault(fn, []); continue
        m = re.match(r'^\s*[0-9a-f]+:\s+(.*)$', l)
        if m and fn:
            ins = re.sub(r'<[^>]*>', '<>', m[1])
            ins = re.sub(r'\b[0-9a-f]{8}\b', 'ADDR', ins)
            ins = re.sub(r'0x[0-9a-f]+', 'IMM', ins) if ins.split()[:1] in (['l32r'], ['movi']) else ins
            d[fn].append(ins)
    return d

a, b = sys.argv[1], sys.argv[2]
sa, sb = syms(a), syms(b)
ca, cb = code(a), code(b)
only_a = sorted(set(ca) - set(cb)); only_b = sorted(set(cb) - set(ca))
size = [(f, sa[f][1], sb[f][1]) for f in sorted(set(sa) & set(sb)) if sa[f][1] != sb[f][1]]
diff = [f for f in sorted(set(ca) & set(cb)) if ca[f] != cb[f]]
print(f'functions: {len(ca)} / {len(cb)}; only old {len(only_a)}, only new {len(only_b)}; size changed {len(size)}; normalised code differs {len(diff)}')
for f in only_a[:10]: print('  only old:', f)
for f in only_b[:10]: print('  only new:', f)
for f, x, y in size[:20]: print(f'  size {f}: {x} -> {y}')
for f in diff[:20]:
    A, B = ca[f], cb[f]
    k = next((i for i in range(min(len(A), len(B))) if A[i] != B[i]), min(len(A), len(B)))
    print(f'  code {f}: {len(A)} vs {len(B)} insns; first diff at {k}: {A[k] if k < len(A) else "-"} | {B[k] if k < len(B) else "-"}')
