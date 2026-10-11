#!/usr/bin/env python3
"""G-2 targeted validation: analyse TbiApiMatrix runs (idle / core-0 load) and the MicroPython
time_pulse_us run against the bridge's exact pad-frame times and the scheduled inputs."""
import collections, json, math, re, statistics as st, sys
G = sys.argv[1]
MS = 1_000_000
out = {}

def q(L, f): return L[min(len(L) - 1, int(f * (len(L) - 1)))]
def summ(L):
    L = sorted(L)
    return {'n': len(L), 'min': L[0], 'p50': q(L, .5), 'p90': q(L, .9), 'p99': q(L, .99), 'max': L[-1]} if L else None
def ph(v): return (v % MS) / 1000

for run in ['mx-idle', 'mx-load']:
    job = next(j for j in json.load(open(f'{G}/jobs-mx3.json')) if j['name'] == run)
    d = json.load(open(f'{G}/{run}.json'))
    pads = [tuple(int(x) for x in s.split()) for s in d['pads']]  # vns pad drive level
    ser = d['serial']
    vals = collections.defaultdict(dict)
    for tag, k, v in re.findall(r'^([CKPQU]) (\d+) (\d+)\r?$', ser, re.M): vals[tag][int(k)] = int(v)
    a0 = int(re.search(r'^A0 (\d+)', ser, re.M)[1])
    sched = [p for p in job['pulses'] if p['pad'] == 4]
    r = {}
    # ---- calibration: micros() -> bridge time
    p19 = [v for v, pad, dr, l in pads if pad == 19 and dr == 1]
    p19 = p19[1:]  # first frame: pinMode/digitalWrite LOW in setup
    offs = [p19[i] - vals['C'][i] * 1000 for i in range(20)]
    off = min(offs)  # micros() truncates: the smallest offset is closest to the true one (+ write latency)
    r['calOffsetNs'] = {'min': min(offs), 'max': max(offs)}
    # ---- A0: pulseIn polling loop period
    r['A0'] = {'iterations': a0, 'L_us': round(2000 / a0, 4), 'note': 'one WAIT_FOR_PIN_STATE iteration (+1 counter add), interrupts masked'}
    # ---- A1: output pulses on GPIO5: delayMicroseconds(w)
    p5 = [(v, l) for v, pad, dr, l in pads if pad == 5 and dr == 1]
    pulses5 = [(p5[i][0], p5[i + 1][0]) for i in range(len(p5) - 1) if p5[i][1] == 1 and p5[i + 1][1] == 0]
    a1 = [x for x in pulses5 if x[0] < (3000 + 556) * MS]
    a3 = [x for x in pulses5 if x[0] >= (4100 + 556) * MS]
    res = {}
    for gi, w in enumerate([2, 10, 50, 500]):
        g = a1[gi * 143:(gi + 1) * 143]
        err = [(f - s) / 1000 - w for s, f in g]
        big = [(round(ph(s), 1), round(e, 2)) for (s, f), e in zip(g, err) if e > 2]
        res[w] = {'errUs': summ([round(e, 3) for e in err]), 'over2us': len(big), 'over2usAt': big[:8]}
    r['A1 delayMicroseconds pulse width error'] = res
    # ---- A2: software tone half periods on GPIO19
    t19 = [(v, l) for v, pad, dr, l in pads if pad == 19 and dr == 1 and (3000 + 556) * MS <= v < (4050 + 556) * MS]
    hp = [(t19[i + 1][0] - t19[i][0]) / 1000 - 500 for i in range(len(t19) - 1)]
    r['A2 tone half-period error us'] = {**summ([round(x, 3) for x in hp]), 'over2us': sum(x > 2 for x in hp)}
    # ---- A3: delay(1)
    r['A3 delay(1) width us'] = summ([round((f - s) / 1000, 3) for s, f in a3])
    # ---- K: core 1's tick, as seen by micros(), in bridge time
    r['K tick phase (core 1, bridge us)'] = sorted({round(ph(vals['K'][i] * 1000 + off), 0) for i in vals['K']})
    # ---- A4: polled digitalRead latency, rise and fall, against the scheduled edges
    a4s = sched[:300]
    marks = [(v, l) for v, pad, dr, l in pads if pad == 19 and dr == 1 and (5000 + 556) * MS <= v < (6150 + 556) * MS]
    lat_r, lat_f, slow = [], [], []
    for p in a4s:
        rise, fall = int(p['rise']), int(p['fall'])
        mr = next((v for v, l in marks if l == 1 and v >= rise), None)
        mf = next((v for v, l in marks if l == 0 and v >= fall), None)
        if mr is not None and mr < fall: lat_r.append((mr - rise) / 1000); (mr - rise > 5000) and slow.append(('rise', round(ph(rise), 2), round((mr - rise) / 1000, 2)))
        if mf is not None and mf < fall + 2 * MS: lat_f.append((mf - fall) / 1000); (mf - fall > 5000) and slow.append(('fall', round(ph(fall), 2), round((mf - fall) / 1000, 2)))
    r['A4 polled digitalRead latency us'] = {'rise': summ([round(x, 3) for x in lat_r]), 'fall': summ([round(x, 3) for x in lat_f]), 'over5us': len(slow), 'over5usAt': sorted(slow)[:12]}
    # ---- A5/A6: pulseIn, matched to scheduled pulses by width
    L = 2000 / a0
    for tag, sec in (('P', sched[300:600]), ('Q', sched[600:900])):
        W = [((int(p['fall']) - int(p['rise'])) / 1000, int(p['rise']), int(p['fall'])) for p in sec]
        reads = [vals[tag][k] for k in sorted(vals[tag])]
        lead = next(i for i, v in enumerate(reads) if v)  # the section starts before its first pulse
        zero = sum(v == 0 for v in reads)
        # strict order: call k after the lead = pulse k + shift (shift > 0 when the first call started
        # during a pulse and so measured the next one); the shift with the smallest median |error|
        def build(sh):
            return [{'read': v, 'W': w, 'err': round(v - w, 3), 'risePh': round(ph(rs), 2), 'fallPh': round(ph(fl), 2),
                     'inPoll': math.floor(w - L) <= v <= math.floor(w + L)} for (w, rs, fl), v in zip(W[sh:], reads[lead:])]
        shift = min(range(3), key=lambda sh: st.median(abs(x['err']) for x in build(sh)))
        rows = build(shift)
        assert all(abs(x['err']) < 300 for x in rows), 'misaligned'
        errs = [x['err'] for x in rows]
        outl = [x for x in rows if not x['inPoll']]
        r[f'A{"5" if tag == "P" else "6"} pulseIn {"interrupts on" if tag == "P" else "masked"}'] = {
            'readings': len(rows), 'timeouts': zero, 'alignShift': shift, 'errUs': summ(errs),
            'withinPollingBound': sum(x['inPoll'] for x in rows), 'outside': len(outl),
            'outsideRows': sorted(outl, key=lambda x: x['err'])[:14]}
    # ---- A7: micros() interval vs bridge interval
    u = [(v, l) for v, pad, dr, l in pads if pad == 19 and dr == 1 and v >= (9200 + 556) * MS]
    wid = [(u[i + 1][0] - u[i][0]) / 1000 for i in range(len(u) - 1) if u[i][1] == 1 and u[i + 1][1] == 0]
    dif = [round(vals['U'][k] - wid[k], 3) for k in range(min(len(wid), len(vals['U'])))]
    r['A7 micros() interval - bridge interval us'] = summ(dif)
    # ---- core run slices (plugin): how long one core runs while the other is frozen
    S = [(int(p[1]), int(p[2])) for p in (l.split() for l in open(f'{G}/{run}.prof')) if p[0] == 'S']
    S = S[200:]  # skip boot (core 0 alone)
    for cpu in (0, 1):
        Lx = sorted(x for c, x in S if c == cpu)
        r[f'slices cpu{cpu} (insns; x8 ns)'] = summ(Lx)
    out[run] = r

# ---- MicroPython time_pulse_us
d = json.load(open(f'{G}/mp-pulse.json'))
job = next(j for j in json.load(open(f'{G}/jobs-mx.json')) if j['name'] == 'mp-pulse')
W = [((int(p['fall']) - int(p['rise'])) / 1000, int(p['rise']), int(p['fall'])) for p in job['pulses']]
v = [int(x) for x in re.findall(r'^M \d+ (-?\d+)\r?$', d['serial'], re.M)]
lead = next(i for i, x in enumerate(v) if x > 0)
rows = [{'read': x, 'W': w, 'err': round(x - w, 3), 'risePh': round(ph(rs), 2), 'fallPh': round(ph(fl), 2)}
        for (w, rs, fl), x in zip(W, v[lead:])]
out['mp-pulse'] = {'readings': len(rows), 'leadingTimeouts': lead, 'laterNonPositive': [x for x in rows if x['read'] <= 0][:5], 'errUs': summ([x['err'] for x in rows]),
                   'worst': sorted(rows, key=lambda x: x['err'])[:5] + sorted(rows, key=lambda x: -x['err'])[:5]}
json.dump(out, open(f'{G}/mx-analysis.json', 'w'), indent=1)
for k, v in out.items():
    print('=====', k)
    for kk, vv in v.items(): print(f'  {kk}: {json.dumps(vv)[:700]}')
