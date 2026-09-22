#!/usr/bin/env python3
"""Repeat the deterministic modes several times and check timestamp identity and spacing."""
import json, sys
import time_determinism as td

MODES = {
    "icount shift=3 sleep=off": ["-icount", "shift=3,sleep=off"],
    "icount shift=2 sleep=off": ["-icount", "shift=2,sleep=off"],
}
REPEATS = int(sys.argv[1]) if len(sys.argv) > 1 else 4
out = {}
idx = 100
for name, extra in MODES.items():
    runs = []
    for _ in range(REPEATS):
        idx += 1
        runs.append(td.run(extra, idx))
    seqs = [tuple(r.get("events", [])) for r in runs]
    ref = seqs[0]
    gpio = [e for e in ref if e[0] in (2, 18)]
    spacing_ms = [round((b[2] - a[2]) / 1e6, 3) for a, b in zip(gpio, gpio[1:])]
    out[name] = {
        "runs": REPEATS,
        "all_identical": all(s == ref for s in seqs) and len(ref) == td.N_EVENTS,
        "distinct_sequences": len(set(seqs)),
        "first_gpio2_virtual_s": round(next((e[2] for e in ref if e[0] == 2), 0) / 1e9, 6),
        "gpio2_18_spacing_virtual_ms": spacing_ms[:8],
        "wall_s": [r["wall_s"] for r in runs],
        "cpu_s": [r["cpu_s"] for r in runs],
        "peak_rss_mb": [r["peak_rss_mb"] for r in runs],
        "virtual_s_covered": [r["virtual_s_covered"] for r in runs],
    }
    print(name, json.dumps(out[name]), flush=True)
