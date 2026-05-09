import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { SceneModule } from './SceneManager';
import { elementToWorld, elementToWorldSize } from '@core/ScreenToWorld';
import type { PhysicsWorld } from '@physics/PhysicsWorld';
import { damp, lerp, clamp } from '@utils/lerp';

/**
 * HeroScene — Lusion-style 3D golf ball with Rapier physics, mouse-as-club
 * impulse, stencil-clipped viewing window, and live TrackMan-style stats.
 *
 * Architecture (composition over inheritance):
 *  - This module owns: ball mesh + body, mouse cursor collider, stencil mask
 *    mesh, stat-binding state, SVG trail overlay, mobile fallback flag.
 *  - It does NOT own: scene/camera/renderer/physics-world (injected by App).
 *
 * Stencil clipping (technique #4): two passes share the same THREE.Scene but
 * different renderOrder. Pass 1 (renderOrder=1) writes ref=1 into the stencil
 * buffer wherever the rounded-rect mask covers; pass 2 (renderOrder=2) draws
 * the ball with stencilFunc=EQUAL, ref=1 — it ONLY paints where the mask wrote.
 * autoClearStencil is left at its default (true) so the buffer resets each frame.
 *
 * Physics (technique #5): kinematic-position-based body for the cursor (we set
 * its translation directly, Rapier moves it correctly across substeps); dynamic
 * body for the ball with 0 gravity (we want it to float; we apply our own
 * anchor-spring + idle-noise + cursor-amplified impulse).
 *
 * Material (technique #6 simplified): MeshMatcapMaterial cannot be subclassed
 * with arbitrary shader edits without onBeforeCompile pain — instead we build
 * a small custom ShaderMaterial that combines:
 *   - matcap sample by view-space perturbed normal
 *   - procedural dimple normal-map (256-dimple Fibonacci lattice on the surface)
 *   - subtle fresnel rim term for cool-edge separation
 * Result is monochrome pearl/silver with visible dimples — no neon, no rainbow.
 */

// -----------------------------------------------------------------------------
// Tuned constants (each documented with what it controls)
// -----------------------------------------------------------------------------

/** Mouse-velocity → ball-impulse multiplier. Higher = harder hits per pixel. */
const AMPLIFY = 7;
/** EMA smoothing factor for mouse velocity (lower = smoother but laggier). */
const MOUSE_VEL_EMA = 0.25;
/** ms after last mousemove event before we treat the cursor as stationary. */
const MOUSE_IDLE_MS = 50;
/** ms after last ball-cursor contact before we re-engage anchor spring. */
const ANCHOR_REENGAGE_MS = 800;
/** Anchor critical-damp lambda (higher = snappier return to home position). */
const ANCHOR_LAMBDA = 4;
/** Linear velocity damping lambda used on idle-return. */
const VEL_DAMP_LAMBDA = 6;
/** Idle "wind on tee" impulse magnitude. */
const IDLE_NOISE_IMPULSE = 0.0015;
/** Idle noise period (seconds between random impulses). */
const IDLE_NOISE_PERIOD = 0.35;
/** Stat smoothing factor (higher = stats track physics faster, more jittery). */
const STAT_LERP = 0.12;
/** Stat decay-back-to-baseline lambda when idle. */
const STAT_BASELINE_LAMBDA = 0.7;
/** ms threshold for "recent hit" — stats decay to baseline after this. */
const STAT_HOT_MS = 1200;
/** Ball linear-velocity threshold for "launch" classification (m/s, fake units). */
const LAUNCH_THRESHOLD = 3;
/** SVG trail fade-out duration (ms). */
const TRAIL_FADE_MS = 2000;
/** Camera distance the ball lives at (world units in front of camera at z=5). */
const HERO_DEPTH = 5;
/** Ball radius (world units). */
const BALL_RADIUS = 0.5;
/** Cursor-collider radius (world units). */
const CURSOR_RADIUS = 0.3;
/** Baseline TrackMan numbers shown when idle. */
const BASELINE_SPIN = 2840;
const BASELINE_LAUNCH = 11.2;
const BASELINE_CARRY = 262;

// Mobile gate: low-end touch devices skip physics + interaction entirely.
const isMobile =
  typeof window !== 'undefined' &&
  (window.innerWidth < 768 ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches));

// -----------------------------------------------------------------------------
// Procedural dimple normal map
// -----------------------------------------------------------------------------

/**
 * Build a 512×512 RGBA normal map with ~250 dimples laid out in a Fibonacci
 * lattice across the UV plane (which on a sphere mapping approximates an even
 * spread of points without UV-pole singularities).
 *
 * Encoding: pixel rgb = (nx*0.5+0.5, ny*0.5+0.5, nz*0.5+0.5). Flat surface =
 * (128,128,255). Each dimple is a small *depression* — at the dimple center
 * the surface is pushed inward, so the local normal still points roughly outward
 * (positive nz) but the gradient around the rim of the dimple has nx/ny pointing
 * radially OUT of the dimple center (so light grazing across the surface catches
 * the dimple rims and shadows the wells — the classic dimple look).
 *
 * Mathematically: we approximate a spherical-cap depression via a smooth radial
 * profile h(r) = -depth * smoothstep_pulse(r/R), then take its gradient (∇h)
 * and convert to a tangent-space normal by (-dh/du, -dh/dv, 1) / |...|. The
 * "outward at center" appearance comes from the smoothstep profile having zero
 * gradient at r=0 (the bottom of the well) — so the normal there is exactly
 * (0,0,1) (flat-up), and the gradient peaks at the rim where the dimple meets
 * the surface.
 */
function buildDimpleNormalMap(
  size: number = 512,
  dimpleCount: number = 250,
  dimpleRadiusPx: number = 14,
  dimpleDepth: number = 0.55
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('HeroScene: failed to acquire 2D context for dimple map');
  }

  const img = ctx.createImageData(size, size);
  const data = img.data;

  // Fill with flat-up normal (0,0,1) → encoded (128,128,255).
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 128;
    data[i + 1] = 128;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }

  // Fibonacci lattice in [0,1)^2 — gives a ~uniform spread without lattice bands.
  // Reference: golden-ratio-based low-discrepancy sequence.
  const PHI = (1 + Math.sqrt(5)) / 2;
  const dimples: { cx: number; cy: number }[] = [];
  for (let i = 0; i < dimpleCount; i++) {
    const u = (i / PHI) % 1;
    const v = (i + 0.5) / dimpleCount;
    dimples.push({ cx: u * size, cy: v * size });
  }

  // Radial profile pulse: smoothstep peak at rim. h(r) ≈ depth * f(r/R) where
  // f(0)=0, f(0.5)=1 (max), f(1)=0. We rasterize the gradient (-dh/du,-dh/dv).
  // Because we want a *depression*, set sign to + here (outward normal at rim).
  // For pixel-space gradient, we approximate via central differences across a
  // 3x3 neighbourhood — but it's cleaner to write the closed-form derivative:
  // f(t) = 4t(1-t)  (quadratic bump, peaking at t=0.5)
  // df/dt = 4 - 8t
  // dt/dr = 1/R, dh/dr = depth * df/dt * (1/R)
  // The 2D gradient is (dh/dr) * (dx/r, dy/r).
  const R = dimpleRadiusPx;

  for (const { cx, cy } of dimples) {
    const minX = Math.max(0, Math.floor(cx - R));
    const maxX = Math.min(size - 1, Math.ceil(cx + R));
    const minY = Math.max(0, Math.floor(cy - R));
    const maxY = Math.min(size - 1, Math.ceil(cy + R));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        // Wrap-aware distance: if a dimple sits near a UV seam we want it to
        // tile, but for this single ball it doesn't matter — we use straight
        // Euclidean distance; seams are hidden under the ball mark anyway.
        const dx = x - cx;
        const dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r > R) continue;
        const t = r / R; // 0..1
        // Gradient magnitude of f(t)=4t(1-t): df/dt = 4 - 8t
        // dh/dr = depth * (4 - 8t) / R, but we want an INWARD dent so sign-flip:
        const dhdr = -dimpleDepth * (4 - 8 * t) / R;
        // Direction (dx/r, dy/r) — at r=0, gradient is 0 anyway, so guard.
        const inv_r = r > 1e-4 ? 1 / r : 0;
        const gx = dhdr * dx * inv_r;
        const gy = dhdr * dy * inv_r;

        // Tangent-space normal of a height-field: n = normalize(-gx, -gy, 1)
        const nx = -gx;
        const ny = -gy;
        const nz = 1;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        const nnx = nx / len;
        const nny = ny / len;
        const nnz = nz / len;

        // Composite onto whatever was there (later dimples override earlier;
        // dimples don't overlap much given Fibonacci spread + small R).
        const idx = (y * size + x) * 4;
        // Encode signed normal → unsigned 0..255
        data[idx] = Math.round((nnx * 0.5 + 0.5) * 255);
        data[idx + 1] = Math.round((nny * 0.5 + 0.5) * 255);
        data[idx + 2] = Math.round((nnz * 0.5 + 0.5) * 255);
        data[idx + 3] = 255;
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace; // normal maps are linear data, not sRGB
  tex.needsUpdate = true;
  return tex;
}

// -----------------------------------------------------------------------------
// Custom ShaderMaterial (matcap + dimple normal + fresnel rim)
// -----------------------------------------------------------------------------

const VERT = /* glsl */ `
  // Pass-throughs we want in the fragment for matcap UV + fresnel.
  varying vec3 vViewNormal;     // normal in view space (camera-relative)
  varying vec3 vViewPosition;   // fragment position in view space
  varying vec2 vUv;             // unwrapped uv (we use spherical projection from normal below
                                //   instead of geometry uv to avoid pole stretch on seam)

  void main() {
    // Standard MVP transform.
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPos;

    // Normal into view space. normalMatrix is the inverse-transpose of the
    // upper-3x3 of modelViewMatrix — handles non-uniform scale correctly.
    vViewNormal = normalize(normalMatrix * normal);

    // viewPosition for the fresnel term (negate because three convention has
    // +z toward camera in eye-space and we want the vector FROM the fragment
    // TO the camera).
    vViewPosition = -mvPos.xyz;

    // Spherical UV from object-space normal — this avoids the seam stretch you
    // get with SphereGeometry's built-in UV at the poles. Atan2 of (z,x) maps
    // longitude to [-π,π], asin(y) maps latitude to [-π/2,π/2]. We rescale
    // and tile so the dimple texture repeats nicely.
    vec3 n = normalize(position);
    float u = atan(n.z, n.x) / 6.2831853 + 0.5;
    float v = asin(n.y) / 3.1415926 + 0.5;
    vUv = vec2(u * 4.0, v * 2.0); // 4× repeat lon, 2× lat — packs more dimples
  }
`;

const FRAG = /* glsl */ `
  precision highp float;

  uniform sampler2D uMatcap;
  uniform sampler2D uDimple;
  uniform float     uRimStrength;    // 0..1, how strong the cool-edge fresnel is
  uniform vec3      uRimColor;       // RGB tint of the rim
  uniform float     uDimpleStrength; // 0..1, how much the dimple normal perturbs

  varying vec3 vViewNormal;
  varying vec3 vViewPosition;
  varying vec2 vUv;

  // Decode tangent-space normal from RGB (0..1) to (-1..1).
  vec3 unpackNormal(vec3 rgb) {
    return normalize(rgb * 2.0 - 1.0);
  }

  void main() {
    // Sample the procedural dimple normal in tangent space.
    vec3 nT = unpackNormal(texture2D(uDimple, vUv).rgb);

    // Cheap "approximate TBN" — for a sphere we don't need rigorous tangents
    // because the matcap UV trick (encoding view-space normal into a 2D LUT)
    // doesn't care about handedness. We just perturb the view-space normal
    // toward (nT.x, nT.y) by uDimpleStrength. This works because the matcap
    // is rotation-invariant around its center, so any perturbation that bends
    // the normal away from the camera-axis cleanly samples a different matcap
    // pixel — which is exactly the lighting effect we want.
    vec3 n = normalize(vViewNormal + vec3(nT.x, nT.y, 0.0) * uDimpleStrength);

    // Standard matcap UV: take view-space normal's xy, scale to [0,1] LUT space.
    // Three.js MeshMatcapMaterial uses the same formula.
    vec2 matcapUv = n.xy * 0.5 + 0.5;
    vec3 matcap = texture2D(uMatcap, matcapUv).rgb;

    // Fresnel: angle between view direction and surface normal. At grazing
    // angles (edge of sphere) this approaches 1; head-on it's 0. Power 3 is
    // a tight rim — the playbook calls for "subtle".
    vec3 viewDir = normalize(vViewPosition);
    float fresnel = pow(1.0 - max(dot(viewDir, n), 0.0), 3.0);
    vec3 rim = uRimColor * fresnel * uRimStrength;

    // Compose. Matcap already encodes the lighting we want; fresnel adds a
    // subtle cool edge separation against the dark hero background.
    vec3 col = matcap + rim;

    gl_FragColor = vec4(col, 1.0);

    // Tone-mapping is applied by the renderer (ACESFilmic), and output is
    // sRGB-converted automatically because outputColorSpace is sRGB. We output
    // linear here so the pipeline does the right thing.
  }
`;

// -----------------------------------------------------------------------------
// Rounded-rect mask geometry
// -----------------------------------------------------------------------------

/**
 * Build a flat ShapeGeometry approximating a rounded rectangle of unit size
 * (-0.5..0.5 in x and y). We scale to actual element size each frame.
 */
function buildRoundedRectGeometry(radius: number = 0.06, segments: number = 8): THREE.ShapeGeometry {
  const w = 0.5;
  const h = 0.5;
  const r = Math.min(radius, w, h);
  const shape = new THREE.Shape();
  shape.moveTo(-w + r, -h);
  shape.lineTo(w - r, -h);
  shape.quadraticCurveTo(w, -h, w, -h + r);
  shape.lineTo(w, h - r);
  shape.quadraticCurveTo(w, h, w - r, h);
  shape.lineTo(-w + r, h);
  shape.quadraticCurveTo(-w, h, -w, h - r);
  shape.lineTo(-w, -h + r);
  shape.quadraticCurveTo(-w, -h, -w + r, -h);
  return new THREE.ShapeGeometry(shape, segments);
}

// -----------------------------------------------------------------------------
// HeroScene
// -----------------------------------------------------------------------------

export class HeroScene implements SceneModule {
  readonly name = 'hero';

  private readonly camera: THREE.PerspectiveCamera;
  private readonly physics: PhysicsWorld;

  // Three objects
  private ballMesh!: THREE.Mesh;
  private maskMesh!: THREE.Mesh;
  private ballMaterial!: THREE.ShaderMaterial;
  private dimpleTex?: THREE.CanvasTexture;
  private matcapTex?: THREE.Texture;

  // DOM references
  private stageEl: HTMLElement | null = null;
  private sphereEl: HTMLElement | null = null;
  private statSpans: HTMLElement[] = [];
  private trailSvg!: SVGSVGElement;
  private trailPath!: SVGPathElement;

  // Physics handles (only set when !isMobile and physics is ready)
  private ballBody?: RAPIER.RigidBody;
  private cursorBody?: RAPIER.RigidBody;

  // State
  private home = new THREE.Vector3();
  private mouseScreen = { x: -1e6, y: -1e6 };
  private lastMouseScreen = { x: 0, y: 0 };
  private mouseVel = { x: 0, y: 0 };
  private lastMouseT = 0;
  private lastContactT = 0;
  private lastHitT = 0;
  private idleNoiseAccum = 0;
  private paused = false;

  // Display values (lerped) and current targets.
  private dispSpin = BASELINE_SPIN;
  private dispLaunch = BASELINE_LAUNCH;
  private dispCarry = BASELINE_CARRY;
  private targetSpin = BASELINE_SPIN;
  private targetLaunch = BASELINE_LAUNCH;
  private targetCarry = BASELINE_CARRY;

  // Reusable scratch
  private tmpVec3 = new THREE.Vector3();
  private tmpVec3b = new THREE.Vector3();

  // Bound listeners (for clean dispose)
  private onMouseMove = (e: MouseEvent): void => {
    this.mouseScreen.x = e.clientX;
    this.mouseScreen.y = e.clientY;
    this.lastMouseT = performance.now();
  };
  private onVisibility = (): void => {
    this.paused = document.hidden;
  };

  constructor(
    camera: THREE.PerspectiveCamera,
    physics: PhysicsWorld,
    /** Reserved for future canvas-relative event wiring (touch, pointer-lock). */
    _canvasEl: HTMLCanvasElement
  ) {
    this.camera = camera;
    this.physics = physics;
    void _canvasEl;
  }

  init(scene: THREE.Scene): void {
    // 1. Resolve DOM anchors. CLAUDE.md explicitly notes that .sphere and
    //    .sphere-stage MUST remain — we read their layout each frame.
    this.stageEl = document.querySelector<HTMLElement>('.sphere-stage');
    this.sphereEl = document.querySelector<HTMLElement>('.sphere-stage .sphere');
    if (!this.stageEl || !this.sphereEl) {
      // Soft-fail: don't crash the rest of the app if the hero markup is gone.
      // eslint-disable-next-line no-console
      console.warn('HeroScene: .sphere-stage / .sphere not found — module disabled');
      return;
    }

    // Stat spans: 3 rows, each row's second <span> is the value.
    const rows = this.stageEl.querySelectorAll<HTMLElement>(
      '.sphere-hud .row > span:nth-child(2)'
    );
    this.statSpans = Array.from(rows);

    // 2. Build SVG trajectory trail overlay (pointer-events: none so it doesn't
    //    eat hover state from .sphere-stage). It lives INSIDE .sphere-stage so
    //    it inherits z-index + position relative to the stage box.
    this.trailSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.trailSvg.setAttribute('class', 'hero-trail-svg');
    this.trailSvg.setAttribute('viewBox', '0 0 100 100');
    this.trailSvg.setAttribute('preserveAspectRatio', 'none');
    Object.assign(this.trailSvg.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 0.25s ease-out',
      zIndex: '2',
    });
    this.trailPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this.trailPath.setAttribute('fill', 'none');
    this.trailPath.setAttribute('stroke', 'currentColor');
    this.trailPath.setAttribute('stroke-width', '0.4');
    this.trailPath.setAttribute('stroke-linecap', 'round');
    this.trailPath.setAttribute('stroke-dasharray', '120');
    this.trailPath.setAttribute('stroke-dashoffset', '120');
    // currentColor is inherited; pull the brand accent from CSS variable.
    this.trailSvg.style.color = 'var(--accent, #ff6a00)';
    this.trailSvg.appendChild(this.trailPath);
    this.stageEl.appendChild(this.trailSvg);

    // 3. Procedural dimple normal map.
    this.dimpleTex = buildDimpleNormalMap(512, 250, 14, 0.55);

    // 4. Matcap (loaded from /textures/matcap-pearl.png — Vite serves /public at root).
    const loader = new THREE.TextureLoader();
    this.matcapTex = loader.load('/textures/matcap-pearl.png');
    this.matcapTex.colorSpace = THREE.SRGBColorSpace;
    this.matcapTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.matcapTex.magFilter = THREE.LinearFilter;
    this.matcapTex.generateMipmaps = true;

    // 5. Ball mesh + custom shader.
    const geom = new THREE.SphereGeometry(BALL_RADIUS, 64, 64);
    this.ballMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uMatcap: { value: this.matcapTex },
        uDimple: { value: this.dimpleTex },
        uRimStrength: { value: 0.35 }, // subtle, matches "monochrome restraint"
        uRimColor: { value: new THREE.Color(0x9ec3d6) }, // cool-blue rim, very faint
        uDimpleStrength: { value: 0.55 }, // visible dimples but not noisy
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });

    // Stencil setup (technique #4): ball draws ONLY where mask wrote ref=1.
    // ShaderMaterial doesn't expose stencil props in the constructor — set after.
    this.ballMaterial.stencilWrite = true;
    this.ballMaterial.stencilFunc = THREE.EqualStencilFunc;
    this.ballMaterial.stencilRef = 1;
    this.ballMaterial.stencilZPass = THREE.KeepStencilOp;

    this.ballMesh = new THREE.Mesh(geom, this.ballMaterial);
    this.ballMesh.renderOrder = 2; // after mask
    this.ballMesh.frustumCulled = false; // bbox can be unreliable when we move it via physics
    scene.add(this.ballMesh);

    // 6. Stencil mask mesh: invisible (no color/depth write), writes ref=1
    //    everywhere the rounded rectangle covers. renderOrder=1 → drawn before ball.
    const maskGeom = buildRoundedRectGeometry(0.06, 8);
    const maskMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      colorWrite: false,
      stencilWrite: true,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilRef: 1,
      stencilZPass: THREE.ReplaceStencilOp,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilWriteMask: 0xff,
      stencilFuncMask: 0xff,
    });
    this.maskMesh = new THREE.Mesh(maskGeom, maskMat);
    this.maskMesh.renderOrder = 1;
    this.maskMesh.frustumCulled = false;
    scene.add(this.maskMesh);

    // 7. Anchor home position from .sphere element.
    elementToWorld(this.sphereEl, this.camera, HERO_DEPTH, this.home);
    this.ballMesh.position.copy(this.home);

    // 8. Physics setup (skipped on mobile — playbook §8).
    if (!isMobile && this.physics.ready) {
      // Dynamic ball, gravity disabled (we want it to float with anchor spring).
      const ballDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(this.home.x, this.home.y, this.home.z)
        .setLinearDamping(0.4)
        .setAngularDamping(0.5)
        .setGravityScale(0.0);
      this.ballBody = this.physics.addRigidBody(ballDesc);
      const ballColDesc = RAPIER.ColliderDesc.ball(BALL_RADIUS)
        .setRestitution(0.6)
        .setDensity(0.5 / ((4 / 3) * Math.PI * BALL_RADIUS ** 3)); // → mass ≈ 0.5
      this.physics.addCollider(ballColDesc, this.ballBody);

      // Kinematic cursor — we set its translation each frame, Rapier handles
      // continuous-collision detection so swift mouse motions still register.
      const cursorDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        -1000,
        -1000,
        HERO_DEPTH * -1 // way out of the way until first mousemove
      );
      this.cursorBody = this.physics.addRigidBody(cursorDesc);
      const cursorColDesc = RAPIER.ColliderDesc.ball(CURSOR_RADIUS).setRestitution(0.5);
      this.physics.addCollider(cursorColDesc, this.cursorBody);
    }

    // 9. Listeners.
    if (!isMobile) {
      window.addEventListener('mousemove', this.onMouseMove, { passive: true });
    }
    document.addEventListener('visibilitychange', this.onVisibility);

    // 10. Tell CSS to hide the .ballart <img> (the existing flat SVG sphere).
    document.documentElement.classList.add('webgl-ready');
  }

  update(dt: number): void {
    if (this.paused || !this.sphereEl || !this.stageEl) return;

    // 1. Recompute home position from the .sphere DOM box. This is what makes
    //    resize-driven layout shifts move the ball with the HTML — the playbook
    //    explicitly tests this in acceptance criterion #9.
    elementToWorld(this.sphereEl, this.camera, HERO_DEPTH, this.home);

    // 2. Position the stencil mask at .sphere-stage's bounding box.
    elementToWorld(this.stageEl, this.camera, HERO_DEPTH, this.tmpVec3);
    const stageWorldSize = elementToWorldSize(this.stageEl, this.camera, HERO_DEPTH);
    this.maskMesh.position.copy(this.tmpVec3);
    this.maskMesh.scale.set(stageWorldSize.width, stageWorldSize.height, 1);

    // 3. Mobile path — just rotate slowly and bail. No physics, no stat updates.
    if (isMobile || !this.ballBody) {
      this.ballMesh.position.copy(this.home);
      this.ballMesh.rotation.y += dt * 0.3;
      // Keep stats at baseline display — the playbook says "no physics-driven
      // stats on mobile". We update once here in case lang toggle reset them.
      this.writeStatsToDOM(BASELINE_SPIN, BASELINE_LAUNCH, BASELINE_CARRY);
      return;
    }

    // 4. Mouse → world cursor position.
    const now = performance.now();
    const stationary = now - this.lastMouseT > MOUSE_IDLE_MS;
    if (stationary) {
      // Decay velocity to 0 quickly when the mouse is still — prevents the ball
      // from being shoved by a stale velocity reading mid-idle.
      this.mouseVel.x *= 0.6;
      this.mouseVel.y *= 0.6;
    } else {
      // EMA: weight recent dx/dy at MOUSE_VEL_EMA, decay older at (1 - that).
      const dx = this.mouseScreen.x - this.lastMouseScreen.x;
      const dy = this.mouseScreen.y - this.lastMouseScreen.y;
      this.mouseVel.x = this.mouseVel.x * (1 - MOUSE_VEL_EMA) + dx * MOUSE_VEL_EMA;
      this.mouseVel.y = this.mouseVel.y * (1 - MOUSE_VEL_EMA) + dy * MOUSE_VEL_EMA;
    }
    this.lastMouseScreen.x = this.mouseScreen.x;
    this.lastMouseScreen.y = this.mouseScreen.y;

    // Map screen coords → world coords on the same plane the ball lives on.
    // We synthesize a tiny "fake DOM rect" for elementToWorld via direct math
    // (cheaper than creating a phantom element each frame).
    const ndcX = (this.mouseScreen.x / window.innerWidth) * 2 - 1;
    const ndcY = -((this.mouseScreen.y / window.innerHeight) * 2 - 1);
    this.tmpVec3.set(ndcX, ndcY, 0.5).unproject(this.camera);
    this.tmpVec3.sub(this.camera.position).normalize();
    this.tmpVec3b
      .copy(this.camera.position)
      .addScaledVector(this.tmpVec3, HERO_DEPTH);

    // 5. Drive cursor body translation. setNextKinematicTranslation tells Rapier
    //    "you're going here — interpolate the collision sweep so we catch the
    //    ball even at high mouse speed".
    if (this.cursorBody) {
      this.cursorBody.setNextKinematicTranslation({
        x: this.tmpVec3b.x,
        y: this.tmpVec3b.y,
        z: this.tmpVec3b.z,
      });
    }

    // 6. Apply cursor → ball impulse if they're touching (or near-touching).
    //    We use distance test instead of contactPair API (cheaper for a single
    //    body pair, no need to walk the contact graph). When close, push ball
    //    in the direction the cursor is moving in, scaled by AMPLIFY.
    const ballPos = this.ballBody.translation();
    const dx = ballPos.x - this.tmpVec3b.x;
    const dy = ballPos.y - this.tmpVec3b.y;
    const dz = ballPos.z - this.tmpVec3b.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    const contactDist = BALL_RADIUS + CURSOR_RADIUS;
    if (distSq < contactDist * contactDist && !stationary) {
      // Velocity in screen pixels/frame → world units/sec is fuzzy; AMPLIFY
      // is tuned empirically. Convert pixel-space velocity to world-space by
      // scaling with the inverse of the viewport-to-world scale at HERO_DEPTH.
      const fovRad = (this.camera.fov * Math.PI) / 180;
      const worldHeight = 2 * HERO_DEPTH * Math.tan(fovRad / 2);
      const pxToWorld = worldHeight / window.innerHeight;
      const vx = this.mouseVel.x * pxToWorld * AMPLIFY;
      // Screen y grows downward; world y grows up — flip.
      const vy = -this.mouseVel.y * pxToWorld * AMPLIFY;
      this.ballBody.applyImpulse({ x: vx, y: vy, z: 0 }, true);
      // Spin: cross of contact direction × velocity → angular impulse.
      // (In real life, off-center hits cause spin; we fake it.)
      const torqueScale = 0.3;
      this.ballBody.applyTorqueImpulse(
        { x: dy * vx * torqueScale, y: -dx * vy * torqueScale, z: 0 },
        true
      );
      this.lastContactT = now;
      this.lastHitT = now;
    }

    // 7. Anchor spring + idle noise (only when we haven't been hit recently).
    const sinceContact = now - this.lastContactT;
    if (sinceContact > ANCHOR_REENGAGE_MS) {
      // Spring: position-difference scaled to a small impulse each tick. Damping
      // on the body (linearDamping=0.4) handles the velocity decay; we just
      // tug toward home.
      const px = this.home.x - ballPos.x;
      const py = this.home.y - ballPos.y;
      const pz = this.home.z - ballPos.z;
      this.ballBody.applyImpulse(
        {
          x: px * ANCHOR_LAMBDA * dt * 0.2,
          y: py * ANCHOR_LAMBDA * dt * 0.2,
          z: pz * ANCHOR_LAMBDA * dt * 0.2,
        },
        true
      );

      // Damp linear velocity toward zero — critical-damped return.
      const lv = this.ballBody.linvel();
      const dampFactor = 1 - Math.exp(-VEL_DAMP_LAMBDA * dt);
      this.ballBody.setLinvel(
        {
          x: lv.x * (1 - dampFactor),
          y: lv.y * (1 - dampFactor),
          z: lv.z * (1 - dampFactor),
        },
        true
      );

      // Idle "wind on tee" noise — small random impulse every IDLE_NOISE_PERIOD.
      this.idleNoiseAccum += dt;
      if (this.idleNoiseAccum > IDLE_NOISE_PERIOD) {
        this.idleNoiseAccum = 0;
        this.ballBody.applyImpulse(
          {
            x: (Math.random() - 0.5) * IDLE_NOISE_IMPULSE,
            y: (Math.random() - 0.5) * IDLE_NOISE_IMPULSE,
            z: 0,
          },
          true
        );
      }
    }

    // 8. Sync mesh transform from physics body.
    const t = this.ballBody.translation();
    const r = this.ballBody.rotation();
    this.ballMesh.position.set(t.x, t.y, t.z);
    this.ballMesh.quaternion.set(r.x, r.y, r.z, r.w);

    // Keep ball clamped to the stencil window in physics-space too — even
    // though stencil clips visually, a runaway ball makes the stat readouts
    // weird. Soft clamp: if the ball is more than 1.5× the stage size away
    // from home, snap velocity to push it back.
    const halfW = stageWorldSize.width * 0.45;
    const halfH = stageWorldSize.height * 0.45;
    if (Math.abs(t.x - this.home.x) > halfW || Math.abs(t.y - this.home.y) > halfH) {
      // Clamp position back inside.
      const cx = clamp(t.x, this.home.x - halfW, this.home.x + halfW);
      const cy = clamp(t.y, this.home.y - halfH, this.home.y + halfH);
      this.ballBody.setTranslation({ x: cx, y: cy, z: this.home.z }, true);
      // Reflect velocity instead of zeroing — feels more like a wall than glue.
      const lv = this.ballBody.linvel();
      this.ballBody.setLinvel(
        { x: lv.x * -0.5, y: lv.y * -0.5, z: 0 },
        true
      );
    }

    // 9. Stats binding.
    this.computeAndUpdateStats(now);

    // 10. Launch detection / SVG trail.
    const linvel = this.ballBody.linvel();
    const speed = Math.sqrt(linvel.x ** 2 + linvel.y ** 2 + linvel.z ** 2);
    if (speed > LAUNCH_THRESHOLD && now - this.lastHitT < 50) {
      this.fireTrail(linvel.x, linvel.y);
    }
    // Trail fades automatically via CSS opacity transition; reset opacity 0
    // after TRAIL_FADE_MS so it can fire again.
    if (now - this.lastHitT > TRAIL_FADE_MS) {
      this.trailSvg.style.opacity = '0';
    }
  }

  /** Compute SPIN/LAUNCH/CARRY targets from physics, lerp displays, write DOM. */
  private computeAndUpdateStats(now: number): void {
    if (!this.ballBody) return;
    const lv = this.ballBody.linvel();
    const av = this.ballBody.angvel();

    const isHot = now - this.lastHitT < STAT_HOT_MS;
    if (isHot) {
      // SPIN: |angvel| × 200 (rough rad/s → rpm with showmanship boost).
      const spinRpm = Math.sqrt(av.x ** 2 + av.y ** 2 + av.z ** 2) * 200;
      // LAUNCH: angle of linvel from horizontal.
      const horiz = Math.sqrt(lv.x ** 2 + lv.z ** 2);
      const launchDeg = horiz > 0.01 ? (Math.atan2(lv.y, horiz) * 180) / Math.PI : BASELINE_LAUNCH;
      // CARRY: |v|² × coeff. Empirically tuned so a strong hit reads ~280-320.
      const speed = Math.sqrt(lv.x ** 2 + lv.y ** 2 + lv.z ** 2);
      const carryYds = speed * speed * 12 + BASELINE_CARRY * 0.6;
      this.targetSpin = clamp(BASELINE_SPIN + spinRpm * 0.4, 1500, 6500);
      this.targetLaunch = clamp(launchDeg + BASELINE_LAUNCH, -5, 32);
      this.targetCarry = clamp(carryYds, 180, 380);
    } else {
      // Decay back to baseline.
      this.targetSpin = damp(this.targetSpin, BASELINE_SPIN, STAT_BASELINE_LAMBDA, 0.016);
      this.targetLaunch = damp(this.targetLaunch, BASELINE_LAUNCH, STAT_BASELINE_LAMBDA, 0.016);
      this.targetCarry = damp(this.targetCarry, BASELINE_CARRY, STAT_BASELINE_LAMBDA, 0.016);
    }

    this.dispSpin = lerp(this.dispSpin, this.targetSpin, STAT_LERP);
    this.dispLaunch = lerp(this.dispLaunch, this.targetLaunch, STAT_LERP);
    this.dispCarry = lerp(this.dispCarry, this.targetCarry, STAT_LERP);

    this.writeStatsToDOM(this.dispSpin, this.dispLaunch, this.dispCarry);
  }

  /** Direct DOM textContent updates — playbook §6 explicitly bans React/setState. */
  private writeStatsToDOM(spin: number, launchDeg: number, carry: number): void {
    if (this.statSpans.length < 3) return;
    // Format: "2,840 rpm" / "11.2°" / "262 yds" — preserve original visual style.
    this.statSpans[0].textContent = `${Math.round(spin).toLocaleString('en-US')} rpm`;
    this.statSpans[1].textContent = `${launchDeg.toFixed(1)}°`;
    this.statSpans[2].textContent = `${Math.round(carry)} yds`;
  }

  /**
   * Animate a parabolic trajectory trail in the SVG overlay. The "launch"
   * direction comes from current ball velocity; we draw a quadratic Bezier
   * from current ball position to a faked apex + landing point.
   */
  private fireTrail(vx: number, vy: number): void {
    if (!this.stageEl) return;
    // Map ball world position back to SVG-local coords (0..100 in both axes
    // because viewBox is "0 0 100 100" and preserveAspectRatio="none").
    const ballPos = this.ballBody!.translation();
    // Cheap reverse: use stage rect — find where ball is in stage-local %.
    const stageRect = this.stageEl.getBoundingClientRect();
    // Project ball world → screen px.
    this.tmpVec3.set(ballPos.x, ballPos.y, ballPos.z).project(this.camera);
    const sx = ((this.tmpVec3.x + 1) / 2) * window.innerWidth;
    const sy = ((-this.tmpVec3.y + 1) / 2) * window.innerHeight;
    const localX = ((sx - stageRect.left) / stageRect.width) * 100;
    const localY = ((sy - stageRect.top) / stageRect.height) * 100;

    // Trajectory direction follows velocity, scaled to fit inside viewbox.
    const speed = Math.sqrt(vx * vx + vy * vy) || 1;
    const len = clamp(speed * 6, 18, 60);
    const dx = (vx / speed) * len;
    const dyL = (-vy / speed) * len; // svg y is inverted vs world y

    const endX = clamp(localX + dx, 5, 95);
    const endY = clamp(localY + dyL, 5, 95);
    // Apex — bend upward (negative svg y) for parabolic feel.
    const midX = (localX + endX) / 2;
    const midY = Math.min(localY, endY) - 18;

    this.trailPath.setAttribute(
      'd',
      `M${localX.toFixed(2)} ${localY.toFixed(2)} Q${midX.toFixed(2)} ${midY.toFixed(2)} ${endX.toFixed(2)} ${endY.toFixed(2)}`
    );
    // Pop in: reset dashoffset to length, then animate to 0 via CSS transition.
    this.trailPath.style.transition = 'none';
    this.trailPath.setAttribute('stroke-dashoffset', '120');
    // Force layout flush so the next change re-triggers transition.
    void this.trailPath.getBoundingClientRect();
    this.trailPath.style.transition = 'stroke-dashoffset 0.6s ease-out';
    this.trailPath.setAttribute('stroke-dashoffset', '0');
    this.trailSvg.style.opacity = '0.85';
  }

  dispose(scene: THREE.Scene): void {
    window.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.trailSvg && this.trailSvg.parentElement) {
      this.trailSvg.parentElement.removeChild(this.trailSvg);
    }
    if (this.ballMesh) {
      scene.remove(this.ballMesh);
      this.ballMesh.geometry.dispose();
    }
    if (this.maskMesh) {
      scene.remove(this.maskMesh);
      this.maskMesh.geometry.dispose();
      (this.maskMesh.material as THREE.Material).dispose();
    }
    if (this.ballMaterial) this.ballMaterial.dispose();
    if (this.dimpleTex) this.dimpleTex.dispose();
    if (this.matcapTex) this.matcapTex.dispose();
    document.documentElement.classList.remove('webgl-ready');
  }
}
