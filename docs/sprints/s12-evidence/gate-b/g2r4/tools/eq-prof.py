#!/usr/bin/env python3
"""Canonical-firmware equivalence from tbiprof profiles: executed instructions per function, old vs
new image, same inputs. PCs are mapped with each image's own ELF (functions keep their names)."""
import bisect, collections, json, subprocess, sys
G = sys.argv[1]
T = '/home/ubuntu/tbi-s12-rt-release/arduino/data/packages/esp32/tools/esp-x32/2601/bin/xtensa-esp32-elf-'
ELF = {'old': '/home/ubuntu/tbi-s12-rt/build/fw-{0}/{0}.ino.elf', 'new': '/home/ubuntu/tbi-s12-rt-release/build/fw-{0}/{0}.ino.elf'}
OLD_R1 = '/home/ubuntu/tbi-s8-rt/build/fw-TbiR1Scan/TbiR1Scan.ino.elf'

def symtab(elf):
    out = subprocess.run([T + 'nm', '-n', '--defined-only', elf], capture_output=True, text=True).stdout
    s = [(int(p[0], 16), p[2]) for p in (l.split() for l in out.splitlines()) if len(p) == 3 and p[1] in 'tTwW']
    return [a for a, _ in s], [n for _, n in s]

def region(pc):
    if pc < 0x40070000: return 'ROM'
    if pc < 0x40080000: return 'bootloader'
    return None

def prof(path, elf):
    addrs, names = symtab(elf)
    per = collections.Counter(); per_cpu = collections.Counter(); slices = []
    for l in open(path):
        p = l.split()
        if p[0] == 'B':
            pc, n, c, cpu = int(p[1], 16), int(p[2]), int(p[3]), int(p[4])
            r = region(pc)
            f = r or names[max(0, bisect.bisect_right(addrs, pc) - 1)]
            per[f] += n * c; per_cpu[cpu] += n * c
        else:
            slices.append((int(p[1]), int(p[2])))
    return per, per_cpu, slices

def first_pad(name):
    d = json.load(open(f'{G}/{name}.json'))
    return d['pads'], d['serial']

res = {}
for n in json.load(open(f'{G}/pairs.json')):
    po, co, so = prof(f'{G}/eq-{n}-old.prof', OLD_R1 if n == 'TbiR1Scan' else ELF['old'].format(n))
    pn, cn, sn = prof(f'{G}/eq-{n}-new.prof', ELF['new'].format(n))
    padsO, serO = first_pad(f'eq-{n}-old'); padsN, serN = first_pad(f'eq-{n}-new')
    diffs = sorted(((f, po[f], pn[f], pn[f] - po[f]) for f in set(po) | set(pn) if po[f] != pn[f]), key=lambda x: -abs(x[3]))
    # first pad frame time per image, and the time difference of matching frames
    def parse(p): return [tuple(int(x) for x in s.split()) for s in p]
    a, b = parse(padsO), parse(padsN)
    same_content = [x[1:] for x in a] == [x[1:] for x in b]
    dts = [y[0] - x[0] for x, y in zip(a, b)]
    res[n] = {'insnsOld': dict(co), 'insnsNew': dict(cn), 'functionsDiffering': len(diffs), 'top': diffs[:12],
              'padFrames': [len(a), len(b)], 'padContentIdentical': same_content,
              'padDtNs': {'first': dts[:3], 'min': min(dts) if dts else None, 'max': max(dts) if dts else None},
              'serialIdentical': serO == serN}
    print(f'=== {n}: functions with different executed counts {len(diffs)}; pads {len(a)}/{len(b)} same content {same_content}; '
          f'dt first {dts[:2]} range [{res[n]["padDtNs"]["min"]},{res[n]["padDtNs"]["max"]}] ns; serial identical {serO == serN}')
    for f, x, y, d in diffs[:12]: print(f'   {f:45s} {x:>12} {y:>12} {d:+}')
json.dump(res, open(f'{G}/eq-prof.json', 'w'), indent=1)
