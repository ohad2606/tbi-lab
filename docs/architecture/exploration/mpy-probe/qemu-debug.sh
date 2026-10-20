#!/bin/sh
# Probe wrapper: the pinned Runtime v3 QEMU with unimplemented-device and guest-error logging.
exec $HOME/tbi-s15-rt/qemu-2cb1406f94f52e4f/bin/qemu-system-xtensa "$@" -d unimp,guest_errors -D $HOME/tbi-s18/mpy/results/qemu-debug.log
