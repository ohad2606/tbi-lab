# Sprint 18 probe: <base 4 MiB MicroPython image> + LittleFS (tbi-mklfs) at 0x200000 -> image.
import hashlib, subprocess, sys, os
base, prog, out = sys.argv[1:4]
fs = out + '.fs'
subprocess.run([os.path.join(os.path.dirname(__file__), 'tbi-mklfs'), fs, '4096', '512', f'main.py={prog}'], check=True)
img = bytearray(open(base, 'rb').read())
assert len(img) == 0x400000 and all(b == 0xFF for b in img[0x200000:]), 'base image must be blank above 2 MiB'
img[0x200000:] = open(fs, 'rb').read()
open(out, 'wb').write(img)
os.remove(fs)
print(hashlib.sha256(img).hexdigest(), out)
