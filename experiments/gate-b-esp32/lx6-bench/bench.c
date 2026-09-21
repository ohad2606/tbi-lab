/*
 * Bare-metal classic-ESP32 (Xtensa LX6) CPU benchmark for Phase 5.
 *
 * Runs on QEMU's generic `sim` machine with `-cpu esp32`, so the SAME binary can be timed
 * under native QEMU and under QEMU compiled to WebAssembly. This measures LX6 *instruction
 * execution speed* only. It is NOT an ESP32 system (no ROM, no peripherals, no GPIO) and
 * does not count as running classic ESP32 firmware in the browser.
 *
 * Output goes through Xtensa semihosting (simcall): SYS_write = 4, SYS_exit = 1.
 */

#include <stdint.h>

#ifndef ITERATIONS
#define ITERATIONS 20000000u
#endif

static long simcall3(long nr, long a, long b, long c)
{
    register long a2 __asm__("a2") = nr;
    register long a3 __asm__("a3") = a;
    register long a4 __asm__("a4") = b;
    register long a5 __asm__("a5") = c;
    __asm__ volatile("simcall" : "+r"(a2), "+r"(a3) : "r"(a4), "r"(a5) : "memory");
    return a2;
}

static void write_str(const char *s)
{
    long n = 0;
    while (s[n]) n++;
    simcall3(4, 1, (long)s, n);
}

static void write_hex(uint32_t v)
{
    char buf[11] = "0x00000000";
    for (int i = 0; i < 8; i++) {
        uint32_t nib = (v >> (28 - 4 * i)) & 0xF;
        buf[2 + i] = (char)(nib < 10 ? '0' + nib : 'a' + nib - 10);
    }
    write_str(buf);
}

/* Deterministic integer workload: xorshift32 plus a multiply-accumulate and a branch. */
int main(void)
{
    uint32_t x = 2463534242u;
    uint32_t acc = 0;
    for (uint32_t i = 0; i < ITERATIONS; i++) {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        acc += x * 2654435761u;
        if (acc & 1u) acc ^= i;
    }
    write_str("TBI-LX6-BENCH checksum=");
    write_hex(acc);
    write_str("\n");
    simcall3(1, 0, 0, 0);
    for (;;) {}
}
