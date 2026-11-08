#!/usr/bin/env python3
"""G-2 round 3: audit the s12-determinism streams. For each scenario and stream set:
reproducibility (fingerprints over the runs), electrical correctness (operating points and decoded
values against the physical expectation), timing fidelity (HC-SR04 readings against the oracle),
and the exact differences between sets (old host + old images / fixed host + committed images /
fixed host + proposed images)."""
import base64, glob, hashlib, json, os, re, sys

G = sys.argv[1]
SETS = [('oldhost', 'det-oldhost'), ('committed', 'det-committed'), ('proposed', 'det-proposed')]
SCEN = ['hcsr04-0.1m', 'hcsr04-1m', 'hcsr04-4m', 'dht22--10C-30RH', 'dht22-21.5C-55.2RH',
        'dht22-60C-95RH', 'lcd1602-hello']
# Oracle echo widths (engine hcsr04Echo, 20 degC): 2 d / c(T).
ORACLE = {'hcsr04-0.1m': 582.3772639916137, 'hcsr04-1m': 5823.772639916137,
          'hcsr04-4m': 4 * 5823.772639916137}
DHT = {'dht22--10C-30RH': (-100, 300), 'dht22-21.5C-55.2RH': (215, 552), 'dht22-60C-95RH': (600, 950)}


def fp(lines):
    return hashlib.sha256('\n'.join(lines).encode()).hexdigest()[:16]


def runs(d, sc):
    out = []
    for f in sorted(glob.glob(os.path.join(G, d, f'{sc}-*.jsonl')), key=lambda p: int(p.rsplit('-', 1)[1][:-6])):
        out.append([l for l in open(f).read().split('\n') if l])
    return out


def serial(evs):
    return ''.join(base64.b64decode(e['data']).decode('latin1') for e in evs if e['type'] == 'serial')


def electrical(sc, evs):
    """Physical checks on every published operating point."""
    issues, points = [], set()
    for e in evs:
        if e['type'] != 'electrical':
            continue
        o = e['outcome']
        if not o.get('ok'):
            issues.append(f"{e['simNs']}: not ok")
            continue
        pins = {p['gpio']: p for p in o['pins']}
        comp = o['components']
        if sc.startswith('hcsr04'):
            u = comp['U1']['state']['output']
            v18 = pins[18]['voltage']
            # ECHO behind R_out = 100 ohm (A-R2-6) into the 1 k + 2 k divider; GPIO18 at the 2 k.
            # The input's 50 nA (at 3.3 V) leakage is in parallel with the 2 k.
            r2 = 1 / (1 / 2000 + 50e-9 / 3.3)
            want = 5 * r2 / (100 + 1000 + r2) if u == 'high' else 0.0
            if abs(v18 - want) > 1e-6:
                issues.append(f"{e['simNs']}: echo {u} but GPIO18 {v18} V (want {want:.4f})")
            points.add((u, round(v18, 4), pins[5]['mode']))
        elif sc.startswith('dht22'):
            u = comp['U1']['state']['output']
            p4 = pins[4]
            # Released bus, pin an input: 10 k pull-up against the 50 nA (at 3.3 V) input leakage.
            rleak = 3.3 / 50e-9
            want = 3.3 * rleak / (rleak + 10_000)
            if p4['mode'] == 'input' and u == 'released' and abs(p4['voltage'] - want) > 1e-6:
                issues.append(f"{e['simNs']}: released bus at {p4['voltage']} V (want {want:.6f})")
            points.add((u, p4['mode'], round(p4['voltage'], 4)))
        else:
            st = comp['DS1']['state']
            points.add((st['displayOn'], st['backlight'], st['line1'], st['line2']))
    return issues, sorted(points, key=str)


def values(sc, evs):
    s = serial(evs)
    if sc.startswith('hcsr04'):
        r = [int(x) for x in re.findall(r'^D (\d+)', s, re.M)]
        w = ORACLE[sc]
        errs = [round(x - w, 3) for x in r]
        return {'readings': len(r), 'first': r[0] if r else None, 'firstErrUs': errs[0] if errs else None,
                'laterDistinct': sorted(set(r[1:])), 'oracleUs': round(w, 3),
                'withinT-R2-2(1us)': sum(abs(e) <= 1 for e in errs), 'outside': [(i, r[i], errs[i]) for i in range(len(r)) if abs(errs[i]) > 1]}
    if sc.startswith('dht22'):
        r = [(int(a), int(b)) for a, b in re.findall(r'^T (-?\d+) H (\d+)', s, re.M)]
        return {'readings': len(r), 'decoded': sorted(set(r)), 'expected': DHT[sc],
                'allExact': all(x == DHT[sc] for x in r) and bool(r)}
    texts = [p for p in electrical(sc, evs)[1]]
    return {'serial': re.findall(r'LCD[^\r\n]*', s), 'finalText': texts[-1] if texts else None}


def diff(a, b):
    """Event-level differences between two streams (by position of simNs+type)."""
    ka = [(e['simNs'], e['type'], json.dumps(e, sort_keys=True)) for e in a]
    kb = [(e['simNs'], e['type'], json.dumps(e, sort_keys=True)) for e in b]
    sa, sb = set(ka), set(kb)
    only_a = [(t, ty) for t, ty, j in ka if (t, ty, j) not in sb]
    only_b = [(t, ty) for t, ty, j in kb if (t, ty, j) not in sa]
    return {'common': len(sa & sb), 'onlyA': only_a, 'onlyB': only_b}


report = {}
for sc in SCEN:
    r = {}
    streams = {}
    for name, d in SETS:
        rs = runs(d, sc)
        if not rs:
            continue
        fps = [fp(x) for x in rs]
        evs = [json.loads(l) for l in rs[0]]
        streams[name] = evs
        iss, pts = electrical(sc, evs)
        r[name] = {'runs': len(rs), 'fingerprints': sorted(set(fps)), 'reproducible': len(set(fps)) == 1,
                   'events': len(evs), 'windows': len({e['simNs'] for e in evs}),
                   'electricalIssues': iss, 'operatingPoints': pts, 'values': values(sc, evs)}
    for a, b in [('oldhost', 'committed'), ('committed', 'proposed')]:
        if a in streams and b in streams:
            r[f'diff {a}->{b}'] = diff(streams[a], streams[b])
    report[sc] = r

json.dump(report, open(os.path.join(G, 'det-audit.json'), 'w'), indent=1, default=str)
for sc, r in report.items():
    print('#', sc)
    for k, v in r.items():
        if k.startswith('diff'):
            print(f"  {k}: common {v['common']}, only-old {len(v['onlyA'])} {v['onlyA'][:8]}, only-new {len(v['onlyB'])} {v['onlyB'][:8]}")
        else:
            print(f"  {k}: runs {v['runs']} fp {v['fingerprints']} repro {v['reproducible']} events {v['events']} windows {v['windows']} elecIssues {len(v['electricalIssues'])} points {len(v['operatingPoints'])}")
            print(f"     values {json.dumps(v['values'])[:400]}")
