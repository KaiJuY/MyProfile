/**
 * Shared vertex-shader morph pattern (Lusion technique #3) used by every Pursuits
 * frame. The morph is a pure-math sweep keyed on a single uniform `uMorphProgress`
 * (0 = invisible, 1 = fully visible) so a frame's entrance/exit is one tween away.
 *
 * Pattern:
 *   - We define a "wave front" plane in object space whose Y-position lerps from
 *     -1.5 (well below the geometry) to +1.5 (well above) as uMorphProgress goes
 *     0→1.
 *   - For each vertex: distance = position.y - waveY.
 *       distance < 0  → vertex is BEHIND the wave (already swept) → at rest, alpha=1
 *       distance ≈ 0  → AT the wave → small displacement noise, alpha mid
 *       distance > 0  → AHEAD of the wave (not yet swept) → pushed along normal
 *                       (looks like the geometry is exploding/condensing) + alpha=0
 *   - The mask is a smoothstep(0, BAND, distance), so flipped: 1 ahead, 0 behind.
 *     We use vAlpha = 1 - mask so frags can multiply their color.
 *
 * Each frame's vertex shader injects this snippet via `getMorphVertexCommon()`,
 * declares the standard uniforms it expects, and writes its own gl_Position from
 * `morphedPosition`. Each frame's fragment shader multiplies its output by
 * `vAlpha` to fade in/out cleanly with the wave.
 *
 * Timing note (playbook §"踩雷預警"): 300ms reads as a flash. We aim 800–1200ms.
 * That's set by the caller via the tween rate, not here.
 *
 * Direction note: setting uMorphDirection = +1 makes the wave sweep bottom→top
 * (entrance feels like rising). -1 sweeps top→bottom (exit feels like falling).
 * Combined with running 0→1 vs 1→0 you get four flavours; we mostly use +1 with
 * a 0→1 sweep on entry and a 1→0 sweep on exit to read consistently.
 */

/**
 * Snippet injected into every frame's vertex shader. Provides:
 *   - `getMorphedPosition(vec3 position, vec3 normal)` — call from main()
 *   - varying `vAlpha` — write through to fragment shader
 *
 * Required uniforms (declared by caller above the snippet):
 *   uniform float uMorphProgress;   // 0..1
 *   uniform float uTime;            // seconds, for shimmer at the wave
 *   uniform float uMorphDirection;  // +1 (bottom→top) or -1 (top→bottom)
 *   uniform float uMorphBand;       // wave band thickness in object-space units
 *   uniform float uMorphDisplace;   // how far ahead-of-wave verts are pushed
 *   uniform vec3  uMorphAxisRange;  // min, max of the morph axis (geometry extent)
 */
export function getMorphVertexCommon(): string {
  return /* glsl */ `
    varying float vAlpha;

    // Cheap hash → pseudo-random in [0,1]. Used for shimmer noise at the wave.
    float morphHash(vec3 p) {
      return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    }

    // Computes the displaced object-space position and writes vAlpha for the
    // fragment shader. Returns the position you should feed to MVP transform.
    vec3 getMorphedPosition(vec3 pos, vec3 nrm) {
      // Lerp the wave-front position across the geometry's morph-axis extent,
      // padded so the wave starts fully outside (alpha=0 everywhere) and ends
      // fully past (alpha=1 everywhere).
      float lo = uMorphAxisRange.x - uMorphBand;
      float hi = uMorphAxisRange.y + uMorphBand;
      float waveY = mix(lo, hi, uMorphProgress);

      // Signed distance from this vertex to the wave-front plane (object Y).
      // Direction reverses the sign so a -1 axis sweeps top→bottom.
      float d = (pos.y - waveY) * uMorphDirection;

      // mask = 1 ahead of the wave (not yet swept), 0 behind (settled).
      float mask = smoothstep(0.0, uMorphBand, d);

      // Behind-the-wave verts sit at rest; ahead-of-wave verts are pushed along
      // their normal (looks like geometry condensing in). At the wave itself we
      // add a tiny bit of shimmer-noise so the front isn't surgical.
      float shimmer = (morphHash(pos + vec3(uTime)) - 0.5) * 0.06 * (1.0 - abs(0.5 - mask) * 2.0);
      vec3 displaced = pos + nrm * (mask * uMorphDisplace + shimmer);

      // Fragment alpha = visibility = 1 - mask. Squared for snappier edge.
      vAlpha = 1.0 - mask;
      vAlpha = clamp(vAlpha * vAlpha * (3.0 - 2.0 * vAlpha), 0.0, 1.0);

      return displaced;
    }
  `;
}

/**
 * Fragment-side declaration to drop in. Use `vAlpha` in your fragment by
 * multiplying your final color: `gl_FragColor.a *= vAlpha;`.
 */
export function getMorphFragmentCommon(): string {
  return /* glsl */ `
    varying float vAlpha;
  `;
}

/**
 * Standard morph uniforms each frame's material needs. Call from material init
 * to seed defaults; each frame still owns the THREE.IUniform objects (so we can
 * tween the .value across frames).
 */
export interface MorphUniforms {
  uMorphProgress: { value: number };
  uTime: { value: number };
  uMorphDirection: { value: number };
  uMorphBand: { value: number };
  uMorphDisplace: { value: number };
  uMorphAxisRange: { value: { x: number; y: number; z: number } };
}

export function createMorphUniforms(opts?: {
  direction?: number;
  band?: number;
  displace?: number;
  axisMin?: number;
  axisMax?: number;
}): MorphUniforms {
  // Defaults tuned for object-space geometries roughly 1 unit tall.
  return {
    uMorphProgress: { value: 0 },
    uTime: { value: 0 },
    uMorphDirection: { value: opts?.direction ?? 1 },
    uMorphBand: { value: opts?.band ?? 0.35 },
    uMorphDisplace: { value: opts?.displace ?? 0.25 },
    uMorphAxisRange: {
      value: { x: opts?.axisMin ?? -0.6, y: opts?.axisMax ?? 0.6, z: 0 },
    },
  };
}
