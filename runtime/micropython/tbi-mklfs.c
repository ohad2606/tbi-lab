/*
 * TBI Lab (Sprint 19B, MicroPython M1): build the LittleFS v2 image of MicroPython's "vfs"
 * partition, so that the GENUINE interpreter finds the user's program as /main.py at boot.
 *
 * Built by runtime/provision/provision.sh (micropython-tools) against the interpreter's OWN
 * littlefs sources: MicroPython v1.29.0 lib/littlefs (LFS2_VERSION 2.11, disk version 2.1), from
 * the pinned release tarball. The configuration is MicroPython's own VfsLfs2 (extmod/vfs_lfsx.c):
 * read_size = prog_size = lookahead = 32, block_cycles = 100, cache_size = min(block, 4 * 32).
 *
 * Deterministic: no clock is read and no attribute is written (MicroPython writes none without an
 * RTC call), so the image is a pure function of the arguments and the file contents. Run inside
 * the build sandbox (runtime/builder/build-job.ts allow-lists it), on untrusted program text: it
 * only reads the named files and writes the one output file.
 *
 *   tbi-mklfs <image-out> <block-size> <block-count> <name>=<host-file>...
 * Exit 0 on success; 1 (and a one-line reason on stderr) on any failure, including a file that
 * does not fit.
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "lfs2.h"

static uint8_t *disk;
static lfs2_size_t block_size;

static int rd(const struct lfs2_config *c, lfs2_block_t b, lfs2_off_t o, void *buf, lfs2_size_t n)
{
    (void)c;
    memcpy(buf, disk + (size_t)b * block_size + o, n);
    return 0;
}

static int pr(const struct lfs2_config *c, lfs2_block_t b, lfs2_off_t o, const void *buf,
              lfs2_size_t n)
{
    (void)c;
    uint8_t *d = disk + (size_t)b * block_size + o;
    const uint8_t *s = buf;
    for (lfs2_size_t i = 0; i < n; i++) {
        d[i] &= s[i]; /* NOR flash: programming only clears bits */
    }
    return 0;
}

static int er(const struct lfs2_config *c, lfs2_block_t b)
{
    (void)c;
    memset(disk + (size_t)b * block_size, 0xff, block_size);
    return 0;
}

static int sy(const struct lfs2_config *c)
{
    (void)c;
    return 0;
}

static int fail(const char *what, const char *arg)
{
    fprintf(stderr, "tbi-mklfs: %s%s%s\n", what, arg ? ": " : "", arg ? arg : "");
    return 1;
}

int main(int argc, char **argv)
{
    if (argc < 5) {
        fprintf(stderr, "usage: %s out block-size block-count name=file...\n", argv[0]);
        return 2;
    }
    /* Ranges checked on the full unsigned long, before narrowing (no truncation: "4294967424" is
     * refused, not read as 128); the block size is a power of two, as the flash erase unit is. */
    char *end;
    errno = 0;
    unsigned long bs = strtoul(argv[2], &end, 10);
    if (errno || end == argv[2] || *end || bs < 128 || bs > 65536 || (bs & (bs - 1))) {
        return fail("bad block size", argv[2]);
    }
    block_size = (lfs2_size_t)bs;
    errno = 0;
    unsigned long bc = strtoul(argv[3], &end, 10);
    if (errno || end == argv[3] || *end || bc < 2 || bc > 4096) {
        return fail("bad block count", argv[3]);
    }
    lfs2_size_t count = (lfs2_size_t)bc;
    disk = malloc((size_t)block_size * count);
    if (!disk) {
        return fail("out of memory", NULL);
    }
    memset(disk, 0xff, (size_t)block_size * count);

    static uint8_t rbuf[128], pbuf[128], lbuf[32];
    struct lfs2_config cfg = {
        .read = rd, .prog = pr, .erase = er, .sync = sy,
        .read_size = 32, .prog_size = 32,
        .block_size = block_size, .block_count = count,
        .block_cycles = 100, .cache_size = 128, .lookahead_size = 32,
        .read_buffer = rbuf, .prog_buffer = pbuf, .lookahead_buffer = lbuf,
    };
    lfs2_t fs;
    if (lfs2_format(&fs, &cfg) || lfs2_mount(&fs, &cfg)) {
        return fail("format/mount failed", NULL);
    }
    for (int i = 4; i < argc; i++) {
        char *eq = strchr(argv[i], '=');
        if (!eq || eq == argv[i] || (strchr(argv[i], '/') != NULL && strchr(argv[i], '/') < eq)) {
            return fail("bad file argument", argv[i]);
        }
        *eq = 0;
        FILE *f = fopen(eq + 1, "rb");
        if (!f) {
            return fail("cannot read", eq + 1);
        }
        lfs2_file_t lf;
        if (lfs2_file_open(&fs, &lf, argv[i], LFS2_O_WRONLY | LFS2_O_CREAT | LFS2_O_EXCL) < 0) {
            fclose(f);
            return fail("cannot create", argv[i]);
        }
        uint8_t buf[1024];
        size_t n;
        while ((n = fread(buf, 1, sizeof(buf), f)) > 0) {
            if (lfs2_file_write(&fs, &lf, buf, (lfs2_size_t)n) != (lfs2_ssize_t)n) {
                fclose(f);
                return fail("does not fit", argv[i]);
            }
        }
        if (ferror(f)) {
            fclose(f);
            return fail("read error", eq + 1);
        }
        fclose(f);
        if (lfs2_file_close(&fs, &lf) < 0) {
            return fail("cannot close", argv[i]);
        }
    }
    if (lfs2_unmount(&fs) < 0) {
        return fail("unmount failed", NULL);
    }
    FILE *o = fopen(argv[1], "wb");
    if (!o || fwrite(disk, 1, (size_t)block_size * count, o) != (size_t)block_size * count ||
        fclose(o) != 0) {
        return fail("cannot write", argv[1]);
    }
    return 0;
}
