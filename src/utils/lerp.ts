/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Clamp a number into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Clamp into [0, 1]. */
export function saturate(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * Frame-rate-independent damping. Use this instead of plain lerp(current, target, k)
 * inside RAF loops — the result of plain lerp depends on dt, this version doesn't.
 * `lambda` is "convergence rate" — higher = snappier.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/**
 * Smoothstep with explicit edges. Returns 0 if x <= edge0, 1 if x >= edge1, and
 * a Hermite-smooth ramp 3t² − 2t³ in between. Useful for anchor-strength ramps.
 */
export function smoothstep(x: number, edge0: number, edge1: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
