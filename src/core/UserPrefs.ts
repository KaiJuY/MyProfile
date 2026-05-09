/**
 * Step 08 — Centralized user/environment preferences and capability flags.
 *
 * Why a single object instead of individual matchMedia calls scattered across
 * scenes?
 *  - matchMedia evaluation is cheap but not free; computing once at boot keeps
 *    scene-init code readable
 *  - Allows a deterministic override via URL params for testing (?reduce=1,
 *    ?mobile=1, ?nogate=1, ?debug=1, ?quality=low|medium|high)
 *  - Gives a single audit point for what "reduced motion" / "mobile" mean
 *
 * Scenes still keep their own `isMobile` mobile gates (they were authored that
 * way in steps 02–07 and the playbook explicitly says "DO NOT regress"), but
 * NEW behaviour added in step 08 — postprocessing pipeline, loader gating,
 * reduced-motion branches, FPS counter — reads from this single source.
 */
export interface UserPrefs {
  /** Coarse pointer or small viewport — degrade aggressively. */
  isMobile: boolean;
  /** OS-level reduced-motion media query. */
  reducedMotion: boolean;
  /** ?debug=1 was passed in URL. */
  debug: boolean;
  /** ?nogate=1 — skip the click-to-enter loader gate (verification harness uses this). */
  noGate: boolean;
  /** ?quality= override (null = auto). */
  qualityOverride: 'high' | 'medium' | 'low' | null;
}

/**
 * Module-level cached prefs. Lazily computed on first read so scenes that don't
 * receive an explicit `prefs` argument can still consult the same answer.
 */
let cached: UserPrefs | null = null;
export function getUserPrefs(): UserPrefs {
  if (!cached) cached = detectUserPrefs();
  return cached;
}

export function detectUserPrefs(): UserPrefs {
  const params =
    typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;

  const debug = params?.get('debug') === '1';
  const noGate = params?.get('nogate') === '1';
  const qParam = params?.get('quality');
  const qualityOverride: UserPrefs['qualityOverride'] =
    qParam === 'high' || qParam === 'medium' || qParam === 'low' ? qParam : null;

  const reduceParam = params?.get('reduce') === '1';
  const reducedMotion =
    reduceParam ||
    (typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const mobileParam = params?.get('mobile') === '1';
  const isMobile =
    mobileParam ||
    (typeof window !== 'undefined' &&
      (window.innerWidth < 768 ||
        (typeof window.matchMedia === 'function' &&
          window.matchMedia('(pointer: coarse)').matches)));

  return { isMobile, reducedMotion, debug, noGate, qualityOverride };
}
