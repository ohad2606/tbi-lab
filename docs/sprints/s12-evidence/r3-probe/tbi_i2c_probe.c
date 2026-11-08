/*
 * TBI Lab Sprint 12 R3 FEASIBILITY PROBE ONLY (never shipped, never in runtime/qemu/patches).
 * A diagnostic I2C target that logs every bus phase with QEMU_CLOCK_VIRTUAL time, so the probe
 * can see exactly what the Arduino Wire / IDF i2c_master driver makes the ESP32 I2C controller do.
 *
 * Personalities:
 *   "port": PCF8574-like. Each written byte is the port value; a read returns the last port value.
 *   "regs": 256-byte register file. First byte after START-write sets the pointer; further bytes
 *           are stored at pointer++; reads return regs[pointer++]. A written data byte 0xEE is
 *           NACKed (probe P-4).
 * Log file: $TBI_PROBE_I2C_LOG (appended, line-buffered).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
#include "qemu/osdep.h"
#include "qemu/timer.h"
#include "hw/i2c/i2c.h"
#include "hw/qdev-properties.h"
#include "qom/object.h"

#define TYPE_TBI_I2C_PROBE "tbi-i2c-probe"
OBJECT_DECLARE_SIMPLE_TYPE(TbiI2cProbe, TBI_I2C_PROBE)

struct TbiI2cProbe {
    I2CSlave parent_obj;
    char *personality;
    uint8_t regs[256];
    uint8_t ptr;
    bool first;
    uint8_t port;
};

FILE *tbi_probe_log(void);
FILE *tbi_probe_log(void)
{
    static FILE *f;
    static bool tried;
    if (!tried) {
        const char *p = getenv("TBI_PROBE_I2C_LOG");
        tried = true;
        if (p && *p) {
            f = fopen(p, "a");
            if (f) {
                setvbuf(f, NULL, _IOLBF, 0);
            }
        }
    }
    return f;
}

static void plog(TbiI2cProbe *s, const char *fmt, ...) G_GNUC_PRINTF(2, 3);
static void plog(TbiI2cProbe *s, const char *fmt, ...)
{
    FILE *f = tbi_probe_log();
    va_list ap;
    if (!f) {
        return;
    }
    fprintf(f, "%" PRId64 " T%02x ", qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL), s->parent_obj.address);
    va_start(ap, fmt);
    vfprintf(f, fmt, ap);
    va_end(ap);
    fputc('\n', f);
}

static bool is_regs(TbiI2cProbe *s)
{
    return s->personality && strcmp(s->personality, "regs") == 0;
}

static int probe_event(I2CSlave *i2c, enum i2c_event ev)
{
    TbiI2cProbe *s = TBI_I2C_PROBE(i2c);
    static const char *names[] = { "START_RECV", "START_SEND", "START_SEND_ASYNC", "FINISH", "NACK" };
    plog(s, "%s", ev <= I2C_NACK ? names[ev] : "?");
    if (ev == I2C_START_SEND) {
        s->first = true;
    }
    return 0;
}

static int probe_send(I2CSlave *i2c, uint8_t data)
{
    TbiI2cProbe *s = TBI_I2C_PROBE(i2c);
    if (is_regs(s)) {
        if (s->first) {
            s->first = false;
            s->ptr = data;
            plog(s, "SEND %02x (pointer)", data);
            return 0;
        }
        if (data == 0xee) {
            plog(s, "SEND %02x NACK", data);
            return 1;
        }
        s->regs[s->ptr++] = data;
        plog(s, "SEND %02x", data);
        return 0;
    }
    s->port = data;
    plog(s, "SEND %02x", data);
    return 0;
}

static uint8_t probe_recv(I2CSlave *i2c)
{
    TbiI2cProbe *s = TBI_I2C_PROBE(i2c);
    uint8_t v = is_regs(s) ? s->regs[s->ptr++] : s->port;
    plog(s, "RECV %02x", v);
    return v;
}

static void probe_realize(DeviceState *dev, Error **errp)
{
    TbiI2cProbe *s = TBI_I2C_PROBE(dev);
    for (int i = 0; i < 256; i++) {
        s->regs[i] = (uint8_t)(i ^ 0x5a);
    }
    s->port = 0xff;
}

static Property probe_props[] = {
    DEFINE_PROP_STRING("personality", TbiI2cProbe, personality),
    DEFINE_PROP_END_OF_LIST(),
};

static void probe_class_init(ObjectClass *klass, void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);
    I2CSlaveClass *k = I2C_SLAVE_CLASS(klass);
    dc->realize = probe_realize;
    device_class_set_props(dc, probe_props);
    k->event = probe_event;
    k->send = probe_send;
    k->recv = probe_recv;
}

static const TypeInfo probe_info = {
    .name = TYPE_TBI_I2C_PROBE,
    .parent = TYPE_I2C_SLAVE,
    .instance_size = sizeof(TbiI2cProbe),
    .class_init = probe_class_init,
};

static void probe_register(void)
{
    type_register_static(&probe_info);
}
type_init(probe_register)
