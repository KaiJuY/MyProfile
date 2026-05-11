import * as THREE from 'three';
import type { SceneModule } from '../SceneManager';
import type { ScrollManager } from '@core/ScrollManager';
import { elementToWorld, elementToWorldSize } from '@core/ScreenToWorld';
import { getUserPrefs } from '@core/UserPrefs';
import {
  buildBallAndTeeGroup,
  detachBallForLaunch,
  type BuildBallAndTeeGroupResult,
} from '../shared/golfAndTee';

/**
 * FlythroughScene — WebGL ball + tee that track the existing CSS-driven
 * flythrough choreography.
 *
 * The inline JS in `index.html` (search for `Sticky flythrough scroll-driven
 * choreography`) animates the `.fly-ball-wrap#flyBall` and `.tee#tee` DOM
 * elements via `transform`. We treat those DOM elements as invisible anchors:
 * each frame we read their `getBoundingClientRect()`, project the rect to a
 * world-space position via `elementToWorld`, and place the matching GLB mesh
 * there. Visual size is derived from the DOM rect so the WebGL meshes scale in
 * lock-step with the CSS keyframes (rest → big mid-flight → exit shrink).
 *
 * The combined `GolfAndTee.glb` provides BOTH the ball and the tee in a single
 * file. While the ball is "at rest" (CSS positions of #flyBall and #tee
 * coincide), we use the ball-on-tee combined Group. Once the CSS animation
 * launches the ball away from the tee, we DETACH the ball from the Group with
 * `detachBallForLaunch` so the tee stays put and the ball flies free.
 *
 * Mobile / reduced-motion path: render nothing — the existing CSS animation
 * handles those cases unchanged.
 */

/** World-units in front of the camera for the flythrough plane. Matches Hero. */
const FLY_DEPTH = 5;

/** Ratio of the GLB tee's normalized bounding-box height (0.6) — tee
 * geometry is taller than wide, so visually the on-screen "ball-like" radius
 * isn't 0.5 world units. Empirical compensation when scaling from DOM size. */
const TEE_VISUAL_GAIN = 1.6;

/** Idle ball spin (rad/s) when the section is in view — visual life only. */
const BALL_IDLE_SPIN = 0.6;

/** Scroll-progress threshold (in `scrollManager.sectionProgress('flythrough')`
 *  units) at which the impact moment fires — the ball lifts off the tee.
 *
 *  This is the inline JS's `const PRE = 0.06` CONVERTED to scrollManager units.
 *  The inline JS computes its progress from `-flyRail.top / (flyRail.offsetHeight
 *  - innerHeight)`, which only covers the sticky-pinned portion of the scroll
 *  (sticky engages at scrollManager secProgress ≈ 0.172, disengages at ≈ 0.828
 *  for the rail at 480vh + 100vh viewport = 580vh total). So inline PRE=0.06
 *  corresponds to scrollManager secProgress = 0.172 + 0.06 * (0.828 - 0.172)
 *  ≈ 0.211. Using the inline PRE value directly (0.06) caused the WebGL FX to
 *  fire BEFORE the sticky stage even engaged — impact played out while user
 *  was still scrolling INTO the section. */
const PRE_IMPACT_SP = 0.21;

/** Pixel threshold — when the CSS ball/tee rect centers diverge by MORE than
 *  this in screen-space, we treat the ball as "launched" and detach it from
 *  the combined group. Lower = launches sooner (felt right at 30-40px). */
const LAUNCH_DIVERGENCE_PX = 30;

/** Shockwave + particle + smoke + lightray config — desktop only. */
const SHOCKWAVE_DURATION_S = 0.45;
const SHOCKWAVE_MAX_RADIUS = 0.3;     // tighter halo, less "explosion"
const PARTICLE_COUNT = 8;             // very sparse — a few suspended motes, not a burst
const PARTICLE_DURATION_S = 1.4;      // slow lingering float
const PARTICLE_MAX_SPEED = 1.0;       // gentle drift, not blast
const SMOKE_COUNT_DESKTOP = 22;
const SMOKE_COUNT_MOBILE = 12;
const SMOKE_DURATION_S = 1.3;
const SMOKE_MAX_SIZE = 0.55;          // world-unit final radius per puff (kept for tuning reference)
const LIGHTRAY_COUNT = 10;            // fewer rays
const LIGHTRAY_DURATION_S = 0.5;
const LIGHTRAY_MAX_LENGTH = 0.8;      // shorter, less reach

/** Tee tilt + fade ramp duration after impact, seconds. Roughly matches the
 *  shockwave for a unified "impact moment" feel. */
const TEE_ANIM_DURATION_S = 0.6;

function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.innerWidth < 768) return true;
  if (typeof window.matchMedia === 'function') {
    if (window.matchMedia('(pointer: coarse)').matches) return true;
  }
  return false;
}

export class FlythroughScene implements SceneModule {
  readonly name = 'flythrough';

  private readonly camera: THREE.PerspectiveCamera;
  private readonly scrollManager: ScrollManager;

  /** Scene the FX get attached to — captured in init() for `detachBallForLaunch`. */
  private scene: THREE.Scene | null = null;

  /** Combined ball+tee group (returned by `buildBallAndTeeGroup`). When the
   *  ball is launched, we re-parent the ball mesh OUT of `combined.group` and
   *  into the scene root with its world matrix preserved. The tee mesh stays
   *  inside `combined.group`. */
  private combined: BuildBallAndTeeGroupResult | null = null;
  /** True after `detachBallForLaunch` has fired this section-cycle. Reset when
   *  the section leaves view OR sectionProgress drops back below pre-impact. */
  private ballDetached = false;

  private matcapTex: THREE.Texture | null = null;

  // Lights for the tee's Lambert material.
  private teeLight: THREE.DirectionalLight | null = null;
  private teeAmbient: THREE.AmbientLight | null = null;

  // DOM anchors (resolved in init).
  private flythroughEl: HTMLElement | null = null;
  private flyBallEl: HTMLElement | null = null;
  private teeEl: HTMLElement | null = null;

  private bailed = false;
  private timeSec = 0;
  private tmpVec3 = new THREE.Vector3();
  private tmpVec3b = new THREE.Vector3();

  // ── Impact FX (desktop only) ────────────────────────────────────────────
  private shockwaveMesh: THREE.Mesh | null = null;
  private shockwaveMaterial: THREE.ShaderMaterial | null = null;
  private particleMesh: THREE.Points | null = null;
  private particleMaterial: THREE.ShaderMaterial | null = null;
  private smokeMesh: THREE.Points | null = null;
  private smokeMaterial: THREE.ShaderMaterial | null = null;
  private lightrayMesh: THREE.Mesh | null = null;
  private lightrayMaterial: THREE.ShaderMaterial | null = null;
  /** Time elapsed since the most recent impact trigger. -1 = inactive. */
  private impactElapsed = -1;
  private impactArmed = true;

  /** Previous-frame `inFlight` value. Used to fire the impact FX on the
   *  exact frame inFlight transitions false→true (i.e. when secProgress
   *  first crosses PRE_IMPACT_SP). Carries across gate frames (we DON'T
   *  reset it in the visibility gate) so scroll-up entry from below at
   *  a position where the CSS ball is mid-flight does NOT spuriously fire
   *  — wasInFlight will be `true` from the last non-gated frame in that
   *  scenario, making the transition test false. */
  private wasInFlight = false;

  /** Time elapsed (seconds) since the impact event fired. -1 = pre-impact
   *  (tee upright + opaque). Once impact triggers we set to 0 and tick by dt
   *  each frame; tilt + fade are derived from this so they're synced to the
   *  actual divergence-detected hit moment instead of scroll progress. */
  private teeAnimElapsed = -1;

  /** Track impact-x/z so the FX nodes can be re-anchored each trigger. */
  private impactX = 0;
  private impactZ = 0;

  constructor(camera: THREE.PerspectiveCamera, scrollManager: ScrollManager) {
    this.camera = camera;
    this.scrollManager = scrollManager;
  }

  async init(scene: THREE.Scene): Promise<void> {
    this.scene = scene;

    this.flythroughEl = document.getElementById('flythrough');
    this.flyBallEl = document.getElementById('flyBall');
    this.teeEl = document.getElementById('tee');
    if (!this.flythroughEl || !this.flyBallEl || !this.teeEl) {
      // eslint-disable-next-line no-console
      console.warn(
        'FlythroughScene: #flythrough / #flyBall / #tee not found — module disabled'
      );
      this.bailed = true;
      return;
    }

    const loader = new THREE.TextureLoader();
    this.matcapTex = loader.load('/textures/matcap-pearl.png');
    this.matcapTex.colorSpace = THREE.SRGBColorSpace;
    this.matcapTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.matcapTex.magFilter = THREE.LinearFilter;
    this.matcapTex.generateMipmaps = true;

    // Build the combined ball+tee group from the unified GLB. The ball mesh
    // sits at `ballOffset` inside the tee's group; per-frame we'll either
    // (a) anchor `combined.group` to the tee's CSS rect (ball at rest), or
    // (b) detach the ball into the scene root and anchor it to #flyBall while
    // the tee stays parented to `combined.group` at #tee.
    this.combined = await buildBallAndTeeGroup(this.matcapTex, {
      rimStrength: 0.70,
      rimColor: new THREE.Color(0xFF6A00),
      useDimpleMap: false,
      matcapSoftness: 0.25,
    });
    this.combined.group.visible = false;
    scene.add(this.combined.group);

    // Lights for the tee. Ambient + a single key light from the upper-left.
    this.teeAmbient = new THREE.AmbientLight(0xffffff, 0.55);
    this.teeLight = new THREE.DirectionalLight(0xfff1d6, 0.85);
    this.teeLight.position.set(-3, 5, 4);
    scene.add(this.teeAmbient);
    scene.add(this.teeLight);

    // ── Shockwave ring ──────────────────────────────────────────────────
    this.buildShockwave(scene);
    // ── Particle burst ──────────────────────────────────────────────────
    this.buildParticles(scene);
    // ── Smoke cloud ─────────────────────────────────────────────────────
    this.buildSmoke(scene);
    // ── Light rays ──────────────────────────────────────────────────────
    this.buildLightRays(scene);

    document.documentElement.classList.add('flythrough-3d');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FX builders
  // ─────────────────────────────────────────────────────────────────────────

  private buildShockwave(scene: THREE.Scene): void {
    const ringGeom = new THREE.PlaneGeometry(2, 2, 1, 1);
    const ringMat = new THREE.ShaderMaterial({
      uniforms: {
        uProgress: { value: 0.0 },
        uColor: { value: new THREE.Color(0xff6a00) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uProgress;
        uniform vec3 uColor;
        varying vec2 vUv;
        void main() {
          vec2 c = vUv - 0.5;
          float r = length(c) * 2.0;
          float ringR = uProgress;
          // Soft halo: bright at the expanding edge, fading inward and outward.
          float thickness = 0.35;  // wider band → halo, not crisp ring
          float band = 1.0 - smoothstep(0.0, thickness, abs(r - ringR));
          // Inner glow that fills from center, fading as the ring expands.
          float core = (1.0 - smoothstep(0.0, ringR * 0.6 + 0.05, r)) * (1.0 - uProgress);
          float life = 1.0 - uProgress;
          float alpha = (band * 0.55 + core * 0.45) * life * step(r, 1.0);
          vec3 col = uColor;
          gl_FragColor = vec4(col, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.shockwaveMesh = new THREE.Mesh(ringGeom, ringMat);
    this.shockwaveMesh.frustumCulled = false;
    this.shockwaveMesh.visible = false;
    this.shockwaveMaterial = ringMat;
    scene.add(this.shockwaveMesh);
  }

  private buildParticles(scene: THREE.Scene): void {
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const dirs = new Float32Array(PARTICLE_COUNT * 3);
    const speeds = new Float32Array(PARTICLE_COUNT);
    const sizes = new Float32Array(PARTICLE_COUNT);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      // Leftward hemisphere — azim centered on -X (Math.PI), spread ±70°.
      const azim = Math.PI + (Math.random() - 0.5) * (Math.PI * 70 / 180) * 2;
      // Vertical spread: small upward bias (dust rises a bit but doesn't rocket).
      const elev = (Math.random() - 0.3) * 0.6;  // mostly horizontal, slight up
      const cx = Math.cos(elev) * Math.cos(azim);
      const cy = Math.sin(elev);
      const cz = Math.cos(elev) * Math.sin(azim) * 0.4;  // less depth scatter
      const len = Math.hypot(cx, cy, cz);
      dirs[i * 3 + 0] = cx / len;
      dirs[i * 3 + 1] = cy / len;
      dirs[i * 3 + 2] = cz / len;
      speeds[i] = (0.5 + Math.random() * 0.5) * PARTICLE_MAX_SPEED;
      sizes[i] = 6 + Math.random() * 10;     // tiny motes (6-16px range)
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
    geom.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
    geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0.0 },
        uDuration: { value: PARTICLE_DURATION_S },
        uColor: { value: new THREE.Color(0xc9c1b5) },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aDir;
        attribute float aSpeed;
        attribute float aSize;
        uniform float uTime;
        uniform float uDuration;
        varying float vLife;
        void main() {
          float t = clamp(uTime / uDuration, 0.0, 1.0);
          float d = aSpeed * (1.0 - exp(-2.0 * t));
          vec3 offset = aDir * d + vec3(0.0, -0.20 * t * t, 0.0);
          vec3 worldPos = position + offset;
          vec4 mv = modelViewMatrix * vec4(worldPos, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * (300.0 / max(0.1, -mv.z));
          vLife = 1.0 - t;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uColor;
        varying float vLife;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float r = length(c);
          float a = smoothstep(0.5, 0.0, r) * vLife * 0.32; // very dim — accent only
          // Dust: warm-gray-white core fading to cooler gray.
          vec3 warm = vec3(0.95, 0.90, 0.82);
          vec3 cool = vec3(0.55, 0.55, 0.58);
          vec3 col = mix(cool, warm, vLife);
          gl_FragColor = vec4(col, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.particleMaterial = mat;
    this.particleMesh = new THREE.Points(geom, mat);
    this.particleMesh.frustumCulled = false;
    this.particleMesh.visible = false;
    scene.add(this.particleMesh);
  }

  private buildSmoke(scene: THREE.Scene): void {
    const count = isMobileViewport() ? SMOKE_COUNT_MOBILE : SMOKE_COUNT_DESKTOP;
    const positions = new Float32Array(count * 3);
    const dirs = new Float32Array(count * 3);
    const speeds = new Float32Array(count);
    const sizes = new Float32Array(count);
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // Leftward-biased hemisphere — azim centered on -X (Math.PI), spread ±80°.
      const azim = Math.PI + (Math.random() - 0.5) * (Math.PI * 80 / 180) * 2;
      const elev = (Math.random() - 0.2) * 0.7;  // mostly horizontal, mild up
      const cx = Math.cos(elev) * Math.cos(azim);
      const cy = Math.sin(elev);
      const cz = Math.cos(elev) * Math.sin(azim);
      const len = Math.hypot(cx, cy, cz);
      dirs[i * 3 + 0] = cx / len;
      dirs[i * 3 + 1] = cy / len;
      dirs[i * 3 + 2] = cz / len;
      // Larger initial spread velocity so puffs separate quickly.
      speeds[i] = 0.7 + Math.random() * 0.8;
      sizes[i] = 2 + Math.random() * 3; // base px (perspective-amplified by ~40×)
      seeds[i] = Math.random();
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
    geom.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
    geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geom.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0.0 },
        uDuration: { value: SMOKE_DURATION_S },
        uMaxSize: { value: SMOKE_MAX_SIZE },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aDir;
        attribute float aSpeed;
        attribute float aSize;
        attribute float aSeed;
        uniform float uTime;
        uniform float uDuration;
        varying float vLife;
        varying float vSeed;
        void main() {
          float t = clamp(uTime / uDuration, 0.0, 1.0);
          // Drag: pos += dir*speed*(1-exp(-2t)) + slow upward drift.
          float drag = 1.0 - exp(-2.0 * t);
          vec3 offset = aDir * aSpeed * drag + vec3(-0.10 * t, 0.15 * t, 0.0);
          vec3 worldPos = position + offset;
          vec4 mv = modelViewMatrix * vec4(worldPos, 1.0);
          gl_Position = projectionMatrix * mv;
          // Size grows with t (puffs expand as smoke dissipates).
          float sz = aSize * mix(0.4, 1.0, t);
          // 200/depth keeps puffs at a few-hundred-pixel radius at FLY_DEPTH=5.
          gl_PointSize = sz * (200.0 / max(0.1, -mv.z));
          vLife = 1.0 - t;
          vSeed = aSeed;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying float vLife;
        varying float vSeed;
        // Soft radial alpha — Gaussian-ish falloff so puffs blend into clouds.
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float r2 = dot(c, c);
          float a = exp(-r2 * 14.0); // soft edge
          // Warm gray-white for the leading edge; cooler at later life.
          vec3 warm = vec3(0.95, 0.92, 0.85);
          vec3 cool = vec3(0.55, 0.55, 0.62);
          vec3 col = mix(cool, warm, vLife);
          // Slight per-particle color jitter via seed.
          col += (vSeed - 0.5) * 0.05;
          // Alpha capped low so overlapping puffs still let underlying
          // scene + additive light rays bleed through. Smoke is a SOFT
          // accent on top of the brighter ray + particle effects.
          float alpha = a * vLife * 0.18;
          gl_FragColor = vec4(col, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      // NormalBlending so the smoke reads as opaque puffs rather than
      // "additive light blob". Combined with low per-pixel alpha + multiple
      // overlapping sprites, this mimics volumetric smoke.
      blending: THREE.NormalBlending,
    });
    this.smokeMaterial = mat;
    this.smokeMesh = new THREE.Points(geom, mat);
    this.smokeMesh.frustumCulled = false;
    this.smokeMesh.visible = false;
    // Render before light rays so additive rays sit on top.
    this.smokeMesh.renderOrder = 0;
    scene.add(this.smokeMesh);
  }

  private buildLightRays(scene: THREE.Scene): void {
    // 16 spokes, each a thin elongated PLANE rather than a 1-px Line (WebGL
    // ignores LineWidth on most GPUs). Each plane is a quad with 4 verts +
    // 2 tris; per-vertex attrs encode direction along the spoke axis and a
    // half-width offset perpendicular to it. Vertex shader places vertex at
    // (root + dir*length*along + cross*half_width) so the plane stays
    // billboarded along its tangent at any camera angle.
    const N = LIGHTRAY_COUNT;
    const VERTS_PER_SPOKE = 4;
    const TRIS_PER_SPOKE = 2;
    const positions = new Float32Array(N * VERTS_PER_SPOKE * 3);
    const dirs = new Float32Array(N * VERTS_PER_SPOKE * 3);
    const along = new Float32Array(N * VERTS_PER_SPOKE);   // 0=root, 1=tip
    const sideways = new Float32Array(N * VERTS_PER_SPOKE); // -1, +1 for the two sides
    const stagger = new Float32Array(N * VERTS_PER_SPOKE);
    const indices: number[] = [];
    for (let i = 0; i < N; i++) {
      // Leftward fan: spokes spread across ±55° around -X (Math.PI).
      const ang = Math.PI + ((i / Math.max(1, N - 1)) - 0.5) * (Math.PI * 110 / 180);
      // Slight vertical scatter so the fan isn't a perfectly flat horizontal band.
      const yBias = (Math.random() - 0.5) * 0.25;
      const dx = Math.cos(ang);
      const dz = Math.sin(ang);
      const dy = yBias;
      const len = Math.hypot(dx, dy, dz);
      const ndx = dx / len;
      const ndy = dy / len;
      const ndz = dz / len;
      const ofs = i % 2 === 0 ? 0 : 0.04;
      // 4 verts per quad: (along=0, side=-1), (along=0, side=+1),
      //                   (along=1, side=-1), (along=1, side=+1)
      const baseV = i * VERTS_PER_SPOKE;
      for (let v = 0; v < 4; v++) {
        const idx = (baseV + v) * 3;
        positions[idx] = 0;
        positions[idx + 1] = 0;
        positions[idx + 2] = 0;
        dirs[idx] = ndx;
        dirs[idx + 1] = ndy;
        dirs[idx + 2] = ndz;
        along[baseV + v] = v < 2 ? 0 : 1;
        sideways[baseV + v] = v % 2 === 0 ? -1 : 1;
        stagger[baseV + v] = ofs;
      }
      // Two triangles per quad: (0,1,2), (1,3,2)
      indices.push(baseV + 0, baseV + 1, baseV + 2);
      indices.push(baseV + 1, baseV + 3, baseV + 2);
      void TRIS_PER_SPOKE;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
    geom.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
    geom.setAttribute('aSide', new THREE.BufferAttribute(sideways, 1));
    geom.setAttribute('aStagger', new THREE.BufferAttribute(stagger, 1));
    geom.setIndex(indices);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0.0 },
        uDuration: { value: LIGHTRAY_DURATION_S },
        uMaxLen: { value: LIGHTRAY_MAX_LENGTH },
        uHalfWidth: { value: 0.015 }, // world-units half-thickness of each spoke (thin beams)
      },
      vertexShader: /* glsl */ `
        attribute vec3 aDir;
        attribute float aAlong;
        attribute float aSide;
        attribute float aStagger;
        uniform float uTime;
        uniform float uDuration;
        uniform float uMaxLen;
        uniform float uHalfWidth;
        varying float vLife;
        varying float vAlong;
        void main() {
          float t = clamp((uTime - aStagger) / uDuration, 0.0, 1.0);
          float grow = smoothstep(0.0, 0.4, t);
          float fade = 1.0 - smoothstep(0.5, 1.0, t);
          float len = uMaxLen * grow;
          // Camera-facing side-axis: cross(direction, view-vector). Camera
          // looks down -Z in world space (default Three.js camera), so
          // viewDir ≈ vec3(0,0,1) for our purposes. cross(aDir, viewDir)
          // gives a vector perpendicular to both, lying in the screen plane.
          vec3 viewDir = vec3(0.0, 0.0, 1.0);
          vec3 sideAxis = normalize(cross(aDir, viewDir));
          // Taper: half-width shrinks at tip so spokes look like rays.
          float taper = mix(1.0, 0.25, aAlong);
          vec3 worldPos = position + aDir * len * aAlong + sideAxis * (uHalfWidth * taper * aSide);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
          vLife = fade;
          vAlong = aAlong;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying float vLife;
        varying float vAlong;
        void main() {
          // Warm-white core, slightly cooler at the tips — light, not fire.
          vec3 core = vec3(1.0, 0.95, 0.85);
          vec3 edge = vec3(0.85, 0.75, 0.55);
          float alpha = vLife * (1.0 - vAlong * 0.7) * 0.6;  // dimmer overall
          vec3 col = mix(core, edge, vAlong);
          gl_FragColor = vec4(col, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.lightrayMaterial = mat;
    this.lightrayMesh = new THREE.Mesh(geom, mat);
    this.lightrayMesh.frustumCulled = false;
    this.lightrayMesh.visible = false;
    this.lightrayMesh.renderOrder = 1; // above smoke
    scene.add(this.lightrayMesh);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Per-frame update
  // ─────────────────────────────────────────────────────────────────────────

  update(dt: number): void {
    if (this.bailed) return;
    if (!this.combined || !this.flyBallEl || !this.teeEl) return;

    this.timeSec += dt;
    const reducedMotion = getUserPrefs().reducedMotion;
    const onMobile = isMobileViewport();

    const secProgress = this.scrollManager.sectionProgress('flythrough');
    // Tight visibility gate — outside [0.05, 0.95] the section isn't really in
    // view yet, so skip the entire FX update including impact FX. Prevents the
    // shockwave / smoke from rendering on the brief frames where the section
    // pre-rolls into view.
    if (secProgress < 0.05 || secProgress > 0.95) {
      this.combined.group.visible = false;
      // Ball might be detached — re-attach it before hiding so next entry
      // restores ball-on-tee state.
      this.reattachBallToGroup();
      this.hideAllFX();
      this.impactArmed = true;
      this.impactElapsed = -1;
      this.teeAnimElapsed = -1;
      return;
    }

    const inFlight = secProgress > PRE_IMPACT_SP;
    this.combined.group.visible = true;

    // ── Tee anchor ────────────────────────────────────────────────────────
    const teeRect = this.teeEl.getBoundingClientRect();
    const ballRect = this.flyBallEl.getBoundingClientRect();
    let teeWorldTopY: number | null = null;
    let teeMeshScale = 1;
    if (teeRect.width > 0 && teeRect.height > 0) {
      elementToWorld(this.teeEl, this.camera, FLY_DEPTH, this.tmpVec3);
      // Anchor the COMBINED group on the tee's screen position. Since the tee
      // mesh is at (0,0,0) inside the group, group.position = tee world pos.
      this.combined.group.position.copy(this.tmpVec3);

      const teeSize = elementToWorldSize(this.teeEl, this.camera, FLY_DEPTH);
      teeMeshScale = teeSize.height * TEE_VISUAL_GAIN;
      this.combined.group.scale.setScalar(teeMeshScale);

      // Tilt the tee + ball post-impact. Driven by teeAnimElapsed (synced to the
      // divergence-based impact moment) rather than scroll progress, so the tee
      // stays upright until the ball visibly leaves and only then begins tilting.
      const teeAnimP =
        this.teeAnimElapsed < 0 ? 0 : Math.min(1, this.teeAnimElapsed / TEE_ANIM_DURATION_S);
      const tiltDeg = teeAnimP * 45;
      this.combined.group.rotation.set(0, 0, -(tiltDeg * Math.PI) / 180);

      // Fade the tee out as it tips over. Same timer; reaches near-zero at teeAnimP ~0.25
      // (fade is 4× faster than tilt so the tee disappears mid-tip).
      const teeOpacity =
        this.teeAnimElapsed < 0 ? 1 : Math.max(0, 1 - teeAnimP * 4);
      const c = this.combined.teeMaterial.color;
      c.setRGB(0.722 * teeOpacity, 0.541 * teeOpacity, 0.333 * teeOpacity);
      this.combined.teeMesh.visible = teeOpacity >= 0.01;

      // Compute world-space tee tip (= tee's local topY * scale, plus rotation
      // about Z applied via group). Use the cached metrics from the loader.
      const offset = this.combined.ballOffset; // local offset pre-rotation
      // ballOffset.y = teeMetrics.topY + ballRadius - tinyGap, so subtract
      // ballRadius to get the actual tip Y.
      const tipLocalY = offset.y - 0.5; // 0.5 = ball radius post-normalize
      const ang = -(tiltDeg * Math.PI) / 180;
      const tipDx = -Math.sin(ang) * tipLocalY * teeMeshScale;
      const tipDy = Math.cos(ang) * tipLocalY * teeMeshScale;
      teeWorldTopY = this.combined.group.position.y + tipDy;
      this.impactX = this.combined.group.position.x + tipDx;
      this.impactZ = this.combined.group.position.z;
    } else {
      this.combined.teeMesh.visible = false;
    }

    // ── Detect launch — divergence between #flyBall and #tee centers ─────
    // Use full euclidean distance so a diagonal launch trajectory triggers
    // the same instant a vertical one would.
    const ballCenterY = ballRect.top + ballRect.height * 0.5;
    const ballCenterX = ballRect.left + ballRect.width * 0.5;
    const teeCenterX = teeRect.left + teeRect.width * 0.5;
    const teeCenterY = teeRect.top + teeRect.height * 0.5;
    const dxPx = ballCenterX - teeCenterX;
    const dyPx = ballCenterY - teeCenterY;
    const divergencePx = Math.hypot(dxPx, dyPx);
    const launched = inFlight && divergencePx > LAUNCH_DIVERGENCE_PX;

    if (launched && !this.ballDetached) {
      // Detach the ball into the scene root, preserving its world matrix so
      // there's no visual snap. The tee stays parented to combined.group.
      if (this.scene) {
        detachBallForLaunch(this.combined.group, this.combined.ballMesh, this.scene);
        this.ballDetached = true;
      }
    } else if (!inFlight && this.ballDetached) {
      // Returning to rest — re-attach the ball before the next launch cycle.
      this.reattachBallToGroup();
    }

    // ── Ball anchor (only when launched / detached) ──────────────────────
    if (this.ballDetached && ballRect.width > 0 && ballRect.height > 0) {
      // Drive the (now scene-parented) ball mesh from #flyBall directly.
      elementToWorld(this.flyBallEl, this.camera, FLY_DEPTH, this.tmpVec3b);
      this.combined.ballMesh.position.copy(this.tmpVec3b);

      // Visual scale matches the CSS rect (ball grows mid-flight, shrinks at exit).
      const ballSize = elementToWorldSize(this.flyBallEl, this.camera, FLY_DEPTH);
      const worldRadius = ballSize.width * 0.5;
      const meshScale = worldRadius * 2; // (geom is normalized to bounding-sphere 0.5)
      this.combined.ballMesh.scale.setScalar(meshScale);
      // Drop any inherited group rotation; pure world-space orientation now.
      this.combined.ballMesh.rotation.set(0, 0, 0);

      // Idle spin around Y for visual life.
      const flightHeat = Math.max(0, meshScale - 0.4);
      this.combined.ballMesh.rotation.y += dt * (BALL_IDLE_SPIN + flightHeat * 4);
      this.combined.ballMesh.rotation.x += dt * (BALL_IDLE_SPIN * 0.4 + flightHeat * 1.5);
      this.combined.ballMesh.visible = true;
    } else if (!this.ballDetached) {
      // Ball is parented to the combined group — its local position is the
      // baked offset; a tiny idle spin in local-Y still reads.
      this.combined.ballMesh.rotation.y += dt * BALL_IDLE_SPIN;
    }

    // ── Impact FX trigger ────────────────────────────────────────────────
    // Fire on the EXACT frame `inFlight` transitions false → true (i.e. when
    // secProgress first crosses PRE_IMPACT_SP). This is the same moment the
    // inline JS in index.html starts ballPath() — both consume the same
    // scrollManager.sectionProgress, so the trigger stays synced with the CSS
    // animation's launch frame. Using ball↔tee rect divergence as the trigger
    // signal was abandoned because the ball at rest already sits ~126px above
    // the tee in CSS (ball-on-top-of-tee), so the rect centers never coincide
    // and a threshold-crossing test of that distance can't detect a real launch.
    const justLaunched = inFlight && !this.wasInFlight;
    if (this.impactArmed && justLaunched) {
      this.impactArmed = false;
      this.impactElapsed = 0;
      this.teeAnimElapsed = 0;
      const impactX = this.impactX;
      const impactY = teeWorldTopY ?? 0;
      const impactZ = this.impactZ;
      if (this.shockwaveMesh) {
        this.shockwaveMesh.position.set(impactX, impactY, impactZ);
        this.shockwaveMesh.scale.setScalar(SHOCKWAVE_MAX_RADIUS * 2);
        this.shockwaveMesh.visible = true;
      }
      if (this.particleMesh) {
        this.particleMesh.position.set(impactX, impactY, impactZ);
        this.particleMesh.visible = true;
      }
      if (this.smokeMesh && !reducedMotion) {
        this.smokeMesh.position.set(impactX, impactY, impactZ);
        this.smokeMesh.visible = true;
      }
      // Skip light rays on mobile (heavy fillrate per the brief).
      if (this.lightrayMesh && !onMobile && !reducedMotion) {
        this.lightrayMesh.position.set(impactX, impactY, impactZ);
        this.lightrayMesh.visible = true;
      }
    }

    if (this.impactElapsed >= 0) {
      this.impactElapsed += dt;
      if (this.shockwaveMaterial) {
        this.shockwaveMaterial.uniforms.uProgress.value = Math.min(
          1,
          this.impactElapsed / SHOCKWAVE_DURATION_S
        );
      }
      if (this.particleMaterial) {
        this.particleMaterial.uniforms.uTime.value = this.impactElapsed;
      }
      if (this.smokeMaterial) {
        this.smokeMaterial.uniforms.uTime.value = this.impactElapsed;
      }
      if (this.lightrayMaterial) {
        this.lightrayMaterial.uniforms.uTime.value = this.impactElapsed;
      }
      const swDone = this.impactElapsed >= SHOCKWAVE_DURATION_S;
      const ptDone = this.impactElapsed >= PARTICLE_DURATION_S;
      const smDone = this.impactElapsed >= SMOKE_DURATION_S;
      const lrDone = this.impactElapsed >= LIGHTRAY_DURATION_S;
      if (swDone && this.shockwaveMesh) this.shockwaveMesh.visible = false;
      if (ptDone && this.particleMesh) this.particleMesh.visible = false;
      if (smDone && this.smokeMesh) this.smokeMesh.visible = false;
      if (lrDone && this.lightrayMesh) this.lightrayMesh.visible = false;
      if (swDone && ptDone && smDone && lrDone) {
        this.impactElapsed = -1;
      }
    }

    // Tick tee-animation timer independently of impactElapsed (which resets when
    // all FX finish). teeAnimElapsed holds the tilted/faded state for the rest of
    // the section view; it's only cleared when the section leaves view or scrolls
    // back to pre-flight.
    if (this.teeAnimElapsed >= 0) {
      this.teeAnimElapsed += dt;
    }

    // If we scroll back BEFORE in-flight, also clear any in-progress FX so
    // the next launch starts cleanly.
    if (!inFlight) {
      if (!this.impactArmed) this.impactArmed = true;
      if (this.impactElapsed >= 0) {
        this.impactElapsed = -1;
        this.hideAllFX();
      }
      if (this.teeAnimElapsed >= 0) this.teeAnimElapsed = -1;
    }

    // Save inFlight for next frame's transition detection.
    this.wasInFlight = inFlight;
  }

  /** Re-parent the ball mesh back into the combined group at its original
   *  local offset. Called when the section leaves view OR scrolls back below
   *  pre-impact. */
  private reattachBallToGroup(): void {
    if (!this.combined || !this.ballDetached) return;
    // Object3D.attach handles world→local conversion automatically.
    this.combined.group.attach(this.combined.ballMesh);
    // Snap back to the baked offset (in case world-position drift is visible).
    this.combined.ballMesh.position.copy(this.combined.ballOffset);
    this.combined.ballMesh.rotation.set(0, 0, 0);
    this.combined.ballMesh.scale.setScalar(1);
    this.ballDetached = false;
  }

  private hideAllFX(): void {
    if (this.shockwaveMesh) this.shockwaveMesh.visible = false;
    if (this.particleMesh) this.particleMesh.visible = false;
    if (this.smokeMesh) this.smokeMesh.visible = false;
    if (this.lightrayMesh) this.lightrayMesh.visible = false;
  }

  dispose(scene: THREE.Scene): void {
    if (this.combined) {
      const c = this.combined;
      // Reattach so the ball is parented to the group before scene.remove.
      this.reattachBallToGroup();
      scene.remove(c.group);
      c.ballMaterial.dispose();
      c.ballFillMaterial.dispose();
      c.teeMaterial.dispose();
      // Inner fill sphere has its own SphereGeometry — dispose it (the BALL
      // outer mesh + tee mesh share cached geometries owned by golfAndTee.ts).
      c.ballMesh.traverse((child) => {
        const m = child as THREE.Mesh;
        if (m.isMesh && m.geometry) {
          // Only dispose the inner fill geom (not the shared cached ball geom).
          const isShared = m.geometry === c.geometry;
          if (!isShared) m.geometry.dispose();
        }
      });
      this.combined = null;
    }
    if (this.teeLight) {
      scene.remove(this.teeLight);
      this.teeLight = null;
    }
    if (this.teeAmbient) {
      scene.remove(this.teeAmbient);
      this.teeAmbient = null;
    }
    if (this.matcapTex) {
      this.matcapTex.dispose();
      this.matcapTex = null;
    }
    if (this.shockwaveMesh) {
      scene.remove(this.shockwaveMesh);
      this.shockwaveMesh.geometry.dispose();
      this.shockwaveMesh = null;
    }
    if (this.shockwaveMaterial) {
      this.shockwaveMaterial.dispose();
      this.shockwaveMaterial = null;
    }
    if (this.particleMesh) {
      scene.remove(this.particleMesh);
      this.particleMesh.geometry.dispose();
      this.particleMesh = null;
    }
    if (this.particleMaterial) {
      this.particleMaterial.dispose();
      this.particleMaterial = null;
    }
    if (this.smokeMesh) {
      scene.remove(this.smokeMesh);
      this.smokeMesh.geometry.dispose();
      this.smokeMesh = null;
    }
    if (this.smokeMaterial) {
      this.smokeMaterial.dispose();
      this.smokeMaterial = null;
    }
    if (this.lightrayMesh) {
      scene.remove(this.lightrayMesh);
      this.lightrayMesh.geometry.dispose();
      this.lightrayMesh = null;
    }
    if (this.lightrayMaterial) {
      this.lightrayMaterial.dispose();
      this.lightrayMaterial = null;
    }
    document.documentElement.classList.remove('flythrough-3d');
  }
}
