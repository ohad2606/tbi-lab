/**
 * DHT22 / AM2302 single-wire protocol semantics (Sprint 10, internal). The simulated ENVIRONMENT is
 * the temperature and relative humidity; the sensor's observable behaviour is its 40-bit frame on
 * the DATA line after a host start signal (Aosong AM2302 sheet, p.3-4):
 *
 * - host holds DATA low >= 1 ms, then releases; the sensor answers 80 us low + 80 us high;
 * - each bit: 50 us low, then high 26-28 us ("0", model 27 us) or 70 us ("1");
 * - frame: 16-bit RH x10, 16-bit T x10 (bit 15 = sign), 8-bit checksum = sum of the 4 bytes & 0xFF.
 * Values are rounded to the sensor's 0.1 resolution; outside 0-100 %RH / -40-80 degC no frame is
 * produced. Accuracy (+-2 %RH, +-0.5 degC) is the real part's; the model reports the environment
 * exactly (deterministic) and documents that it does not add error.
 */
export function dht22Frame(rh: number, tempC: number): number[] | null {
  if (!(rh >= 0 && rh <= 100 && tempC >= -40 && tempC <= 80)) return null;
  const h = Math.round(rh * 10);
  const tAbs = Math.round(Math.abs(tempC) * 10);
  const t = (tempC < 0 ? 0x8000 : 0) | tAbs;
  const bytes = [h >> 8, h & 0xff, t >> 8, t & 0xff];
  return [...bytes, bytes.reduce((a, b) => a + b, 0) & 0xff];
}

export function decodeDht22(frame: readonly number[]): { rh: number; tempC: number } | null {
  if (frame.length !== 5) return null;
  if ((frame.slice(0, 4).reduce((a, b) => a + b, 0) & 0xff) !== frame[4]) return null;
  const h = (frame[0]! << 8) | frame[1]!;
  const t = (frame[2]! << 8) | frame[3]!;
  return { rh: h / 10, tempC: ((t & 0x7fff) / 10) * (t & 0x8000 ? -1 : 1) };
}

/** The DATA waveform the sensor drives after the host releases the line: [level, durationUs][]. */
export function dht22Waveform(frame: readonly number[]): [0 | 1, number][] {
  const out: [0 | 1, number][] = [
    [0, 80],
    [1, 80],
  ];
  for (const byte of frame)
    for (let i = 7; i >= 0; i--) {
      out.push([0, 50]);
      out.push([1, (byte >> i) & 1 ? 70 : 27]);
    }
  out.push([0, 50]); // the sensor's final low, then it releases the line
  return out;
}
