/*
 * Sprint 18 Workstream D probe (not a product artifact): build the MicroPython "vfs" LittleFS image
 * with the interpreter's own littlefs sources (MicroPython v1.29.0 lib/littlefs, LFS2_VERSION
 * 2.11, disk 2.1) and its own VfsLfs2 configuration (extmod/vfs_lfsx.c: read/prog/lookahead 32,
 * block_cycles 100, cache_size min(block, 4 * max(read, prog))). No clock is read: the image is a
 * pure function of the inputs (no mtime attributes, as MicroPython writes none without an RTC call).
 *
 *   tbi-mklfs <image-out> <block-size> <block-count> <name>=<host-file>...
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "lfs2.h"

static uint8_t *disk;
static lfs2_size_t BS;

static int rd(const struct lfs2_config *c, lfs2_block_t b, lfs2_off_t o, void *buf, lfs2_size_t n) {
  (void)c; memcpy(buf, disk + (size_t)b * BS + o, n); return 0;
}
static int pr(const struct lfs2_config *c, lfs2_block_t b, lfs2_off_t o, const void *buf, lfs2_size_t n) {
  (void)c; uint8_t *d = disk + (size_t)b * BS + o; const uint8_t *s = buf;
  for (lfs2_size_t i = 0; i < n; i++) d[i] &= s[i]; /* NOR flash: programming only clears bits */
  return 0;
}
static int er(const struct lfs2_config *c, lfs2_block_t b) {
  (void)c; memset(disk + (size_t)b * BS, 0xff, BS); return 0;
}
static int sy(const struct lfs2_config *c) { (void)c; return 0; }

int main(int argc, char **argv) {
  if (argc < 4) { fprintf(stderr, "usage: %s out block-size block-count name=file...\n", argv[0]); return 2; }
  BS = (lfs2_size_t)strtoul(argv[2], 0, 0);
  lfs2_size_t count = (lfs2_size_t)strtoul(argv[3], 0, 0);
  disk = malloc((size_t)BS * count);
  memset(disk, 0xff, (size_t)BS * count);
  static uint8_t rbuf[4096], pbuf[4096], lbuf[32];
  struct lfs2_config cfg = {
    .read = rd, .prog = pr, .erase = er, .sync = sy,
    .read_size = 32, .prog_size = 32, .block_size = BS, .block_count = count,
    .block_cycles = 100, .cache_size = BS < 128 ? BS : 128, .lookahead_size = 32,
    .read_buffer = rbuf, .prog_buffer = pbuf, .lookahead_buffer = lbuf,
  };
  lfs2_t fs;
  if (lfs2_format(&fs, &cfg) || lfs2_mount(&fs, &cfg)) { fprintf(stderr, "format/mount failed\n"); return 1; }
  for (int i = 4; i < argc; i++) {
    char *eq = strchr(argv[i], '=');
    if (!eq) { fprintf(stderr, "bad arg %s\n", argv[i]); return 2; }
    *eq = 0;
    FILE *f = fopen(eq + 1, "rb");
    if (!f) { perror(eq + 1); return 1; }
    lfs2_file_t lf;
    static uint8_t fbuf[4096];
    struct lfs2_file_config fc = { .buffer = fbuf }; /* as MicroPython: no malloc, no attributes */
    if (lfs2_file_opencfg(&fs, &lf, argv[i], LFS2_O_WRONLY | LFS2_O_CREAT | LFS2_O_TRUNC, &fc)) { fprintf(stderr, "open %s\n", argv[i]); return 1; }
    char buf[4096]; size_t n;
    while ((n = fread(buf, 1, sizeof buf, f)) > 0)
      if (lfs2_file_write(&fs, &lf, buf, (lfs2_size_t)n) != (lfs2_ssize_t)n) { fprintf(stderr, "write %s\n", argv[i]); return 1; }
    fclose(f);
    if (lfs2_file_close(&fs, &lf)) return 1;
  }
  if (lfs2_unmount(&fs)) return 1;
  FILE *o = fopen(argv[1], "wb");
  fwrite(disk, 1, (size_t)BS * count, o);
  fclose(o);
  return 0;
}
