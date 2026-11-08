#!/usr/bin/env python3
"""G-2 round 5: the E2 +0.91 us pulseIn reading (TbiPulseIn 9a722797, core 1, pulse #590).
Inputs (diagnostic run directory): rp-*.json / pf*.json job outputs, jobs-*.json, pf*.prof
(tbiprof with function-entry marks), pulsein.nm. Writes r5-analysis.json and r5-marks.txt."""
import bisect, json, math, re, sys, os
D, OUT = sys.argv[1], sys.argv[2]
L = 0.4534
ph = lambda ns: (ns % 1_000_000) / 1000
res = {}
for n in ['rp-full', 'rp-shift', 'rp-sweep', 'pf', 'pf2', 'pf3']:
    j = json.load(open(f'{D}/jobs-{n}.json'))[0]
    d = json.load(open(f'{D}/{n}.json'))
    reads = [int(x) for x in re.findall(r'^P (\d+)\r?$', d['serial'], re.M)]
    rows = []
    for r, p in zip(reads, j['pulses']):
        ri, fa = int(p['rise']), int(p['fall']); w = (fa - ri) / 1000
        rows.append({'risePh': round(ph(ri), 3), 'fallPh': round(ph(fa), 3), 'wUs': w, 'read': r,
                     'errUs': round(r - w, 3), 'aboveBound': r - math.floor(w + L), 'belowBound': math.floor(w - L) - r})
    if n == 'rp-full': rows = rows[588:591]
    res[n] = {'pulses': len(j['pulses']), 'readings': len(reads), 'rows': rows}
json.dump(res, open(f'{OUT}/r5-analysis.json', 'w'), indent=1)
nm = sorted((int(l.split()[0], 16), l.split()[2]) for l in open(f'{D}/pulsein.nm') if len(l.split()) == 3)
A = [a for a, _ in nm]
name = lambda pc: nm[bisect.bisect_right(A, pc) - 1][1]
with open(f'{OUT}/r5-marks.txt', 'w') as o:
    o.write('# Function entries (tbiprof marks) before core 1 detects the pulse fall (pc 0x400d43f5 = rsr.ccount after\n'
            '# the last WAIT_FOR_PIN_STATE). Columns: executed instructions relative to the detection (all vCPUs;\n'
            '# x 8 ns is approximate: the plugin counts whole TBs), vCPU, function.\n')
    for n, k, label in [('pf', 0, 'fall at 788.000 us: read 23294, in bound (core 0 tick entry runs AFTER the detection)'),
                        ('pf', 1, 'fall at 789.000 us: read 23296, +1 count (core 0 tick ENTRY, 187 insns, runs first)'),
                        ('pf3', 42, 'sweep pulse 42, fall at 790.100 us: read 23307, +10.9 us (WHOLE core 0 tick in one slice)')]:
        M = [(int(p, 16), int(v), int(t)) for p, v, t in re.findall(r'^M (\S+) (\d+) (\d+)$', open(f'{D}/{n}.prof').read(), re.M)]
        anc = [m for m in M if m[0] == 0x400d43f5][k][2]
        o.write(f'\n## {n} pulse {k}: {label}\n')
        for pc, v, t in M:
            if anc - 2000 <= t <= anc + 300:
                o.write(f'{t - anc:>7}  cpu{v}  {name(pc)}\n')
print(json.dumps({k: [r for r in v['rows'] if r['aboveBound'] > 0 or r['belowBound'] > 0][:5] for k, v in res.items()}, indent=0)[:3000])
