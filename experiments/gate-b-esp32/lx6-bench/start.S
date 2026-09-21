    .section .text.start, "ax"
    .global _start
    .align 4
_start:
    /*
     * Reset leaves PS = 0x1f: INTLEVEL 15 with PS.EXCM set. The Xtensa ISA disables
     * zero-overhead loop-back while PS.EXCM is set, so leaving it set silently breaks every
     * hardware loop the compiler emits. Real firmware clears it during startup; so do we.
     * PS = 0x0f keeps interrupts masked (INTLEVEL 15) with EXCM clear.
     */
    movi    a2, 0x0f
    wsr     a2, ps
    rsync
    movi    a1, 0x3FFFFFF0      /* stack at the top of data RAM (0x3FF80000 + 512 KiB) */
    movi    a0, 0
    call0   main
1:  j       1b
