import * as THREE from 'three';

/**
 * PathBuilder — builds the CatmullRom curve that the camera flies along,
 * plus stores per-milestone metadata (label date strings, scroll-t mapping).
 *
 * Path metaphor: career trajectory ascending. The path slopes upward AND
 * forward (positive Y, negative Z) over its length, reading as "moving
 * toward the next thing" rather than a flat ribbon.
 *
 * Control-point selection (playbook §2):
 *   Milestone 1 (oldest, NYCU 2010.09):  (0, 0, 0)        ← path start
 *   Milestone 2 (Tokyo Electron 2018):   (3, 1, -8)
 *   Milestone 3 (JCC 2021):              (6, 2, -16)
 *   Milestone 4 (SunSun 2025.11):        (9, 3, -24)
 *   "now" / past-end:                    (12, 4, -32)     ← path end (trailing)
 *
 * The 5th point sits PAST the final milestone so curve.getTangent at the
 * last marker isn't degenerate (CatmullRom's endpoint behavior). It also
 * gives us a nice "fly past the present" exit transition.
 *
 * The curve type is "centripetal" CatmullRom — the standard recommendation
 * for camera paths because it avoids the cusps/loops that "uniform" can
 * produce when control points cluster. tension=0.5 (default) keeps the
 * curvature subtle.
 */

export interface Milestone {
  /** Date string shown in HUD POS readout. */
  date: string;
  /** Position along curve in [0,1]. */
  t: number;
  /** Index in path (0..N-1). */
  step: number;
  /** Reference world position (the curve point at this t). */
  position: THREE.Vector3;
}

export interface BuiltPath {
  curve: THREE.CatmullRomCurve3;
  milestones: Milestone[];
  /** Total milestone count for STEP "n / total" readout. */
  totalSteps: number;
}

const CONTROL_POINTS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [3, 1, -8],
  [6, 2, -16],
  [9, 3, -24],
  [12, 4, -32],
];

/**
 * The 4 visible milestone markers correspond to the first 4 control points
 * (oldest → newest). We don't render a marker for the trailing 5th point —
 * it's only there to extend the curve so the camera can fly past SunSun.
 *
 * Their `t` values come from how CatmullRomCurve3 distributes points along
 * an arc-length-parameterized curve. With 5 evenly-spaced control points
 * we use t = i / (N-1) where N=4 markers fall at indices 0..3 of 5 points.
 * That gives t = 0.0, 0.25, 0.50, 0.75 → arc-length-aligned.
 *
 * BUT: the camera should pass each marker at sectionProgress aligned to its
 * place in the timeline. We use t = step / (totalMarkers - 1) which gives
 * 0.0 / 0.333 / 0.667 / 1.0 — meaning the path runs across the full section
 * scroll. The last marker (SunSun) is at t=1.0; the trailing control point
 * is reached only by camera lookAhead overshoot. Good — that's the "exit"
 * fly-past sensation per playbook §8.
 */
const MILESTONE_DATES: ReadonlyArray<string> = [
  '2010.09', // NYCU education
  '2018.02', // Tokyo Electron
  '2021.06', // JCC
  '2025.11', // SunSun
];

export function buildPath(): BuiltPath {
  const points = CONTROL_POINTS.map(
    ([x, y, z]) => new THREE.Vector3(x, y, z)
  );
  // centripetal CatmullRom — no cusps even with non-uniform spacing.
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);

  // Milestone t values: with 5 control points, the first 4 (visible markers)
  // sit at curve parameter t = i / (CONTROL_POINTS.length - 1) = 0, 0.25, 0.5, 0.75.
  // The 5th control point at t=1.0 is the trailing "fly past SunSun" extrapolation
  // — NO marker is rendered there. This way the camera reaches SunSun at
  // sectionProgress = 0.75 and CONTINUES past it through the exit transition.
  //
  // BUT we also want HTML fade-in to feel like "milestone reached at the same
  // time the camera passes its marker", so we use these same t values for the
  // .tl-item fade computation. (The rest of the code drives pathT = saturate(sp),
  // so at sp=1.0 the camera is at curve t=1.0 = past SunSun.)
  // EVEN-SPACED milestone t-values across the full curve (Issue #2 — user
  // wanted "每個環出現的滾動間隔好像有點不一致" / smoother spacing). Previously
  // markers landed at t = i/(N-1) where N=4 segments → 0, 0.25, 0.5, 0.75
  // (last one stranded mid-curve). With evenly spaced t = (i+1)/(N+1) — i.e.
  // 0.20, 0.40, 0.60, 0.80 — the 4 markers split the path into 5 equal
  // intervals and the camera passes each at sectionProgress midpoints
  // approximately {0.50, 0.64, 0.78} (matches Issue #2's required midpoints
  // when combined with the [0.36, 0.92] band in TrajectoryScene).
  const totalSteps = MILESTONE_DATES.length; // 4
  const milestones: Milestone[] = [];
  for (let i = 0; i < totalSteps; i++) {
    const t = (i + 1) / (totalSteps + 1); // 0.20, 0.40, 0.60, 0.80
    const pos = curve.getPoint(t);
    milestones.push({
      date: MILESTONE_DATES[i],
      t,
      step: i,
      position: pos.clone(),
    });
  }

  return { curve, milestones, totalSteps };
}

/**
 * Default camera state outside the trajectory section. Other scenes
 * (Hero/Pursuits/Work/Toolkit) all assume camera at (0,0,5) looking at origin.
 */
export const DEFAULT_CAMERA_POSITION = new THREE.Vector3(0, 0, 5);
export const DEFAULT_CAMERA_LOOKAT = new THREE.Vector3(0, 0, 0);
