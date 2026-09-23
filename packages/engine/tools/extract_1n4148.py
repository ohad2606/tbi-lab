#!/usr/bin/env python3
"""
Reproduce the TBI Lab 1N4148 model card from the manufacturer datasheet.

Source: Vishay Semiconductors, 1N4148 "Small Signal Fast Switching Diodes",
Document Number 81857, Rev. 1.6, 07-Nov-2024, https://www.vishay.com/docs/81857/1n4148.pdf
(SHA-256 of the file used: see EXPECTED_SHA256; the PDF is not committed).

Method (standard library only, no image processing):
  1. Decompress page 2's content stream and interpret its vector drawing operators.
  2. Fig. 1 "Typical Forward Voltage vs. Junction Temperature" plots four straight lines
     (I_F = 0.1, 1, 10, 100 mA). Calibrate its axes from the figure's own gridlines
     (-40..160 degC, 0..1 V) and read each line at T_j = 25 degC: these are exact vector
     coordinates, not pixel readings.
  3. Fig. 2 "Forward Current vs. Forward Voltage" (log axis) supplies independent points of
     the 25 degC curve at a few microamperes, used only as a check.
  4. Least-squares fit of V_F = N*Vt*ln(I/I_S + 1) + I*R_S to the Fig. 1 anchors (linear in
     N, N*Vt*ln(I_S), R_S when I >> I_S), with Vt from CODATA 2019 at 298.15 K.

Usage: python3 extract_1n4148.py path/to/1n4148.pdf
"""
import hashlib, math, re, sys, zlib

EXPECTED_SHA256 = 'aefe85400a427ed886a4e1c88205ceabb9f9b38044b29c6acee4bb00146a44b7'
PAGE2_CONTENT_OBJ = 80
CMYK = {'0.83529 0.42237 0 0': 'blue', '0.013214 0.71569 1 0.000702': 'orange',
        '0.70819 0 0.95886 0': 'green', '0 0.99335 1 0': 'red'}


def page_paths(pdf: bytes):
    m = re.search(rb'\n%d 0 obj(.*?)endobj' % PAGE2_CONTENT_OBJ, pdf, re.S)
    body = m.group(1)
    raw = body[body.index(b'stream') + 6:].lstrip(b'\r\n')
    d = re.sub(r'BT.*?ET', ' ', zlib.decompressobj().decompress(raw).decode('latin1'), flags=re.S)
    toks = re.findall(r'\[[^\]]*\]|\([^)]*\)|/[^\s/\[\]()]+|[^\s\[\]()/]+', d)
    ctm, stack, stroke = [1, 0, 0, 1, 0, 0], [], 'gray 0'
    sub, cur, out, ops = [], [], [], []

    def mul(a, b):
        return [a[0]*b[0]+a[1]*b[2], a[0]*b[1]+a[1]*b[3], a[2]*b[0]+a[3]*b[2],
                a[2]*b[1]+a[3]*b[3], a[4]*b[0]+a[5]*b[2]+b[4], a[4]*b[1]+a[5]*b[3]+b[5]]

    def tx(x, y):
        return (ctm[0]*x+ctm[2]*y+ctm[4], ctm[1]*x+ctm[3]*y+ctm[5])

    for t in toks:
        try:
            ops.append(float(t)); continue
        except ValueError:
            pass
        o, ops = ops, []
        if t == 'q': stack.append((ctm[:], stroke))
        elif t == 'Q': ctm, stroke = stack.pop()
        elif t == 'cm': ctm = mul(o, ctm)
        elif t == 'K': stroke = ' '.join('%g' % v for v in o)
        elif t == 'G': stroke = 'gray %g' % o[0]
        elif t == 'm':
            if cur: sub.append(cur)
            cur = [tx(o[0], o[1])]
        elif t == 'l': cur.append(tx(o[0], o[1]))
        elif t == 'c': cur.append(tx(o[4], o[5]))
        elif t == 're':
            x, y, w, h = o
            sub.append([tx(x, y), tx(x+w, y), tx(x+w, y+h), tx(x, y+h), tx(x, y)])
        elif t in ('S', 's'):
            if cur: sub.append(cur)
            out.append((stroke, sub)); sub, cur = [], []
        elif t in ('f', 'F', 'f*', 'B', 'b', 'n'):
            sub, cur = [], []
    return out


def main(path):
    pdf = open(path, 'rb').read()
    digest = hashlib.sha256(pdf).hexdigest()
    assert digest == EXPECTED_SHA256, f'unexpected datasheet file {digest}'
    paths = page_paths(pdf)
    grid = [(a, b) for c, subs in paths if c == 'gray 0' for s in subs for a, b in zip(s, s[1:])]
    # Fig. 1 plot frame: gridlines of the upper-left chart.
    xs = sorted({round(a[0], 2) for a, b in grid if abs(a[0]-b[0]) < .05 and a[0] < 300 and min(a[1], b[1]) > 340})
    ys = sorted({round(a[1], 2) for a, b in grid if abs(a[1]-b[1]) < .05 and a[0] < 300 and a[1] > 340})
    x0, x1, y0, y1 = xs[0], xs[-1], ys[0], ys[-1]          # -40..160 degC, 0..1 V
    x25 = x0 + (25 + 40) * (x1 - x0) / 200
    fig1 = [(c, [p for s in subs for p in s]) for c, subs in paths if c in CMYK and all(p[1] > 340 and p[0] < 300 for s in subs for p in s)]
    order = {'blue': 1e-4, 'orange': 1e-3, 'green': 1e-2, 'red': 1e-1}
    anchors = []
    for c, pts in fig1:
        pts = sorted(pts)
        for (xa, ya), (xb, yb) in zip(pts, pts[1:]):
            if xa <= x25 <= xb:
                anchors.append((order[CMYK[c]], (ya + (yb-ya)*(x25-xa)/(xb-xa) - y0) / (y1 - y0)))
    anchors.sort()
    # Record anchors to 0.1 mV (models.ts VISHAY_1N4148_ANCHORS); the card is the fit of
    # exactly these recorded values, so it can be reproduced from the source file.
    anchors = [(i, round(v, 4)) for i, v in anchors]
    k, q, T = 1.380649e-23, 1.602176634e-19, 298.15
    vt = k * T / q
    rows = [[vt*math.log(i), 1.0, i] for i, _ in anchors]
    rhs = [v for _, v in anchors]
    m = [[sum(r[a]*r[b] for r in rows) for b in range(3)] + [sum(r[a]*v for r, v in zip(rows, rhs))] for a in range(3)]
    for c in range(3):
        p = max(range(c, 3), key=lambda r: abs(m[r][c])); m[c], m[p] = m[p], m[c]
        for r in range(3):
            if r != c:
                f = m[r][c] / m[c][c]; m[r] = [a - f*b for a, b in zip(m[r], m[c])]
    n, cc, rs = (m[i][3] / m[i][i] for i in range(3))
    i_s = math.exp(-cc / (n * vt))
    print(f'datasheet sha256 {digest}')
    print('Fig. 1 anchors at Tj = 25 degC (I_F A, V_F V):')
    for i, v in anchors: print(f'  {i:.0e}  {v:.4f}')
    print(f'fit: N = {n:.6f}  I_S = {i_s:.6e} A  R_S = {rs:.6f} ohm  (Vt = {vt:.6f} V)')
    for i, v in anchors:
        model = n*vt*math.log(i/i_s+1) + i*rs
        print(f'  residual at {i:.0e} A: {1e3*(model-v):+.2f} mV')


if __name__ == '__main__':
    main(sys.argv[1])
