import * as THREE from 'three';
import type { SceneModule } from '../SceneManager';
import type { ScrollManager } from '@core/ScrollManager';
import { elementToWorld, elementToWorldSize } from '@core/ScreenToWorld';
import { getUserPrefs } from '@core/UserPrefs';

/**
 * WorkScene — subtle "this card is clickable" hint for project cards that have
 * a `data-href` attribute (i.e., ones that open an external URL in a new tab).
 *
 * Replaces the prior per-project 3D companions + leader-line overlay.
 *
 * Visual: ~24 small accent-colored particles trace a thin band around the
 * perimeter of each clickable card. Additive blending → reads as fireflies
 * skimming the bezel. The card's own hover styles remain primary; the
 * particles are an ambient cue, not a focus pull.
 *
 * Performance:
 *   - One THREE.Points per card. Particle vertex shader animates positions
 *     analytically from a per-particle phase + a single uTime uniform — no
 *     per-frame buffer rewrite, no instancing complexity.
 *   - Per-frame work in update(): 5 getBoundingClientRect reads (cached and
 *     refreshed only on scroll/resize), a transform set per visible card, and
 *     a uTime increment. Target < 0.5ms total.
 *   - Cards outside the viewport do NOT animate their uTime (object.visible
 *     is set false, so Three's frustum cull skips draw + we skip the math).
 *
 * Mobile / reduced-motion:
 *   - On mobile (<768px or pointer:coarse) the scene mounts nothing. The
 *     existing CSS hover affordance is the entire signal.
 *   - With prefers-reduced-motion, particles render statically (uTime frozen
 *     at 0) at low opacity — no per-frame phase advance.
 */

/** Depth at which we anchor particles, matching Hero/Pursuits screen→world. */
const HEAD_DEPTH = 5;

/** Particle count per card. ~24 reads as "a few sparkles" without crowding. */
const PARTICLE_COUNT = 24;

/** Lap duration range (seconds) for one full perimeter trace. */
const LAP_SECONDS_MIN = 8;
const LAP_SECONDS_MAX = 12;

interface CardEntry {
  el: HTMLElement;
  pid: string;
  points: THREE.Points;
  material: THREE.ShaderMaterial;
  /** Cached rect — refreshed on scroll/resize, not per-frame. */
  cachedRect: DOMRect | null;
  /** Whether this card's points are currently visible/animating. */
  active: boolean;
}

function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.innerWidth < 768) return true;
  if (typeof window.matchMedia === 'function') {
    if (window.matchMedia('(pointer: coarse)').matches) return true;
  }
  return false;
}

/**
 * Read --accent CSS variable at runtime. Falls back to brand orange (#FF6A00)
 * if the var isn't set (e.g., harness contexts before stylesheet load).
 */
function readAccentColor(): THREE.Color {
  if (typeof document === 'undefined') return new THREE.Color('#FF6A00');
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  if (!raw) return new THREE.Color('#FF6A00');
  try {
    return new THREE.Color(raw);
  } catch {
    return new THREE.Color('#FF6A00');
  }
}

/**
 * Build a Points geometry whose vertex positions encode per-particle phase +
 * lap rate, NOT screen-space coordinates. The vertex shader resolves the
 * actual position from those + uniforms (uTime, uHalfWidth, uHalfHeight,
 * uWobble) at draw time. This means we don't have to rewrite the position
 * buffer when the card resizes — we only update uniforms.
 *
 * Particle attributes:
 *   - position.x = phase  (0..1, traversal of perimeter)
 *   - position.y = lapRate (radians/second; small jitter so particles drift apart)
 *   - position.z = wobble seed (0..1, used in vertical wobble)
 *
 * Vertex shader maps phase → perimeter point on a rounded rect, then offsets
 * along normal by sin(uTime * something + seed) * uWobble.
 */
function buildParticleGeometry(): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const sizes = new Float32Array(PARTICLE_COUNT);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    // Even base phase + small random jitter so a single card's particles aren't
    // perfectly equidistant (which reads mechanical).
    const basePhase = i / PARTICLE_COUNT;
    const jitter = (Math.random() - 0.5) * (0.6 / PARTICLE_COUNT);
    const phase = (basePhase + jitter + 1) % 1;
    // Lap rate: 2π / lapSeconds, with mild random scaling so each particle
    // drifts at its own pace.
    const lapSeconds =
      LAP_SECONDS_MIN + Math.random() * (LAP_SECONDS_MAX - LAP_SECONDS_MIN);
    const lapRate = (2 * Math.PI) / lapSeconds;
    const wobbleSeed = Math.random();
    positions[i * 3 + 0] = phase;
    positions[i * 3 + 1] = lapRate;
    positions[i * 3 + 2] = wobbleSeed;
    // Subtle size variation — most particles small, a few slightly larger so
    // the swarm reads alive instead of uniform.
    sizes[i] = 0.8 + Math.random() * 1.0;
  }
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  // Bounding sphere so frustum culling kicks in. We give it a generous radius
  // since the actual on-screen extent depends on the card size, set later.
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.5);
  return geom;
}

/**
 * Vertex shader: resolves a phase 0..1 to a point along the perimeter of a
 * rounded rect of half-extents (uHalfWidth, uHalfHeight). Adds a perpendicular
 * wobble so particles dance gently rather than running on a rail.
 *
 * The perimeter is parameterised by walking around the rect, distributing
 * `phase` linearly over total perimeter length (4 * (W + H), corners ignored —
 * for our scale the corner radius is small enough that this reads fine).
 */
const VERT = /* glsl */ `
attribute float aSize;

uniform float uTime;
uniform float uHalfWidth;
uniform float uHalfHeight;
uniform float uWobble;
uniform float uPxPerWorld;
uniform float uOpacity;

varying float vAlpha;

void main() {
  float phase = position.x;
  float lapRate = position.y;
  float wobbleSeed = position.z;

  // Advance phase by uTime * lapRate (analytic motion).
  float p = mod(phase + uTime * lapRate / (2.0 * 3.14159265), 1.0);

  // Walk perimeter clockwise from top-left:
  //   segment 0: top edge      (0    .. 0.25)  → x: -W → +W, y: +H
  //   segment 1: right edge    (0.25 .. 0.50)  → x: +W,    y: +H → -H
  //   segment 2: bottom edge   (0.50 .. 0.75)  → x: +W → -W, y: -H
  //   segment 3: left edge     (0.75 .. 1.00)  → x: -W,    y: -H → +H
  float W = uHalfWidth;
  float H = uHalfHeight;
  vec2 pos;
  vec2 normal;
  float seg = floor(p * 4.0);
  float segT = fract(p * 4.0);
  if (seg < 0.5) {
    pos = vec2(mix(-W, W, segT), H);
    normal = vec2(0.0, 1.0);
  } else if (seg < 1.5) {
    pos = vec2(W, mix(H, -H, segT));
    normal = vec2(1.0, 0.0);
  } else if (seg < 2.5) {
    pos = vec2(mix(W, -W, segT), -H);
    normal = vec2(0.0, -1.0);
  } else {
    pos = vec2(-W, mix(-H, H, segT));
    normal = vec2(-1.0, 0.0);
  }

  // Vertical/perpendicular wobble — sine on a per-particle phase.
  float wob = sin(uTime * 0.9 + wobbleSeed * 6.2831853) * uWobble;
  pos += normal * wob;

  // Fade in/out at segment seams so particles don't pop where corners are
  // approximated as right-angle joins. Plus a per-particle amplitude jitter
  // (wobbleSeed) keeps them subtly varied.
  float seamFade = smoothstep(0.0, 0.05, segT) * smoothstep(1.0, 0.95, segT);
  vAlpha = uOpacity * (0.55 + 0.45 * seamFade) * (0.7 + 0.3 * wobbleSeed);

  vec4 mvPosition = modelViewMatrix * vec4(pos.x, pos.y, 0.0, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  // gl_PointSize in pixels — derived from the size attribute and viewport DPR.
  // We size in screen pixels rather than world units so a wide card and a
  // narrow card show particles of comparable visual weight.
  gl_PointSize = aSize * uPxPerWorld;
}
`;

/**
 * Fragment shader: render each point as a soft additive disc — gaussian
 * falloff from center → 0 at perimeter so neighboring particles blend smoothly
 * rather than tiling as squares.
 */
const FRAG = /* glsl */ `
precision mediump float;

uniform vec3 uColor;
varying float vAlpha;

void main() {
  // gl_PointCoord is 0..1 across the point sprite. Center it and compute r.
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  if (r > 0.5) discard;
  // Gaussian-ish falloff. Strong at center, soft at edge. The constant tunes
  // the "sharpness" of the dot — lower = softer halo, higher = harder pinpoint.
  float a = exp(-r * r * 10.0);
  gl_FragColor = vec4(uColor, a * vAlpha);
}
`;

export class WorkScene implements SceneModule {
  readonly name = 'work';

  private readonly camera: THREE.PerspectiveCamera;
  private readonly scrollManager: ScrollManager;
  private scene!: THREE.Scene;
  private cards: CardEntry[] = [];
  private group?: THREE.Group;
  private mobileMode = false;
  private reducedMotion = false;
  private rectsDirty = true;
  private unsubScroll: (() => void) | null = null;
  private onResize = (): void => { this.rectsDirty = true; };
  private elapsed = 0;

  constructor(camera: THREE.PerspectiveCamera, scrollManager: ScrollManager) {
    this.camera = camera;
    this.scrollManager = scrollManager;
  }

  init(scene: THREE.Scene): void {
    this.scene = scene;

    const prefs = getUserPrefs();
    this.mobileMode = prefs.isMobile || isMobileViewport();
    this.reducedMotion = prefs.reducedMotion;

    if (this.mobileMode) {
      // Mobile: existing CSS already shows pointer cursor + hover styles
      // on .project[data-href]. Nothing to mount.
      return;
    }

    const accent = readAccentColor();

    // Discover all clickable project cards.
    const cardEls = document.querySelectorAll<HTMLElement>(
      'section#projects .project[data-href]'
    );
    if (cardEls.length === 0) return;

    this.group = new THREE.Group();
    this.group.name = 'work-link-particles';
    this.scene.add(this.group);

    // Shared geometry — particles are positioned in card-local space by the
    // vertex shader, so geometry is identical across cards. We still create
    // ONE geometry per card so per-particle attribute jitter differs (each
    // card's swarm reads as its own; sharing would tile them in lock-step).
    for (const el of Array.from(cardEls)) {
      const pidEl = el.querySelector<HTMLElement>('.pid');
      const pidText = (pidEl?.textContent ?? '').trim();
      const m = /PRJ_(\d+)/.exec(pidText);
      const pid = m ? m[1] : 'XX';

      const geom = buildParticleGeometry();
      const material = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uTime: { value: 0 },
          uHalfWidth: { value: 1 },
          uHalfHeight: { value: 1 },
          uWobble: { value: 0.04 },
          uPxPerWorld: { value: 4 },
          uColor: { value: accent.clone() },
          // Reduced motion → constant low opacity, no per-frame motion.
          uOpacity: { value: this.reducedMotion ? 0.45 : 0.85 },
        },
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
      });
      const points = new THREE.Points(geom, material);
      points.frustumCulled = false; // we cull manually via `visible` from rect window
      points.visible = false;
      points.renderOrder = 5; // above ground/scene, below UI overlays

      this.group.add(points);
      this.cards.push({
        el,
        pid,
        points,
        material,
        cachedRect: null,
        active: false,
      });
    }

    this.unsubScroll = this.scrollManager.onUpdate(() => { this.rectsDirty = true; });
    window.addEventListener('resize', this.onResize, { passive: true });
  }

  update(dt: number, _scrollProgress: number): void {
    if (this.mobileMode) return;
    if (this.cards.length === 0) return;

    // Perf gate: skip when #projects is far from viewport.
    const sectionT = this.scrollManager.sectionProgress('projects');
    if (sectionT < -0.20 || sectionT > 1.20) {
      // Hide all cards' points so frustum culling drops them.
      for (const c of this.cards) {
        if (c.active) {
          c.points.visible = false;
          c.active = false;
        }
      }
      return;
    }

    if (!this.reducedMotion) {
      this.elapsed += dt;
    }

    if (this.rectsDirty) {
      for (const c of this.cards) {
        c.cachedRect = c.el.getBoundingClientRect();
      }
      this.rectsDirty = false;
    }

    const vh = window.innerHeight;
    // gl_PointSize is in framebuffer pixels. We want each particle to be ~4–10
    // CSS pixels wide so it reads as a small soft glow, not a dot. Account for
    // DPR (capped at 2) so HiDPI canvases match. The aSize attribute provides
    // per-particle scatter on top of this base.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pointSizeBasis = 6.5 * dpr;

    for (const c of this.cards) {
      const rect = c.cachedRect ?? c.el.getBoundingClientRect();
      // Visible window: card's rect overlaps a generous extension of viewport.
      // We only animate cards that are at least near-screen. ±50vh hysteresis
      // matches the user's natural scroll "look ahead" without thrashing.
      const inViewport = rect.bottom > -vh * 0.5 && rect.top < vh * 1.5;
      if (!inViewport) {
        if (c.active) {
          c.points.visible = false;
          c.active = false;
        }
        continue;
      }

      // Position the particle field at the card's center, on the HEAD_DEPTH plane.
      const worldCenter = elementToWorld(c.el, this.camera, HEAD_DEPTH);
      c.points.position.copy(worldCenter);

      // Card's world-space half-extents — feed to shader so the rounded-rect
      // perimeter math matches the actual card size.
      const sz = elementToWorldSize(c.el, this.camera, HEAD_DEPTH);
      // Slight inset so particles ride the bezel rather than spilling outside.
      const inset = 0.985;
      c.material.uniforms.uHalfWidth.value = (sz.width / 2) * inset;
      c.material.uniforms.uHalfHeight.value = (sz.height / 2) * inset;
      // Wobble amplitude scales with card height — bigger cards get a bit more
      // motion latitude; smaller cards stay tight.
      c.material.uniforms.uWobble.value = Math.min(0.06, sz.height * 0.012);
      c.material.uniforms.uPxPerWorld.value = pointSizeBasis;
      c.material.uniforms.uTime.value = this.elapsed;

      if (!c.active) {
        c.points.visible = true;
        c.active = true;
      }
    }
  }

  dispose(scene: THREE.Scene): void {
    if (this.unsubScroll) {
      this.unsubScroll();
      this.unsubScroll = null;
    }
    window.removeEventListener('resize', this.onResize);

    if (this.group) {
      scene.remove(this.group);
      this.group = undefined;
    }
    for (const c of this.cards) {
      c.points.geometry.dispose();
      c.material.dispose();
    }
    this.cards.length = 0;
  }
}
