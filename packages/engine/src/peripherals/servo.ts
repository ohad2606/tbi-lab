/**
 * Hobby servo semantics (Sprint 10, internal), TowerPro SG90. The position derives ONLY from the
 * control signal: high-pulse widths measured from the signal's edges (time-stamped, as a runtime
 * bridge reports pad edges). There is no way to set an angle except by pulses.
 *
 * - A pulse is valid between 400 and 2600 us and at most 50 ms after the previous rising edge
 *   (a 20 ms frame is nominal); anything else is ignored (no invented reaction).
 * - Commanded angle: 1.0-2.0 ms maps linearly to 0-180 degrees (nominal +-90 around 1.5 ms), clamped
 *   to the travel. ASSUMPTION: the sources conflict (TowerPro: about 150 degrees travel; vendor
 *   sheets: 1-2 ms for +-90, or 500-2400 us); this map is the defensible nominal and is a parameter.
 * - Deadband 10 us (vendor sheet; TowerPro says 1 us): width changes below it leave the target.
 * - The output slews to the target at 60 degrees per 0.1 s (TowerPro, 4.8 V), deterministically.
 * - Without pulses the servo holds its last position (no torque model).
 */
export interface ServoSpec {
  minPulseUs: number;
  maxPulseUs: number;
  travelDeg: number;
  deadbandUs: number;
  slewDegPerS: number;
}

export const SG90: ServoSpec = {
  minPulseUs: 1000,
  maxPulseUs: 2000,
  travelDeg: 180,
  deadbandUs: 10,
  slewDegPerS: 600,
};

export class Servo {
  private level: 0 | 1 = 0;
  private riseNs: bigint | null = null;
  private lastRiseNs: bigint | null = null;
  private acceptedUs: number | null = null;
  private positionDeg: number;
  private targetDeg: number;
  private atNs = 0n;
  /** The most recent pulses (bounded: a running session sends 50 per second). */
  readonly pulses: { atNs: bigint; widthUs: number; accepted: boolean }[] = [];
  static readonly PULSE_HISTORY = 64;
  /** Sprint 15: every pulse measured so far (the bounded history keeps only the latest). */
  pulseCount = 0;

  constructor(
    readonly spec: ServoSpec = SG90,
    initialDeg = spec.travelDeg / 2,
  ) {
    this.positionDeg = initialDeg;
    this.targetDeg = initialDeg;
  }

  /** The signal changed level at `tNs` (simulation time, nanoseconds, non-decreasing). */
  edge(tNs: bigint, level: 0 | 1): void {
    this.advanceTo(tNs);
    if (level === this.level) return;
    this.level = level;
    if (level === 1) {
      const gap = this.lastRiseNs === null ? 0n : tNs - this.lastRiseNs;
      this.lastRiseNs = tNs;
      this.riseNs = gap > 50_000_000n ? null : tNs; // a frame longer than 50 ms restarts timing
      if (this.pulses.length === 0) this.riseNs = tNs;
      return;
    }
    if (this.riseNs === null) return;
    const widthUs = Number(tNs - this.riseNs) / 1000;
    this.riseNs = null;
    const valid = widthUs >= 400 && widthUs <= 2600;
    const moved =
      this.acceptedUs === null || Math.abs(widthUs - this.acceptedUs) >= this.spec.deadbandUs;
    const accepted = valid && moved;
    this.pulses.push({ atNs: tNs, widthUs, accepted });
    this.pulseCount++;
    if (this.pulses.length > Servo.PULSE_HISTORY) this.pulses.shift();
    if (!accepted) return;
    this.acceptedUs = widthUs;
    const { minPulseUs: lo, maxPulseUs: hi, travelDeg } = this.spec;
    const f = (widthUs - lo) / (hi - lo);
    this.targetDeg = Math.min(travelDeg, Math.max(0, f * travelDeg));
  }

  /**
   * Sprint 17C: the signal became unknown (the runtime host's placeholder interval): a pulse in
   * progress is not measured, the next valid pulse starts timing afresh.
   */
  discardPulse(): void {
    this.riseNs = null;
  }

  /** Move the output toward the target until `tNs` at the slew rate. */
  advanceTo(tNs: bigint): void {
    if (tNs < this.atNs) throw new Error('servo time must not go backwards');
    const dt = Number(tNs - this.atNs) / 1e9;
    this.atNs = tNs;
    const step = this.spec.slewDegPerS * dt;
    const d = this.targetDeg - this.positionDeg;
    this.positionDeg =
      Math.abs(d) <= step ? this.targetDeg : this.positionDeg + Math.sign(d) * step;
  }

  /**
   * Sprint 15: time passes without motion (the servo is unpowered): the output stays where it is
   * and the signal is not read; the next `advanceTo` slews only from `tNs` on.
   */
  holdUntil(tNs: bigint): void {
    if (tNs < this.atNs) throw new Error('servo time must not go backwards');
    this.atNs = tNs;
  }

  /** The width of the last accepted pulse (us), or null before the first. */
  get acceptedPulseUs(): number | null {
    return this.acceptedUs;
  }

  get angleDeg(): number {
    return this.positionDeg;
  }
  get commandedDeg(): number {
    return this.targetDeg;
  }
}
