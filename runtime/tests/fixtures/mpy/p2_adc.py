# Sprint 18 probe P2: ADC read (root cause of the Sprint 17C guest crash).
from machine import ADC, Pin
print('ADC-START')
a = ADC(Pin(34))
print('ADC-OBJ', a)
print('ADC-VAL', a.read_u16())
print('ADC-DONE')
