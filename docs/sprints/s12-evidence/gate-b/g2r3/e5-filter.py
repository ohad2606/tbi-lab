#!/usr/bin/env python3
"""E5 trace filter: read the QEMU -d exec,int,nochain log from a FIFO, and for each hit of the
digitalWrite entry TB write the 4000 preceding and 30000 following log lines to seg-<n>.log."""
import collections, re, sys
fifo, out, pc = sys.argv[1], sys.argv[2], sys.argv[3]
MAXHIT = 9
ring = collections.deque(maxlen=4000)
hits, active = 0, []  # active: [file, remaining]
pat = re.compile(r'^Trace (\d+): \S+ \[[0-9a-f]+/0*' + pc + r'/')
with open(fifo, errors='replace') as f:
    for line in f:
        if hits < MAXHIT and pat.match(line):
            hits += 1
            g = open(f'{out}/seg-{hits}.log', 'w')
            g.writelines(ring)
            g.write(f'#### HIT {hits}\n')
            active.append([g, 30000])
        for a in active:
            a[0].write(line)
            a[1] -= 1
        for a in [a for a in active if a[1] <= 0]:
            a[0].close(); active.remove(a)
        ring.append(line)
for a in active: a[0].close()
print('hits', hits)
