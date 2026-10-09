// P-9 oracle: feed every byte the 0x27 target received into the ENGINE's I2C LCD model.
import { readFileSync } from 'node:fs';
import { I2cLcd } from '/home/ubuntu/projects/tbi-lab-s11/packages/engine/src/peripherals/hd44780.ts';
const lcd = new I2cLcd(0x27);
let n = 0;
for (const line of readFileSync(process.argv[2], 'utf8').split('\n')) {
  const m = / T27 SEND ([0-9a-f]{2})$/.exec(line);
  if (m) { lcd.expander.writeByte(parseInt(m[1]!, 16)); n++; }
}
const rows = lcd.text();
console.log(JSON.stringify({ bytes: n, rows, backlight: lcd.backlight, displayOn: lcd.controller.displayOn, twoLines: lcd.controller.twoLines }));
console.log(rows[0]!.startsWith('Hello') && rows[0]!.slice(5).trim() === '' && rows[1]!.trim() === '' ? 'P-9 PASS' : 'P-9 FAIL');
