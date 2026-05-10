import * as THREE from 'three';

import {
  loadGolfAndTee,
  disposeGolfAndTee,
  type TeeMetrics as TeeMetricsInner,
} from './golfAndTee';

/**
 * Backwards-compat shim — the dedicated `/models/golf_tee.glb` is gone; the
 * tee mesh now lives inside the combined `/models/GolfAndTee.glb` (loaded by
 * `golfAndTee.ts`). This module preserves the public API
 * (`loadGolfTeeGeometry`, `getTeeMetrics`, `disposeSharedTeeAssets`) so any
 * unconverted call site keeps compiling.
 */

export type TeeMetrics = TeeMetricsInner;

let _cachedMetrics: TeeMetrics | null = null;

export function getTeeMetrics(): TeeMetrics | null {
  return _cachedMetrics;
}

/**
 * Load the tee geometry from the combined GLB. Url is ignored — tee lives in
 * `GolfAndTee.glb`.
 */
export async function loadGolfTeeGeometry(
  url?: string
): Promise<THREE.BufferGeometry> {
  void url;
  const { teeGeom, teeMetrics } = await loadGolfAndTee();
  _cachedMetrics = teeMetrics;
  return teeGeom;
}

/** Free the cached GLB tee geometry. Called only on full app teardown. */
export function disposeSharedTeeAssets(): void {
  // The combined GLB cache is owned by `golfAndTee.ts`. We only need to drop
  // our local metrics reference — actual disposal happens once via
  // `disposeGolfAndTee`, called from `disposeSharedGolfBallAssets`.
  _cachedMetrics = null;
  // Also call the unified disposer in case the ball-side disposer wasn't
  // called (defensive for unit tests).
  disposeGolfAndTee();
}
