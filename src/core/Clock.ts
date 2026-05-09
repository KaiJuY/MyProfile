/**
 * Single source of truth for delta-time across all systems (Three.js render,
 * Rapier physics, GSAP-bound subscriptions). Using one Clock keeps physics +
 * rendering consistent — no two competing dt values.
 *
 * We deliberately do NOT use THREE.Clock here because:
 *  - We want to share dt with non-Three systems (Rapier, custom GSAP timers)
 *  - We want to clamp dt against tab-switch hangs (a 30s pause should not advance
 *    physics 30 seconds in one frame)
 */
export class Clock {
  private lastMs: number = -1;
  /** Maximum allowed dt in seconds. Prevents giant time jumps after tab unfocus. */
  private readonly maxDt: number;

  constructor(maxDt = 0.1) {
    this.maxDt = maxDt;
  }

  /**
   * Returns delta-time in seconds since the previous tick. First call after
   * construction returns 0 (no previous frame to diff against).
   */
  tick(nowMs: number): number {
    if (this.lastMs < 0) {
      this.lastMs = nowMs;
      return 0;
    }
    const dt = (nowMs - this.lastMs) / 1000;
    this.lastMs = nowMs;
    return Math.min(dt, this.maxDt);
  }

  reset(): void {
    this.lastMs = -1;
  }
}
