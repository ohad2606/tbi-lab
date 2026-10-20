#!/bin/sh
# Probe wrapper: dev-tree QEMU (Runtime v3 patches + Sprint 18 IRQ probe), unimplemented logging.
exec $HOME/tbi-s12-dev/qemu/build/qemu-system-xtensa -L $HOME/tbi-s15-rt/qemu-2cb1406f94f52e4f/share/qemu "$@" -d unimp -D $HOME/tbi-s18/mpy/results/qemu-probe.log
