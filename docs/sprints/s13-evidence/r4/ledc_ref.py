"""R4 PROBE (scratch): reference LEDC waveform model, from ESP32 TRM v5.8 ch. 28, applied to the
R4P register trace. Emits W <vns> <pad> <period_ns> <high_ns> <phase_ns> per routed HS channel.
Clocks: APB 80 MHz, REF_TICK 1 MHz (Arduino defaults; assumption A-CLK)."""
import sys
from fractions import Fraction as F

APB, REF = 80_000_000, 1_000_000
trace, events = sys.argv[1], sys.argv[2]
timer = [0] * 8; conf0 = [0] * 16; duty = [0] * 16; hpoint = [0] * 16
rst_release = {}  # timer -> vns when RST went 1 -> 0 (counter starts at 0)
route = {}        # pad -> hs channel (signal 71..78)
for l in open(events):
    p = l.split()
    if p[0] == 'FUNC' and p[3].startswith('periph:'):
        sig = int(p[3][7:])
        if 71 <= sig <= 78: route[int(p[2])] = (sig - 71, int(p[1]))

def wave(ch):
    t = conf0[ch] & 3
    tc = timer[t]
    res = tc & 0x1f; div = F((tc >> 5) & 0x3ffff, 256); clk = APB if (tc >> 25) & 1 else REF
    if not (conf0[ch] & 4) or res == 0 or div == 0: return None
    tick = F(10**9, clk) * div             # average counter period, ns
    n = 1 << res
    period = tick * n
    lo = hpoint[ch]; hi = lo + (duty[ch] >> 4)
    high = min(hi, n) - lo if hi > lo else 0  # latch high at hpoint, low at hpoint+duty
    phase0 = rst_release.get(t)
    return period, tick * high, tick * lo, phase0, (duty[ch] & 0xf)

out = []
for l in open(trace):
    p = l.split()
    if len(p) != 5 or p[0] != 'R4P' or p[1] != 'W': continue
    a, v, vns = int(p[2], 16), int(p[3], 16), int(p[4])
    if 0x140 <= a < 0x160:
        t = (a - 0x140) // 8
        if (timer[t] >> 24) & 1 and not (v >> 24) & 1: rst_release[t] = vns
        timer[t] = v
    elif a < 0x140:
        ch, r = a // 0x14, a % 0x14
        if r == 0: conf0[ch] = v
        elif r == 4: hpoint[ch] = v & 0xfffff
        elif r == 8: duty[ch] = v & 0x1ffffff
        elif r == 0xc and v >> 31:           # duty_start: the configuration becomes active
            w = wave(ch)
            pads = [pd for pd, (c, _) in route.items() if c == ch]
            if w:
                period, high, ph, t0, frac = w
                out.append((vns, ch, pads, float(period), float(high), float(ph), t0, frac))
for vns, ch, pads, period, high, ph, t0, frac in out:
    print(f"W vns={vns} hsch={ch} pads={pads} period_ns={period:.3f} high_ns={high:.3f} hpoint_ns={ph:.3f} timer_start_vns={t0} dither={frac}")
print("routes", route)
