ENTRY(_start)
MEMORY {
  iram (rwx) : ORIGIN = 0x40000400, LENGTH = 0x3FFC00
  dram (rw)  : ORIGIN = 0x3FF80000, LENGTH = 0x7FF00
}
SECTIONS {
  .text : { *(.text.start) *(.literal .text .literal.* .text.*) } > iram
  .rodata : { *(.rodata .rodata.*) } > dram
  .data : { *(.data .data.*) } > dram
  .bss : { *(.bss .bss.* COMMON) } > dram
}
