# G-1 — R1 determinism on Runtime v2: old/new fingerprints and the exact difference

| Workload | R1 pin (runtime 33e35e4ac5e798d7) | Runtime v2 pin (b5b34b49cb7e4049) | Runs on Runtime v2 |
|---|---|---|---|
| motion (r1-motion-relay) | `88122085bf12750f` | `5fdb6a1ad50a412a` | 10/10 one result (local), 3/3 on staging B4a |
| night (r1-night-light) | `1511138e44d4f5e4` | `5596d749c3ce4f8c` | 10/10 one result (local), 3/3 on staging B4a |

v1 still reproduces the R1 pins (3/3 each). Only these two pins changed; no other fingerprint was
regenerated.

Event-by-event comparison of one session each on v1 and on Runtime v2 (same firmware `TbiBanks`
9ca3a5ce…, same request, same scheduled live parameters):

```
## motion: 39 events (v1), 39 events (v2)
events differing: [2]
event types/order identical: True; every simNs identical: True; electrical events: 9, all identical: True
event 2 (gpio @ simNs 890000000): v1 entries unchanged in v2: True; other fields identical: True
  added in v2: [{'gpio': 34, 'drive': 0, 'level': 0, 'transitions': 1}, {'gpio': 35, 'drive': 0, 'level': 0, 'transitions': 1}, {'gpio': 36, 'drive': 0, 'level': 0, 'transitions': 1}, {'gpio': 39, 'drive': 0, 'level': 0, 'transitions': 1}]
## night: 36 events (v1), 36 events (v2)
events differing: [2]
event types/order identical: True; every simNs identical: True; electrical events: 8, all identical: True
event 2 (gpio @ simNs 890000000): v1 entries unchanged in v2: True; other fields identical: True
  added in v2: [{'gpio': 34, 'drive': 0, 'level': 0, 'transitions': 1}, {'gpio': 35, 'drive': 0, 'level': 0, 'transitions': 1}, {'gpio': 36, 'drive': 0, 'level': 0, 'transitions': 1}, {'gpio': 39, 'drive': 0, 'level': 0, 'transitions': 1}]
```

Cause: `TbiBanks.ino:21` — `for (int i : INS) pinMode(i, INPUT);` with `INS = {34, 35, 36, 39}`.
`pinMode(INPUT)` writes `OUT_SEL = 0` then `OEN_SEL = 1`; for a few instructions the pad is routed
to signal 0 and its return to simple GPIO is published once (patch 0007; re-pin mechanism 2,
SPRINT-12.md F.1, ADR-011 note 4). Exactly those four pads, in the boot window, nothing else.
