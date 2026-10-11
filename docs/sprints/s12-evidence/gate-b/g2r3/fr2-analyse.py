#!/usr/bin/env python3
"""G-2 round 3: analyse zz-fr2 output (E1 gap map, E2 pulseIn sweep, E3 HC-SR04 trace)."""
import json, re, sys, os, statistics as st
from collections import defaultdict

D = sys.argv[1]
HZ = 240  # cycles per us
out = {}


def ph(ns):  # phase within the simulated millisecond, us
    return (ns % 1_000_000) / 1000


def load(n):
    p = os.path.join(D, n)
    return json.load(open(p)) if os.path.exists(p) else None


# ---- E1: lateness of every edge vs its phase --------------------------------------------------
for name in ['edge1', 'edge0']:
    d = load(f'e1-{name}.json')
    if not d:
        continue
    pulses = [(int(p['rise']), int(p['fall'])) for p in d['pulses']]
    caps = []
    cur = None
    for line in d['serial'].splitlines():
        m = re.match(r'C (\d+)', line)
        if m:
            cur = []
            caps.append(cur)
            continue
        m = re.match(r'e (\d) (\d+)', line)
        if m and cur is not None:
            cur.append((int(m[1]), int(m[2])))
    rows = []
    bad = []
    for gi, idx in enumerate(d['groups']):
        if gi >= len(caps) or len(caps[gi]) != 2 * len(idx):
            bad.append((gi, len(caps[gi]) if gi < len(caps) else None, 2 * len(idx)))
            continue
        sched = [t for i in idx for t in pulses[i]]
        cyc = [c for _, c in caps[gi]]
        t0 = sched[0]
        for s, c in zip(sched[1:], cyc[1:]):
            late = c / HZ * 1000 - (s - t0)  # ns, relative to the reference edge
            rows.append((ph(s), late, s))
    late_by_phase = sorted(rows)
    gap = [r for r in late_by_phase if r[1] > 200]
    normal = [r[1] for r in late_by_phase if r[1] <= 200]
    res = {
        'edges': len(rows),
        'groupsBad': bad,
        'normalLatenessNs': [min(normal), max(normal)] if normal else None,
        'lateEdges': len(gap),
        'gapPhaseUs': [gap[0][0], gap[-1][0]] if gap else None,
        'maxLateNs': max(r[1] for r in rows) if rows else None,
        'gapRows': [(round(p, 3), round(l), t) for p, l, t in gap],
    }
    # Linear fit of lateness in the gap: late = end - phase?
    if gap:
        ends = [p * 1000 + l for p, l, _ in gap]
        res['gapEndUs'] = [min(ends) / 1000, max(ends) / 1000]
    out[f'E1-{name}'] = res

# ---- E2: pulseIn error vs phase ---------------------------------------------------------------
def e2(name, run):
    d = load(f'e2-{name}-{run}.json')
    if not d:
        return None
    reads = [int(x) for x in re.findall(r'^P (\d+)\r?$', d['serial'], re.M)]
    meta = d['meta']
    pulses = [(int(p['rise']), int(p['fall'])) for p in d['pulses']]
    if len(reads) != len(meta):
        return {'error': f'{len(reads)} readings for {len(meta)} pulses'}
    rows = []
    for r, m, (ri, fa) in zip(reads, meta, pulses):
        w = (fa - ri) / 1000
        rows.append({
            'w': m['w'], 'kind': m['kind'], 'risePh': ph(ri), 'fallPh': ph(fa), 'read': r,
            'err': r - w, 'trunc': r - int(w),
        })
    return rows


for name in ['pulse1', 'pulse0']:
    runs = [e2(name, k) for k in (1, 2)]
    if not runs[0] or isinstance(runs[0], dict):
        out[f'E2-{name}'] = runs[0]
        continue
    same = runs[1] is not None and not isinstance(runs[1], dict) and [r['read'] for r in runs[0]] == [r['read'] for r in runs[1]]
    rows = runs[0]
    by = defaultdict(list)
    for r in rows:
        by[r['w']].append(r)
    res = {'deterministicAcrossRuns': same, 'byWidth': {}}
    for w, rs in by.items():
        def stats(sel):
            e = [r['err'] for r in sel]
            t = [r['trunc'] for r in sel]
            return {'n': len(sel), 'errUs': [round(min(e), 3), round(max(e), 3)] if e else None,
                    'readMinusTrunc': dict(sorted({k: t.count(k) for k in set(t)}.items()))}
        rep = [r['read'] for r in rs if r['kind'] == 'repeat']
        res['byWidth'][str(w)] = {
            'sweep': stats([r for r in rs if r['kind'] == 'sweep']),
            'riseInGap': stats([r for r in rs if r['kind'] == 'rise-gap']),
            'fallInGap': stats([r for r in rs if r['kind'] == 'fall-gap']),
            'repeatsAt418.84': rep,
        }
    res['worst'] = sorted(rows, key=lambda r: r['err'])[:6] + sorted(rows, key=lambda r: -r['err'])[:3]
    out[f'E2-{name}'] = res

# ---- E3: HC-SR04 traced pulseIn ---------------------------------------------------------------
for dist in ['0.1', '1', '4']:
    d = load(f'e3-{dist}m.json')
    if not d:
        continue
    # Trigger falls (pad 5 level 0 frames) and echo rise/fall (scheduled J on pad 18).
    falls, echoes = [], []
    for r in d['trace']:
        e = r['e']
        if r['k'] == 'pad' and isinstance(e, dict) and e.get('pad') == 5 and e.get('level') == 0 and e.get('drive') == 1:
            falls.append(int(e['vns']))
        for c in r.get('sched', []):
            if c.get('type') == 'J' and c.get('pad') == 18:
                echoes.append((int(c['vns']), c['level']))
    rises = [v for v, l in echoes if l == 1]
    fallsE = [v for v, l in echoes if l == 0]
    lines = re.findall(r'^T (\d+) (\d+) (\d+) (\d+)\r?$', d['serial'], re.M)
    rows = []
    for k, us, cr, cf in lines:
        k = int(k)
        if k >= len(falls) - 1 or k >= len(rises):
            continue
        # The first trigger fall frame belongs to setup's digitalWrite(LOW): skip it if present.
        rows.append((k, int(us), int(cr), int(cf)))
    # Align: trigger falls that are followed by an echo rise 200 us later.
    trig = [f for f in falls if any(abs(r - f - 200_000) < 1 for r in rises)]
    res = []
    for (k, us, cr, cf), tf, er, ef in zip(rows, trig, rises, fallsE):
        w = (ef - er) / 1000
        # Detection delays relative to the trigger-fall cycle read (constant offset eps cancels in
        # their difference): dr = cr/240 - (er - tf), df = cf/240 - (ef - tf)
        dr = cr / HZ - (er - tf) / 1000
        dfl = cf / HZ - (ef - tf) / 1000
        res.append({'k': k, 'read': us, 'widthUs': w, 'err': round(us - w, 3),
                    'trigPh': round(ph(tf), 3), 'risePh': round(ph(er), 3), 'fallPh': round(ph(ef), 3),
                    'dRiseUs': round(dr, 3), 'dFallUs': round(dfl, 3), 'diff': round(dfl - dr, 3)})
    out[f'E3-{dist}m'] = {'oracleUs': d['oracleUs'], 'n': len(res), 'rows': res}

json.dump(out, open(os.path.join(D, 'analysis.json'), 'w'), indent=1)
for k, v in out.items():
    s = json.dumps(v)
    print(k, s[:1500])

d = load('e4-dual.json')
if d:
    rows = [(int(a), int(b)) for a, b in re.findall(r'^L (\d) (\d+)\r?$', d['serial'], re.M)]
    idle = [c for p, c in rows if p == 0]
    busy = [c for p, c in rows if p == 1]
    e4 = {'idleCycles': idle, 'busyCycles': busy,
          'ratio': round(st.mean(busy) / st.mean(idle), 3) if idle and busy else None}
    print('E4', e4)
    out['E4'] = e4
    json.dump(out, open(os.path.join(D, 'analysis.json'), 'w'), indent=1)
