/*
 * G-2 diagnostic QEMU TCG plugin (not product code). Observes only; it does not change guest
 * execution or the icount clock.
 *   out=<file>   at exit: "B <pc hex> <insns per TB> <executions> <vcpu>" per translated block
 *                and "S <vcpu> <insns>" for every round-robin slice (contiguous run of one vCPU),
 *                in execution order.
 *   marks=<file> log every execution of the listed block-start pcs with the instruction total.
 *   stop=<hex>   stop counting at the first execution of that pc (e.g. setup()).
 */
#include <glib.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <qemu-plugin.h>

QEMU_PLUGIN_EXPORT int qemu_plugin_version = QEMU_PLUGIN_VERSION;

typedef struct { uint64_t pc; uint32_t n; uint64_t count[2]; } Blk;
static GHashTable *blocks;
static GArray *slices; /* pairs: vcpu, insns */
static int last = -1;
static uint64_t run;
static char *outpath;
static uint64_t stop_pc; static int stopped;
static GHashTable *marks; static GArray *mlog; static uint64_t total; /* marks=<file of hex pcs>: log "M <pc> <vcpu> <insns so far>" */ /* stop=<hex pc>: count only until the first execution of pc */

static void flush_slice(void) {
  if (last >= 0) { uint64_t e[2] = {(uint64_t)last, run}; g_array_append_vals(slices, e, 2); }
}

static void exec_cb(unsigned int vcpu, void *ud) {
  Blk *b = ud;
  if (stopped) return;
  if (marks && g_hash_table_contains(marks, &b->pc)) { uint64_t e[3] = {b->pc, vcpu, total}; g_array_append_vals(mlog, e, 3); }
  total += b->n;
  if (stop_pc && b->pc == stop_pc) { stopped = 1; return; }
  b->count[vcpu & 1]++;
  if ((int)vcpu != last) { flush_slice(); last = vcpu; run = 0; }
  run += b->n;
}

static void tb_trans(qemu_plugin_id_t id, struct qemu_plugin_tb *tb) {
  uint64_t pc = qemu_plugin_tb_vaddr(tb);
  uint32_t n = qemu_plugin_tb_n_insns(tb);
  uint64_t key = (pc << 8) | (n & 0xff);
  Blk *b = g_hash_table_lookup(blocks, &key);
  if (!b) {
    b = g_new0(Blk, 1); b->pc = pc; b->n = n;
    uint64_t *k = g_new(uint64_t, 1); *k = key;
    g_hash_table_insert(blocks, k, b);
  }
  qemu_plugin_register_vcpu_tb_exec_cb(tb, exec_cb, QEMU_PLUGIN_CB_NO_REGS, b);
}

static void at_exit(qemu_plugin_id_t id, void *p) {
  flush_slice();
  FILE *f = fopen(outpath, "w");
  if (!f) return;
  GHashTableIter it; gpointer k, v;
  g_hash_table_iter_init(&it, blocks);
  while (g_hash_table_iter_next(&it, &k, &v)) {
    Blk *b = v;
    for (int c = 0; c < 2; c++)
      if (b->count[c]) fprintf(f, "B %" PRIx64 " %u %" PRIu64 " %d\n", b->pc, b->n, b->count[c], c);
  }
  uint64_t *e = (uint64_t *)slices->data;
  for (guint i = 0; i + 1 < slices->len; i += 2) fprintf(f, "S %" PRIu64 " %" PRIu64 "\n", e[i], e[i + 1]);
  if (mlog) { uint64_t *m = (uint64_t *)mlog->data; for (guint i = 0; i + 2 < mlog->len; i += 3) fprintf(f, "M %" PRIx64 " %" PRIu64 " %" PRIu64 "\n", m[i], m[i + 1], m[i + 2]); }
  fclose(f);
}

QEMU_PLUGIN_EXPORT int qemu_plugin_install(qemu_plugin_id_t id, const qemu_info_t *info, int argc, char **argv) {
  for (int i = 0; i < argc; i++)
    if (g_str_has_prefix(argv[i], "out=")) outpath = g_strdup(argv[i] + 4);
    else if (g_str_has_prefix(argv[i], "marks=")) {
      marks = g_hash_table_new(g_int64_hash, g_int64_equal); mlog = g_array_new(FALSE, FALSE, sizeof(uint64_t));
      FILE *mf = fopen(argv[i] + 6, "r"); char line[64];
      while (mf && fgets(line, sizeof line, mf)) { uint64_t *k = g_new(uint64_t, 1); *k = strtoull(line, NULL, 16); g_hash_table_add(marks, k); }
      if (mf) fclose(mf);
    }
    else if (g_str_has_prefix(argv[i], "stop=")) stop_pc = strtoull(argv[i] + 5, NULL, 16);
  if (!outpath) return -1;
  blocks = g_hash_table_new(g_int64_hash, g_int64_equal);
  slices = g_array_new(FALSE, FALSE, sizeof(uint64_t));
  qemu_plugin_register_vcpu_tb_trans_cb(id, tb_trans);
  qemu_plugin_register_atexit_cb(id, at_exit, NULL);
  return 0;
}
