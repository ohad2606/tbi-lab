/**
 * HC-SR04 ultrasonic ranging semantics (Sprint 10, internal). The simulated ENVIRONMENT is the
 * distance to a flat target (and the air temperature); the module's observable behaviour is its
 * ECHO pulse timing in response to a trigger pulse (Elecfreaks datasheet): a TTL trigger of at
 * least 10 us starts an 8-cycle 40 kHz burst; ECHO then goes high for the round-trip time,
 * width = 2 d / c (the datasheet's us/58 = cm at 340 m/s).
 *
 * Speed of sound: c = 331.3 + 0.606 T m/s (T in degC; dry air, the standard linear approximation).
 * The ECHO rise is taken at the end of the 200 us burst (ASSUMPTION: the datasheet's timing diagram
 * shows the burst before ECHO but gives no delay figure). Outside the 2 cm - 4 m range, or with a
 * short trigger, the model gives no echo (the module's no-target behaviour is not specified: none
 * is invented).
 */
export interface Echo {
  riseNs: bigint;
  fallNs: bigint;
  widthUs: number;
}

export const HC_SR04 = {
  minTriggerUs: 10,
  burstUs: (8 / 40_000) * 1e6,
  minRangeM: 0.02,
  maxRangeM: 4,
};

export const speedOfSound = (tempC: number) => 331.3 + 0.606 * tempC;

/** The echo for a trigger pulse that fell at `triggerFallNs` after `triggerWidthUs` high. */
export function hcsr04Echo(
  triggerFallNs: bigint,
  triggerWidthUs: number,
  distanceM: number,
  tempC = 20,
): Echo | null {
  if (triggerWidthUs < HC_SR04.minTriggerUs) return null;
  if (distanceM < HC_SR04.minRangeM || distanceM > HC_SR04.maxRangeM) return null;
  const widthUs = ((2 * distanceM) / speedOfSound(tempC)) * 1e6;
  const riseNs = triggerFallNs + BigInt(Math.round(HC_SR04.burstUs * 1000));
  return { riseNs, fallNs: riseNs + BigInt(Math.round(widthUs * 1000)), widthUs };
}
