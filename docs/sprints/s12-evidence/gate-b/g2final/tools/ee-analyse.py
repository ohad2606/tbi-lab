#!/usr/bin/env python3
"""G-2 final: TbiEdgeEcho (6ceb6ac3) polling latency and the lock-holder stall.
Inputs (diagnostic run dir): jobs-ee.json + ee-period.json (200-pulse phase sweep, 0.1 us steps),
ee-prof2.prof (tbiprof with function-entry marks incl. ROM and the spin-loop blocks 0x400882fe /
0x400882b1 of xPortEnterCriticalTimeout), edgeecho.nm. Writes ee-analysis.json, ee-stall-marks.txt."""
import bisect, collections, json, re, statistics, sys
D, OUT = sys.argv[1], sys.argv[2]
j = json.load(open(f'{D}/jobs-ee.json'))[0]; d = json.load(open(f'{D}/ee-period.json'))
E = [(int(a), int(b)) for a, b in re.findall(r'^E ([01]) (\d+)\r?$', d['serial'], re.M)]
rises = [u for l, u in E if l == 1]; falls = [u for l, u in E if l == 0]
R = [int(p['rise']) for p in j['pulses']]
lat = [u - r / 1000 for u, r in zip(rises, R)]; m = min(lat); lat = [round(x - m, 3) for x in lat]
flat = [f - (r + 1_000_000) / 1000 for f, r in zip(falls, R)]; fm = min(flat); flat = [round(x - fm, 3) for x in flat]
normal = [x for x in lat + flat if x < 20]
late = [{'pulse': k, 'riseNs': R[k], 'latencyUs': lat[k]} for k in range(len(R)) if lat[k] >= 20]
nm = sorted((int(l.split()[0], 16), l.split()[2]) for l in open(f'{D}/edgeecho.nm') if len(l.split()) == 3)
A = [a for a, _ in nm]
SPIN = (0x400882fe, 0x400882b1)
name = lambda pc: nm[bisect.bisect_right(A, pc) - 1][1] + ('@spin' if pc in SPIN else '')
loopA = [a for a, n in nm if n == '_Z4loopv'][0]
M = []
for line in open(f'{D}/ee-prof2.prof'):
    if line[0] == 'M':
        _, p, v, t = line.split(); M.append((int(p, 16), int(v), int(t)))
L = [t for p, v, t in M if p == loopA and v == 1 and t > 400_000_000]
gaps = [L[i + 1] - L[i] for i in range(len(L) - 1)]
big = max(range(len(gaps)), key=lambda i: gaps[i]); t0, g = L[big], gaps[big]
win = [(p, v, t) for p, v, t in M if t0 < t < t0 + g]
res = {
    'edges': len(E), 'pulses': len(R), 'lost': 2 * len(R) - len(E),
    'normalLatencyUs': [min(normal), max(normal)], 'normalEdges': len(normal),
    'lateRises': late,
    'loopInsnsMedian': statistics.median(gaps), 'loopIterationsPerSecondAt': None,
    'stall': {'loopGapInsns': g, 'medianLoopInsns': statistics.median(gaps),
              'entriesInGap': collections.Counter(f'{name(p)} cpu{v}' for p, v, t in win).most_common()},
}
json.dump(res, open(f'{OUT}/ee-analysis.json', 'w'), indent=1)
with open(f'{OUT}/ee-stall-marks.txt', 'w') as o:
    o.write('# TbiEdgeEcho, longest core-1 loop iteration (instructions relative to loop() entry; '
            'consecutive @spin entries collapsed with a count)\n')
    prev, cnt = None, 0
    for p, v, t in [x for x in M if t0 - 600 <= x[2] <= t0 + g + 700]:
        n = f'cpu{v} {name(p)}'
        if n == prev and n.endswith('@spin'): cnt += 1; continue
        if cnt: o.write(f'        ... {cnt} more spin iterations\n'); cnt = 0
        o.write(f'{t - t0:>7}  {n}\n'); prev = n
print(json.dumps({k: v for k, v in res.items() if k != 'stall'}), res['stall']['loopGapInsns'], res['stall']['entriesInGap'][:3])
