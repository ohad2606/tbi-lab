#!/usr/bin/env bash
# TBI Lab classic-ESP32 runtime (R1) — reproducible provisioning.
#
# Builds everything the runtime needs from pinned sources into ONE directory,
# $TBI_RUNTIME_HOME (default: ${XDG_DATA_HOME:-$HOME/.local/share}/tbi-lab-runtime). Nothing is
# read from, or written to, any other developer-specific location.
#
#   runtime/provision/provision.sh check        # host prerequisites only
#   runtime/provision/provision.sh qemu         # fetch pinned Espressif QEMU, apply patches, build, install
#   runtime/provision/provision.sh arduino      # pinned arduino-cli + arduino-esp32 core
#   runtime/provision/provision.sh micropython  # pinned MicroPython image
#   runtime/provision/provision.sh firmware     # build the runtime test firmware into the artifact store
#   runtime/provision/provision.sh all          # all of the above, in order
#   runtime/provision/provision.sh env          # print the environment the runtime tests use
#
# This is deliberately NOT part of the product CI (heavy: see docs/runtime/R1-REPORT.md for disk
# and time). The runtime release gate is `npm run test:runtime`, run after provisioning.

set -euo pipefail
shopt -s nullglob

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=versions.env
source "$HERE/versions.env"

RT="${TBI_RUNTIME_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/tbi-lab-runtime}"
mkdir -p "$RT"/{src,build,logs,artifacts}

log() { printf '[provision %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
sha256() { sha256sum "$1" | cut -d' ' -f1; }

# The runtime identity: the upstream commit plus every carried patch, in order. A different patch
# set is a different runtime version (it can legitimately change timelines, ADR-007).
runtime_id() {
  {
    echo "$QEMU_COMMIT"
    for p in "$REPO"/runtime/qemu/patches/*.patch; do sha256 "$p"; done
  } | sha256sum | cut -c1-16
}

cmd_check() {
  local missing=()
  for tool in git gcc g++ make ninja pkg-config python3 flex bison curl sha256sum tar; do
    command -v "$tool" >/dev/null || missing+=("$tool")
  done
  # slirp: the Espressif tree builds net/slirp.c unconditionally (found in R1).
  for lib in glib-2.0 pixman-1 zlib slirp; do
    pkg-config --exists "$lib" || missing+=("pkg-config:$lib")
  done
  command -v libgcrypt-config >/dev/null || pkg-config --exists libgcrypt || missing+=("libgcrypt")
  python3 -c 'import venv' 2>/dev/null || missing+=("python3-venv")
  if ((${#missing[@]})); then
    log "missing host prerequisites: ${missing[*]}"
    log "Debian/Ubuntu: sudo apt-get install build-essential git ninja-build pkg-config python3 python3-venv flex bison curl libglib2.0-dev libpixman-1-dev libgcrypt20-dev libslirp-dev zlib1g-dev"
    exit 1
  fi
  log "host prerequisites present ($(uname -m), $(nproc) CPU)"
}

cmd_qemu() {
  cmd_check
  local src="$RT/src/qemu-$QEMU_COMMIT"
  if [[ ! -d "$src/.git" ]]; then
    log "fetching $QEMU_REPO @ $QEMU_COMMIT ($QEMU_TAG)"
    rm -rf "$src.tmp" && mkdir -p "$src.tmp"
    git -C "$src.tmp" init -q
    git -C "$src.tmp" remote add origin "$QEMU_REPO"
    git -C "$src.tmp" fetch -q --depth 1 origin "$QEMU_COMMIT"
    git -C "$src.tmp" -c advice.detachedHead=false checkout -q FETCH_HEAD
    mv "$src.tmp" "$src"
  fi
  local head
  head="$(git -C "$src" rev-parse HEAD)"
  [[ "$head" == "$QEMU_COMMIT" ]] || die "source is at $head, expected $QEMU_COMMIT"
  log "source verified at $QEMU_COMMIT"

  local id; id="$(runtime_id)"
  local work="$RT/build/work-$id" prefix="$RT/qemu-$id"
  if [[ -x "$prefix/bin/qemu-system-xtensa" ]]; then
    log "runtime $id already installed at $prefix"
  else
    log "preparing patched tree for runtime $id"
    rm -rf "$work" && mkdir -p "$work"
    git -C "$src" worktree prune
    git -C "$src" archive --format=tar HEAD | tar -x -C "$work"
    for p in "$REPO"/runtime/qemu/patches/*.patch; do
      [[ -e "$p" ]] || continue
      log "applying $(basename "$p")"
      patch -d "$work" -p1 --forward --quiet < "$p" || die "patch failed: $p"
    done
    log "configuring (xtensa-softmmu only)"
    mkdir -p "$work/build"
    (cd "$work/build" && ../configure \
      --prefix="$prefix" \
      --target-list=xtensa-softmmu \
      --enable-gcrypt \
      --disable-user --disable-docs --disable-tools --disable-capstone \
      --disable-sdl --disable-gtk --disable-vnc --disable-opengl \
      --disable-debug-info --disable-werror \
      >"$RT/logs/qemu-configure-$id.log" 2>&1) || die "configure failed: $RT/logs/qemu-configure-$id.log"
    log "building (this is the long step on a small host)"
    local t0=$SECONDS
    ninja -C "$work/build" qemu-system-xtensa >"$RT/logs/qemu-build-$id.log" 2>&1 ||
      die "build failed: $RT/logs/qemu-build-$id.log"
    log "built in $((SECONDS - t0)) s"
    ninja -C "$work/build" install >"$RT/logs/qemu-install-$id.log" 2>&1 || die "install failed"
    {
      echo "{"
      echo "  \"runtimeId\": \"$id\","
      echo "  \"upstream\": \"$QEMU_REPO\","
      echo "  \"tag\": \"$QEMU_TAG\","
      echo "  \"commit\": \"$QEMU_COMMIT\","
      echo "  \"patches\": ["
      local first=1
      for p in "$REPO"/runtime/qemu/patches/*.patch; do
        [[ -e "$p" ]] || continue
        ((first)) || echo ","
        printf '    { "file": "%s", "sha256": "%s" }' "$(basename "$p")" "$(sha256 "$p")"
        first=0
      done
      echo ""
      echo "  ],"
      echo "  \"builtAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
      echo "  \"host\": \"$(uname -m)\""
      echo "}"
    } >"$prefix/runtime.json"
    # GPL: the exact corresponding source (upstream tree + patches) is kept next to the binary.
    mkdir -p "$prefix/share/tbi-lab-runtime/source"
    cp "$REPO"/runtime/qemu/patches/*.patch "$prefix/share/tbi-lab-runtime/source/" 2>/dev/null || true
    cp "$work/COPYING" "$work/LICENSE" "$prefix/share/tbi-lab-runtime/source/" 2>/dev/null || true
  fi
  ln -sfn "qemu-$id" "$RT/qemu-current"
  log "qemu ready: $RT/qemu-current -> qemu-$id"
}

arduino_cli() { "$RT/arduino/bin/arduino-cli" --config-file "$RT/arduino/arduino-cli.yaml" "$@"; }

cmd_arduino() {
  local arch
  case "$(uname -m)" in aarch64 | arm64) arch=ARM64 ;; x86_64) arch=64bit ;; *) die "unsupported host $(uname -m)" ;; esac
  local tarball="arduino-cli_${ARDUINO_CLI_VERSION}_Linux_${arch}.tar.gz"
  local base="https://downloads.arduino.cc/arduino-cli"
  mkdir -p "$RT/arduino"/{bin,data,downloads,user}
  if [[ ! -x "$RT/arduino/bin/arduino-cli" ]]; then
    log "downloading arduino-cli $ARDUINO_CLI_VERSION"
    curl -fsSL -o "$RT/downloads-$tarball" "$base/$tarball"
    local pin="ARDUINO_CLI_SHA256_Linux_${arch}" want
    want="${!pin:-}"
    [[ -n "$want" && "$(sha256 "$RT/downloads-$tarball")" == "$want" ]] || die "arduino-cli checksum mismatch"
    tar -xzf "$RT/downloads-$tarball" -C "$RT/arduino/bin" arduino-cli
    rm -f "$RT/downloads-$tarball"
  fi
  cat >"$RT/arduino/arduino-cli.yaml" <<YAML
board_manager:
  additional_urls:
    - $ARDUINO_ESP32_INDEX
directories:
  data: $RT/arduino/data
  downloads: $RT/arduino/downloads
  user: $RT/arduino/user
YAML
  if ! arduino_cli core list 2>/dev/null | grep -q "^esp32:esp32 *$ARDUINO_ESP32_VERSION"; then
    log "installing arduino-esp32 $ARDUINO_ESP32_VERSION (large download)"
    arduino_cli core update-index >"$RT/logs/arduino-index.log" 2>&1
    arduino_cli core install "esp32:esp32@$ARDUINO_ESP32_VERSION" >"$RT/logs/arduino-core.log" 2>&1 ||
      die "core install failed: $RT/logs/arduino-core.log"
  fi
  log "arduino ready: $(arduino_cli version) / esp32:esp32@$ARDUINO_ESP32_VERSION"
}

cmd_micropython() {
  local out="$RT/downloads-micropython.bin"
  if [[ ! -f "$out" || "$(sha256 "$out")" != "$MICROPYTHON_SHA256" ]]; then
    log "downloading MicroPython"
    curl -fsSL -o "$out" "$MICROPYTHON_URL"
  fi
  [[ "$(sha256 "$out")" == "$MICROPYTHON_SHA256" ]] || die "MicroPython checksum mismatch"
  # QEMU boots a single 4 MB flash image; the release blob belongs at offset 0x1000.
  local img="$RT/build/micropython-4mb.bin"
  python3 - "$out" "$img" <<'PY'
import sys
blob = open(sys.argv[1], 'rb').read()
img = bytearray(b'\xff' * (4 * 1024 * 1024))
img[0x1000:0x1000 + len(blob)] = blob
open(sys.argv[2], 'wb').write(img)
PY
  store_artifact "$img" micropython
}

# Content-addressed, read-only firmware store: $RT/artifacts/<sha256>.bin (+ a name link).
store_artifact() {
  local file="$1" name="$2" h
  h="$(sha256 "$file")"
  if [[ ! -f "$RT/artifacts/$h.bin" ]]; then
    cp "$file" "$RT/artifacts/$h.bin"
    chmod 0444 "$RT/artifacts/$h.bin"
  fi
  ln -sfn "$h.bin" "$RT/artifacts/$name.bin"
  log "artifact $name = $h"
}

cmd_firmware() {
  [[ -x "$RT/arduino/bin/arduino-cli" ]] || die "run 'provision.sh arduino' first"
  local esptool
  esptool="$(find "$RT/arduino/data/packages/esp32/tools/esptool_py" -maxdepth 2 -name esptool -type f | head -1)"
  [[ -x "$esptool" ]] || die "esptool not found in the arduino-esp32 tools"
  local core="$RT/arduino/data/packages/esp32/hardware/esp32/$ARDUINO_ESP32_VERSION"
  for dir in "$REPO"/runtime/firmware/arduino/*/; do
    local name; name="$(basename "$dir")"
    local out="$RT/build/fw-$name"
    rm -rf "$out" && mkdir -p "$out"
    # Build in a canonical location and strip host paths from debug/assert strings, so the same
    # pins produce byte-identical firmware on any host (the release-gate hashes depend on it).
    local stage="/tmp/tbi-fw-build/$name"
    rm -rf "$stage" && mkdir -p "$stage" && cp -r "$dir"/. "$stage/"
    local maps="-ffile-prefix-map=$RT/arduino/data=/arduino-data -ffile-prefix-map=$stage=/sketch -ffile-prefix-map=/tmp/tbi-fw-build=/build"
    log "building firmware $name ($ARDUINO_FQBN)"
    SOURCE_DATE_EPOCH="$FIRMWARE_SOURCE_DATE_EPOCH" arduino_cli compile --fqbn "$ARDUINO_FQBN" --build-path "/tmp/tbi-fw-build/.build-$name" \
      --build-property "compiler.c.extra_flags=$maps" \
      --build-property "compiler.cpp.extra_flags=$maps" \
      --output-dir "$out" "$stage" >"$RT/logs/fw-$name.log" 2>&1 || die "build failed: $RT/logs/fw-$name.log"
    local ino="$name.ino"
    "$esptool" --chip esp32 merge-bin --output "$out/$name-4mb.bin" --fill-flash-size 4MB \
      --flash-mode dio --flash-freq 40m --flash-size 4MB \
      0x1000 "$out/$ino.bootloader.bin" 0x8000 "$out/$ino.partitions.bin" \
      0xe000 "$core/tools/partitions/boot_app0.bin" 0x10000 "$out/$ino.bin" \
      >>"$RT/logs/fw-$name.log" 2>&1 || die "merge failed: $RT/logs/fw-$name.log"
    store_artifact "$out/$name-4mb.bin" "$name"
  done
}

cmd_env() {
  echo "export TBI_RUNTIME_HOME=$RT"
  echo "export TBI_QEMU=$RT/qemu-current/bin/qemu-system-xtensa"
  echo "export TBI_ARTIFACTS=$RT/artifacts"
}

case "${1:-}" in
  check) cmd_check ;;
  qemu) cmd_qemu ;;
  arduino) cmd_arduino ;;
  micropython) cmd_micropython ;;
  firmware) cmd_firmware ;;
  all) cmd_qemu && cmd_arduino && cmd_micropython && cmd_firmware ;;
  env) cmd_env ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
