/*
 * TBI Lab external GPIO bridge
 *
 * Exposes an emulated ESP32 GPIO controller's pin state to a host process over a QEMU
 * chardev, and lets the host drive input levels back in. This is the QEMU-side half of the
 * Gate C MCU <-> electrical bridge.
 *
 * It deliberately contains NO board-specific or test-specific knowledge: it discovers the
 * GPIO device by QOM type at realize time, forwards whatever transitions the firmware
 * produces, and injects whatever levels the host sends. Nothing about any particular
 * circuit is encoded here.
 *
 * Line protocol (ASCII, newline terminated, both directions):
 *   QEMU -> host   O <pin> <level>     pin output level changed
 *   host -> QEMU   I <pin> <level>     drive an input pin to <level>
 *
 * Thread model: chardev read handlers and qemu_set_irq both run on the QEMU main loop
 * thread under the BQL, so no additional locking is required here.
 *
 * Copyright (c) 2026 TBI Lab
 *
 * This program is free software; you can redistribute it and/or modify it under the terms
 * of the GNU General Public License version 2 or (at your option) any later version.
 */

#include "qemu/osdep.h"
#include "qemu/error-report.h"
#include "qapi/error.h"
#include "hw/qdev-properties.h"
#include "hw/qdev-properties-system.h"
#include "hw/irq.h"
#include "chardev/char-fe.h"
#include "qom/object.h"

#define TYPE_TBI_GPIO_BRIDGE "tbi-gpio-bridge"

/*
 * Names published by the ESP32 GPIO device. Referenced as string literals so this file has
 * no build dependency on the ESP32 headers.
 */
#define TBI_GPIO_QOM_TYPE   "esp32.gpio"
#define TBI_GPIO_OUT_LINES  "esp32_gpios"
#define TBI_GPIO_IN_LINES   "esp32_gpios_in"

/* The ESP32 GPIO device publishes 32 output lines (bank 0) and 40 input lines. */
#define TBI_OUT_PINS 32
#define TBI_IN_PINS  40
#define TBI_RX_MAX   64

struct TbiGpioBridge {
    DeviceState parent_obj;

    CharBackend chr;
    qemu_irq in_lines[TBI_IN_PINS];
    char rx[TBI_RX_MAX];
    unsigned rx_len;
    /* Pins the host explicitly asked not to observe, as a 32-bit mask. */
    uint32_t ignore_mask;
};

OBJECT_DECLARE_SIMPLE_TYPE(TbiGpioBridge, TBI_GPIO_BRIDGE)

static void tbi_emit(TbiGpioBridge *s, char kind, int pin, int level)
{
    char buf[32];
    int len = snprintf(buf, sizeof(buf), "%c %d %d\n", kind, pin, level);
    if (len > 0) {
        qemu_chr_fe_write_all(&s->chr, (const uint8_t *)buf, len);
    }
}

/* Called by the GPIO device whenever an output pin changes level. */
static void tbi_pin_changed(void *opaque, int pin, int level)
{
    TbiGpioBridge *s = TBI_GPIO_BRIDGE(opaque);

    if (pin < 0 || pin >= TBI_OUT_PINS) {
        return;
    }
    if (s->ignore_mask & (1u << pin)) {
        return;
    }
    tbi_emit(s, 'O', pin, level ? 1 : 0);
}

static void tbi_handle_line(TbiGpioBridge *s, const char *line)
{
    int pin;
    int level;

    if (sscanf(line, "I %d %d", &pin, &level) == 2) {
        if (pin >= 0 && pin < TBI_IN_PINS && s->in_lines[pin]) {
            qemu_set_irq(s->in_lines[pin], level ? 1 : 0);
        }
    }
}

static int tbi_can_receive(void *opaque)
{
    TbiGpioBridge *s = TBI_GPIO_BRIDGE(opaque);
    return TBI_RX_MAX - s->rx_len;
}

static void tbi_receive(void *opaque, const uint8_t *buf, int size)
{
    TbiGpioBridge *s = TBI_GPIO_BRIDGE(opaque);

    for (int i = 0; i < size; i++) {
        char c = (char)buf[i];
        if (c == '\n' || c == '\r') {
            s->rx[s->rx_len] = '\0';
            if (s->rx_len > 0) {
                tbi_handle_line(s, s->rx);
            }
            s->rx_len = 0;
        } else if (s->rx_len < TBI_RX_MAX - 1) {
            s->rx[s->rx_len++] = c;
        } else {
            /* Overlong line: drop it rather than truncating into a bogus command. */
            s->rx_len = 0;
        }
    }
}

static void tbi_gpio_bridge_realize(DeviceState *dev, Error **errp)
{
    TbiGpioBridge *s = TBI_GPIO_BRIDGE(dev);
    Object *obj;
    DeviceState *gpio;

    if (!qemu_chr_fe_backend_connected(&s->chr)) {
        error_setg(errp, TYPE_TBI_GPIO_BRIDGE ": a chardev is required");
        return;
    }

    obj = object_resolve_path_type("", TBI_GPIO_QOM_TYPE, NULL);
    if (!obj) {
        error_setg(errp, TYPE_TBI_GPIO_BRIDGE ": no " TBI_GPIO_QOM_TYPE " device in this machine");
        return;
    }
    gpio = DEVICE(obj);

    /* Observe: route the GPIO controller's output lines into this device. */
    qdev_init_gpio_in(dev, tbi_pin_changed, TBI_OUT_PINS);
    for (int i = 0; i < TBI_OUT_PINS; i++) {
        if (s->ignore_mask & (1u << i)) {
            continue;
        }
        qdev_connect_gpio_out_named(gpio, TBI_GPIO_OUT_LINES, i, qdev_get_gpio_in(dev, i));
    }

    /* Inject: cache the controller's input lines so the host can drive them. */
    for (int i = 0; i < TBI_IN_PINS; i++) {
        s->in_lines[i] = qdev_get_gpio_in_named(gpio, TBI_GPIO_IN_LINES, i);
    }

    qemu_chr_fe_set_handlers(&s->chr, tbi_can_receive, tbi_receive, NULL, NULL, s, NULL, true);
}

static Property tbi_gpio_bridge_properties[] = {
    DEFINE_PROP_CHR("chardev", TbiGpioBridge, chr),
    /*
     * Pins already wired to something else by the board (a display, a button) must not be
     * hijacked. Bit N set => do not connect to output pin N.
     */
    DEFINE_PROP_UINT32("ignore-mask", TbiGpioBridge, ignore_mask, 0),
    DEFINE_PROP_END_OF_LIST(),
};

static void tbi_gpio_bridge_class_init(ObjectClass *klass, void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);

    dc->realize = tbi_gpio_bridge_realize;
    dc->user_creatable = true;
    dc->desc = "TBI Lab external GPIO bridge";
    device_class_set_props(dc, tbi_gpio_bridge_properties);
}

static const TypeInfo tbi_gpio_bridge_info = {
    .name = TYPE_TBI_GPIO_BRIDGE,
    .parent = TYPE_DEVICE,
    .instance_size = sizeof(TbiGpioBridge),
    .class_init = tbi_gpio_bridge_class_init,
};

static void tbi_gpio_bridge_register_types(void)
{
    type_register_static(&tbi_gpio_bridge_info);
}

type_init(tbi_gpio_bridge_register_types)
