#!/usr/bin/env bash
# build-fw.sh <sketch dir>  -> fw/<name>.bin (4 MiB merged image, as the build service makes)
set -euo pipefail
P=~/tbi-s12-probe; S="$1"; N=$(basename "$S"); B=$P/fw/build-$N; mkdir -p $B $P/fw/out-$N
D=/home/ubuntu/tbi-s8-rt/arduino/data/packages/esp32
SOURCE_DATE_EPOCH=1767225600 /home/ubuntu/tbi-s8-rt/arduino/bin/arduino-cli --config-file $P/cli/cli.yaml compile --fqbn "${FQBN:-esp32:esp32:esp32:FlashMode=dio}" --build-path $B --output-dir $P/fw/out-$N "$S" > $P/logs/compile-$N.log 2>&1
$D/tools/esptool_py/5.3.1/esptool --chip esp32 merge-bin --output $P/fw/$N.bin --fill-flash-size 4MB --flash-mode dio --flash-freq 40m --flash-size 4MB 0x1000 $P/fw/out-$N/$N.ino.bootloader.bin 0x8000 $P/fw/out-$N/$N.ino.partitions.bin 0xe000 $D/hardware/esp32/3.3.12/tools/partitions/boot_app0.bin 0x10000 $P/fw/out-$N/$N.ino.bin >> $P/logs/compile-$N.log 2>&1
sha256sum $P/fw/$N.bin
