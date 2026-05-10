import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { gsap } from 'gsap';

import type { SceneModule } from '../SceneManager';
import type { ScrollManager } from '@core/ScrollManager';
import type { PhysicsWorld } from '@physics/PhysicsWorld';
import { getUserPrefs } from '@core/UserPrefs';

import { buildGolfBallMeshFromGLB } from '../shared/golfBall';
import { Hole } from './Hole';
import { GreenSurface } from './GreenSurface';

/**
 * ContactScene — ambient finale. A golf ball drops into a cup positioned in
 * the bottom-right of the viewport, so the contact headline + links + footer
 * remain fully visible the entire time.
 *
 * Design (post-feedback rework):
 *   - Contact info (headline / email / phone / github / footer) is visible at
 *     normal CSS opacity at all times. The ball-drop animation is a corner
 *     flourish, NOT a content gate.
 *   - Hole + green + ball anchored to a screen-relative spot in the lower
 *     right (driven by camera aspect at init / resize). On mobile, the spot
 *     scales inward to stay on-screen.
 *   - Hybrid physics + GSAP on desktop: first phases use Rapier (real
 *     rolling), final phases use GSAP scripted so the ball can't snag on the
 *     rim. Mobile uses a simple kinematic tween into the cup.
 *
 * Camera coordination with TrajectoryScene:
 *   TrajectoryScene damps the camera back to (0,0,5) lookAt origin when the
 *   user leaves #career. ContactScene NO LONGER tilts the camera down — the
 *   hole is placed in the bottom-right of the natural view so a tilt would
 *   make it look misaligned. We do still apply a tiny camera shake on the
 *   drop "thunk".
 *
 * Stencil: NONE.
 *
 * Pointer-events: no DOM mutation other than (a) injecting a <style> tag for
 *   the LIVE pulse keyframe and (b) wrapping the literal word "LIVE" inside
 *   `.footnote span` so the keyframe has a target. No opacity overrides on
 *   the contact / footer DOM — links stay clickable from the moment the
 *   section enters the viewport.
 */

const SECTION_ID = 'contact';

// Animation durations (seconds).
const FIRST_PLAY_TOTAL_S = 2.2;
const REPLAY_TOTAL_S = 1.5;

// Phase timing as fractions of total (so first/replay reuse the same shape):
const PHASE_FALL_END = 0.27;   // 0..0.6s on first play (0..0.41s on replay)
const PHASE_ROLL_END = 0.68;   // 0.6..1.5s
const PHASE_TEETER_END = 0.82; // 1.5..1.8s
const PHASE_DROP_END = 1.0;    // 1.8..2.2s

// Scroll-progress thresholds for triggering / resetting.
const TRIGGER_SP = 0.05;
const RESET_SP = 0.001; // user has scrolled essentially out of the section

// Camera shake (post-drop "thunk"). Pitch override is gone — the hole sits in
// the bottom-right of the natural camera view so we don't need a putting-view
// tilt.
const DEFAULT_CAMERA_POS = new THREE.Vector3(0, 0, 5);
const CAMERA_DEFAULT_LOOKAT = new THREE.Vector3(0, 0, 0);

// Anchor target — fraction of half-width / half-height from screen center.
// Positive x = right, negative y = below center. The actual world coord is
// recomputed from camera aspect at init() / resize() so the hole stays in the
// bottom-right corner regardless of viewport.
const ANCHOR_X_FRACTION = 0.55;   // 55% of half-width to the right
const ANCHOR_Y_FRACTION = -0.62;  // 62% of half-height below center

// Ball geometry
const BALL_RADIUS = 0.16;

// Hole geometry (smaller — corner flourish, not a stage)
const HOLE_RIM_RADIUS = 0.36;
const HOLE_TUBE_RADIUS = 0.018;

// Green-plane footprint (anchored at the hole). Made small enough to read as a
// vignette around the cup rather than a full backdrop.
const GREEN_WIDTH = 2.6;
const GREEN_DEPTH = 1.8;

// Ball trajectory expressed as offsets from the hole anchor — recomputed at
// init/resize together with HOLE_CENTER. Defaults are placeholder; the real
// values are set inside `recomputeAnchor()`.
const HOLE_CENTER = new THREE.Vector3(1.85, -1.35, 0);
const BALL_START = new THREE.Vector3(0, 0, 0);
const BALL_LAND = new THREE.Vector3(0, 0, 0);
const BALL_TEETER = new THREE.Vector3(0, 0, 0);
let BALL_DROP_DEPTH = -2.0;

// Offset shape (relative to HOLE_CENTER). Same trajectory shape as before but
// scaled smaller to match the new corner footprint.
const BALL_START_OFFSET = new THREE.Vector3(0.85, 1.85, 0.45);
const BALL_LAND_OFFSET = new THREE.Vector3(0.45, 0, 0.30);   // .y is HOLE_CENTER.y + BALL_RADIUS, set later
const BALL_TEETER_OFFSET = new THREE.Vector3(0.18, 0, 0.0);  // .y is HOLE_CENTER.y + BALL_RADIUS, set later
const BALL_DROP_DEPTH_OFFSET = -0.7;                         // BALL_DROP_DEPTH = HOLE_CENTER.y + this

const isMobile =
  typeof window !== 'undefined' &&
  (window.innerWidth < 768 ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches));

export class ContactScene implements SceneModule {
  readonly name = 'contact';

  private readonly camera: THREE.PerspectiveCamera;
  private readonly scrollManager: ScrollManager;
  private readonly physics: PhysicsWorld;

  private scene!: THREE.Scene;
  private group!: THREE.Group;
  private mounted = false;

  // Visual elements
  private green!: GreenSurface;
  private hole!: Hole;
  private ballMesh!: THREE.Mesh;
  private ballMaterial!: THREE.ShaderMaterial;
  /** Inner fill sphere material (GLB ball builds it; mirrors uOpacity). */
  private ballFillMaterial: THREE.ShaderMaterial | null = null;
  private matcapTex?: THREE.Texture;

  // Physics handles (desktop only)
  private ballBody?: RAPIER.RigidBody;
  private ballCollider?: RAPIER.Collider;
  private greenBody?: RAPIER.RigidBody;
  private greenCollider?: RAPIER.Collider;
  private bodyMode: 'kinematic' | 'dynamic' = 'kinematic';

  // Animation state
  private timeline: gsap.core.Timeline | null = null;
  private hasPlayed = false;        // has it ever finished
  private isPlaying = false;
  private armedForReplay = true;    // false while ball is mid-animation

  // Camera shake (post-drop)
  private shakeT = 0;                // counts down 0..0.4s
  private shakeAmount = 0;

  // Cached camera aspect for anchor recompute trigger.
  private cachedAspect = 0;

  // Hole's "as-constructed" position (used to compute resize delta).
  private holeInitX = 0;
  private holeInitY = 0;
  private holeInitZ = 0;

  // DOM/style targets we own.
  private styleTag: HTMLStyleElement | null = null;
  private liveObserver: MutationObserver | null = null;

  constructor(
    camera: THREE.PerspectiveCamera,
    scrollManager: ScrollManager,
    physics: PhysicsWorld
  ) {
    this.camera = camera;
    this.scrollManager = scrollManager;
    this.physics = physics;
  }

  async init(scene: THREE.Scene): Promise<void> {
    this.scene = scene;

    // Compute the world-anchor (HOLE_CENTER) from the camera aspect — we want
    // the hole to land in the bottom-right of the natural view. This also
    // populates BALL_START / BALL_LAND / BALL_TEETER / BALL_DROP_DEPTH.
    this.recomputeAnchor();

    // ------- Visuals (3D) -------
    this.group = new THREE.Group();
    this.green = new GreenSurface({
      y: HOLE_CENTER.y,
      width: GREEN_WIDTH,
      depth: GREEN_DEPTH,
    });
    // GreenSurface only sets y on its mesh; translate x/z manually so the
    // plane sits under the hole.
    this.green.mesh.position.x = HOLE_CENTER.x;
    this.green.mesh.position.z = HOLE_CENTER.z;
    this.group.add(this.green.mesh);

    this.hole = new Hole({
      centerX: HOLE_CENTER.x,
      centerZ: HOLE_CENTER.z,
      surfaceY: HOLE_CENTER.y,
      rimRadius: HOLE_RIM_RADIUS,
      tubeRadius: HOLE_TUBE_RADIUS,
    });
    this.holeInitX = HOLE_CENTER.x;
    this.holeInitY = HOLE_CENTER.y;
    this.holeInitZ = HOLE_CENTER.z;
    this.group.add(this.hole.group);

    // Ball — REUSE Hero's shader + the shared GLB geometry. Smaller visual
    // scale here (BALL_RADIUS=0.18) than the hero stage (0.5); since the
    // shared geometry is normalized to bounding-sphere radius 0.5, we scale
    // the mesh by BALL_RADIUS/0.5 to land at the contact-scene size while
    // keeping the same dimpled silhouette.
    const loader = new THREE.TextureLoader();
    this.matcapTex = loader.load('/textures/matcap-pearl.png');
    this.matcapTex.colorSpace = THREE.SRGBColorSpace;
    this.matcapTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.matcapTex.magFilter = THREE.LinearFilter;
    this.matcapTex.generateMipmaps = true;

    const built = await buildGolfBallMeshFromGLB(this.matcapTex, {
      rimStrength: 0.45,
      rimColor: new THREE.Color(0x9ec3d6),
      // GLB has real dimple geometry — let the actual mesh normals drive the
      // matcap highlight pattern instead of the procedural normal map.
      useDimpleMap: false,
      // Match Hero: soften matcap so dimples don't read as black pits.
      matcapSoftness: 0.55,
      opacity: 1.0,
      transparent: true, // we fade the ball after drop
    });
    this.ballMesh = built.mesh;
    this.ballMaterial = built.material;
    // The GLB builder returns an inner fill sphere; mirror transparency on
    // it so the ball drop fade-out applies to both layers.
    if (built.fillMaterial) {
      built.fillMaterial.transparent = true;
      this.ballFillMaterial = built.fillMaterial;
    }
    // Scale the visual mesh to BALL_RADIUS while leaving the cached geometry
    // at its normalized radius 0.5 (so HeroScene sees the same source).
    const visualScale = BALL_RADIUS / 0.5;
    this.ballMesh.scale.setScalar(visualScale);
    this.ballMesh.position.copy(BALL_START);
    this.ballMesh.visible = false; // hidden until first trigger
    this.group.add(this.ballMesh);

    // ------- Physics (desktop only) -------
    if (!isMobile && this.physics.ready) {
      // A FIXED thin slab acting as the green floor — ball rolls on it during
      // phase B. It does NOT have a hole cut out (Rapier collider geometry
      // doesn't easily support holes); instead, ContactScene's GSAP phase C
      // takes over before the ball reaches the cup mouth, so the ball never
      // actually needs the floor to be missing under the cup.
      const greenDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(
        HOLE_CENTER.x, HOLE_CENTER.y - 0.05, HOLE_CENTER.z
      );
      this.greenBody = this.physics.addRigidBody(greenDesc);
      // Cuboid half-extents — wider than the visible green so the ball can't
      // accidentally roll off the edge mid-animation.
      const greenColDesc = RAPIER.ColliderDesc.cuboid(GREEN_WIDTH * 0.7, 0.05, GREEN_DEPTH * 0.7)
        .setRestitution(0.25)
        .setFriction(0.55);
      this.greenCollider = this.physics.addCollider(greenColDesc, this.greenBody);

      // Ball — start as kinematic-position-based; we'll convert to dynamic
      // when phase B begins (so it can really roll on the floor).
      const ballDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(BALL_START.x, BALL_START.y, BALL_START.z)
        .setLinearDamping(0.35)
        .setAngularDamping(0.6)
        .setGravityScale(1.0); // unlike Hero, we WANT gravity here
      this.ballBody = this.physics.addRigidBody(ballDesc);
      const ballColDesc = RAPIER.ColliderDesc.ball(BALL_RADIUS)
        .setRestitution(0.4)
        .setFriction(0.5)
        .setDensity(1.2);
      this.ballCollider = this.physics.addCollider(ballColDesc, this.ballBody);

      // We start the ball as kinematic so it doesn't fall before the first
      // trigger fires.
      this.bodyMode = 'kinematic';
    }

    // ------- DOM augmentation (LIVE pulse only — NO opacity gating) -------
    this.setupLivePulse();
    this.injectStyles();

    // Don't mount yet — only mount when entering the section to save draw calls
    // for users who never reach the contact section.
  }

  /**
   * Recompute the hole / ball anchor positions based on current camera aspect.
   * Result: HOLE_CENTER lands at (ANCHOR_X_FRACTION * halfW, ANCHOR_Y_FRACTION
   * * halfH, 0). Trajectory offsets are scaled with HOLE_CENTER so the visual
   * proportions stay consistent at any aspect.
   */
  private recomputeAnchor(): void {
    const fovRad = (this.camera.fov * Math.PI) / 180;
    // Visible bounds at z=0 from camera at (0,0,5).
    const halfH = Math.tan(fovRad / 2) * 5;
    const halfW = halfH * this.camera.aspect;

    // Clamp the X fraction so very narrow viewports don't shove the hole
    // entirely off-screen on one side. We want at least ~halfW * 0.4 of room
    // to the right of the hole for the green plane.
    const minRightRoom = Math.min(halfW, GREEN_WIDTH * 0.55);
    const maxX = Math.max(halfW * 0.0, halfW - minRightRoom);
    HOLE_CENTER.x = Math.min(halfW * ANCHOR_X_FRACTION, maxX);
    HOLE_CENTER.y = halfH * ANCHOR_Y_FRACTION;
    HOLE_CENTER.z = 0;

    // Apply offsets relative to HOLE_CENTER.
    BALL_START.set(
      HOLE_CENTER.x + BALL_START_OFFSET.x,
      HOLE_CENTER.y + BALL_START_OFFSET.y,
      HOLE_CENTER.z + BALL_START_OFFSET.z
    );
    BALL_LAND.set(
      HOLE_CENTER.x + BALL_LAND_OFFSET.x,
      HOLE_CENTER.y + BALL_RADIUS,
      HOLE_CENTER.z + BALL_LAND_OFFSET.z
    );
    BALL_TEETER.set(
      HOLE_CENTER.x + BALL_TEETER_OFFSET.x,
      HOLE_CENTER.y + BALL_RADIUS,
      HOLE_CENTER.z + BALL_TEETER_OFFSET.z
    );
    BALL_DROP_DEPTH = HOLE_CENTER.y + BALL_DROP_DEPTH_OFFSET;

    this.cachedAspect = this.camera.aspect;
  }

  /**
   * Wire the ambient "LIVE" pulse in the footer. No opacity manipulation —
   * the contact info / footer render at their normal CSS opacity.
   */
  private setupLivePulse(): void {
    // Mark the LIVE word inside the right footer span.
    // Existing markup is "VER 9.4.0 · TRACKED · LIVE" (single text node).
    // We wrap "LIVE" in its own span so we can attach a CSS animation.
    this.wrapLiveWord();

    // Lang-toggle robustness. The site's `applyLang(lang)` does
    // `el.innerHTML = I18N[lang][key]` on `[data-i18n]` nodes — that blows
    // away our LIVE wrap. Watch for that mutation and re-wrap on the spot.
    const right = document.querySelector<HTMLElement>('.footnote span:nth-child(2)');
    if (right) {
      const observer = new MutationObserver(() => {
        if (!right.querySelector('.contact-live')) this.wrapLiveWord();
      });
      observer.observe(right, { childList: true, characterData: true, subtree: true });
      this.liveObserver = observer;
    }
  }

  /** Find "LIVE" inside .footnote span:nth-child(2) and wrap it for CSS animation. */
  private wrapLiveWord(): void {
    const right = document.querySelector<HTMLElement>('.footnote span:nth-child(2)');
    if (!right) return;
    if (right.querySelector('.contact-live')) return;
    const text = right.textContent ?? '';
    const idx = text.lastIndexOf('LIVE');
    if (idx < 0) return;
    const before = text.slice(0, idx);
    const live = text.slice(idx, idx + 4);
    const after = text.slice(idx + 4);
    right.textContent = '';
    right.appendChild(document.createTextNode(before));
    const span = document.createElement('span');
    span.className = 'contact-live';
    span.textContent = live;
    right.appendChild(span);
    if (after) right.appendChild(document.createTextNode(after));
  }

  /** Inject the LIVE pulse keyframes (additive — does not affect existing styles). */
  private injectStyles(): void {
    const css = `
@keyframes contact-live-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50%      { transform: scale(1.04); opacity: 0.85; }
}
.contact-live {
  display: inline-block;
  transform-origin: center;
  animation: contact-live-pulse 1.6s ease-in-out infinite;
}
`.trim();
    this.styleTag = document.createElement('style');
    this.styleTag.id = 'contact-scene-style';
    this.styleTag.textContent = css;
    document.head.appendChild(this.styleTag);
  }

  private mount(): void {
    if (this.mounted) return;
    this.scene.add(this.group);
    this.mounted = true;
  }

  private unmount(): void {
    if (!this.mounted) return;
    this.scene.remove(this.group);
    this.mounted = false;
  }

  /** Hand off the kinematic ball to dynamic so physics drives the roll. */
  private switchBallToDynamic(): void {
    if (!this.ballBody) return;
    if (this.bodyMode === 'dynamic') return;
    this.ballBody.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    this.bodyMode = 'dynamic';
  }

  /** Switch back to kinematic so we can scripted-tween the ball into the cup. */
  private switchBallToKinematic(): void {
    if (!this.ballBody) return;
    if (this.bodyMode === 'kinematic') return;
    // Zero velocities first so the next setNextKinematicTranslation call doesn't
    // race against residual physics.
    this.ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.ballBody.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    this.bodyMode = 'kinematic';
  }

  /** Build & start the GSAP timeline that orchestrates the four phases. */
  private startAnimation(replay: boolean): void {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.armedForReplay = false;

    // Reset visual state
    this.ballMesh.visible = true;
    this.ballMaterial.uniforms.uOpacity.value = 1.0;
    if (this.ballFillMaterial) this.ballFillMaterial.uniforms.uOpacity.value = 1.0;
    this.hole.setGlow(0);

    if (this.timeline) {
      this.timeline.kill();
      this.timeline = null;
    }

    const total = replay ? REPLAY_TOTAL_S : FIRST_PLAY_TOTAL_S;

    // Reduced motion: skip the ball drop entirely. Hide the ball, fade in
    // contact info immediately. We still build a tiny GSAP timeline so the
    // onComplete bookkeeping fires identically.
    if (getUserPrefs().reducedMotion) {
      this.ballMesh.visible = false;
      this.timeline = this.buildReducedMotionTimeline();
      return;
    }

    // Prepare positions in animation-local refs (closures bind ballMesh / body).
    if (isMobile || !this.ballBody) {
      this.timeline = this.buildMobileTimeline(total);
    } else {
      this.timeline = this.buildDesktopTimeline(total);
    }
  }

  /**
   * Reduced-motion: zero-duration timeline that just triggers
   * `onAnimationComplete`. No ball drop, no shake — and no DOM tweening
   * (content was always visible).
   */
  private buildReducedMotionTimeline(): gsap.core.Timeline {
    const tl = gsap.timeline({
      onComplete: () => this.onAnimationComplete(),
    });
    // Tiny duration so the onComplete fires next tick.
    tl.to({}, { duration: 0.01 });
    return tl;
  }

  /** Mobile: simplified — kinematic Y from above-hole straight to in-cup over total*0.6s. */
  private buildMobileTimeline(total: number): gsap.core.Timeline {
    const tl = gsap.timeline({
      onComplete: () => this.onAnimationComplete(),
    });

    // Place the ball directly above the hole at a height that stays inside
    // the green-plane footprint (above the rim).
    const ballAbove = HOLE_CENTER.y + 1.4;
    this.ballMesh.position.set(HOLE_CENTER.x, ballAbove, HOLE_CENTER.z);

    // Drop straight down to cup mouth, then into the cup.
    tl.to(this.ballMesh.position, {
      y: HOLE_CENTER.y + BALL_RADIUS,
      duration: total * 0.55,
      ease: 'power2.in',
    });
    tl.to(this.ballMesh.position, {
      y: BALL_DROP_DEPTH,
      duration: total * 0.30,
      ease: 'power2.in',
    });
    // Fade the ball out as it disappears below.
    tl.to(this.ballMaterial.uniforms.uOpacity, {
      value: 0,
      duration: total * 0.25,
      ease: 'power2.out',
      onUpdate: () => {
        if (this.ballFillMaterial)
          this.ballFillMaterial.uniforms.uOpacity.value =
            this.ballMaterial.uniforms.uOpacity.value;
      },
    }, `-=${total * 0.20}`);

    // No camera shake on mobile, no DOM fade — content was visible all along.
    return tl;
  }

  /** Desktop: hybrid kinematic-fall → dynamic-roll → kinematic-drop-in. */
  private buildDesktopTimeline(total: number): gsap.core.Timeline {
    const ballBody = this.ballBody!;

    const phaseFallEnd = total * PHASE_FALL_END;
    const phaseRollEnd = total * PHASE_ROLL_END;
    const phaseTeeterEnd = total * PHASE_TEETER_END;
    const phaseDropEnd = total * PHASE_DROP_END;

    // Initialize ball position (kinematic) at start.
    this.switchBallToKinematic();
    ballBody.setNextKinematicTranslation({
      x: BALL_START.x, y: BALL_START.y, z: BALL_START.z,
    });
    this.ballMesh.position.copy(BALL_START);

    // We script phase A as a kinematic GSAP tween of {x,y,z} from BALL_START
    // to BALL_LAND (a parabolic-feel curve via separate eases on x/z and y).
    // Then at boundary A→B we flip to dynamic, set linvel toward the hole.
    const fallProxy = { x: BALL_START.x, y: BALL_START.y, z: BALL_START.z };
    const tl = gsap.timeline({
      onComplete: () => this.onAnimationComplete(),
    });

    // Phase A — fall + side-arc landing
    tl.to(fallProxy, {
      x: BALL_LAND.x,
      z: BALL_LAND.z,
      duration: phaseFallEnd,
      ease: 'power1.in',
      onUpdate: () => {
        if (this.bodyMode === 'kinematic') {
          ballBody.setNextKinematicTranslation({ x: fallProxy.x, y: fallProxy.y, z: fallProxy.z });
        }
      },
    }, 0);
    tl.to(fallProxy, {
      y: BALL_LAND.y,
      duration: phaseFallEnd,
      ease: 'power2.in',
      onUpdate: () => {
        if (this.bodyMode === 'kinematic') {
          ballBody.setNextKinematicTranslation({ x: fallProxy.x, y: fallProxy.y, z: fallProxy.z });
        }
      },
    }, 0);

    // Phase A→B: switch to dynamic, apply velocity toward hole.
    tl.add(() => {
      this.switchBallToDynamic();
      // Snap body to the precise landing position before going dynamic.
      ballBody.setTranslation({ x: BALL_LAND.x, y: BALL_LAND.y + 0.001, z: BALL_LAND.z }, true);
      ballBody.setLinvel({ x: 0, y: 0.0, z: 0 }, true);
      // Direction from landing toward hole, scaled to traverse ~|land-teeter|
      // over (phaseRollEnd - phaseFallEnd) seconds.
      const dir = new THREE.Vector3(
        BALL_TEETER.x - BALL_LAND.x,
        0,
        BALL_TEETER.z - BALL_LAND.z
      );
      const dist = dir.length();
      const rollT = phaseRollEnd - phaseFallEnd;
      const speed = (dist / Math.max(rollT, 0.1)) * 1.05; // +5% so we arrive on time
      dir.normalize().multiplyScalar(speed);
      ballBody.setLinvel({ x: dir.x, y: 0, z: dir.z }, true);
      // A small downward angular impulse so it rolls visually.
      // Angular vector should be perpendicular to motion (right-hand rule).
      const ang = new THREE.Vector3(-dir.z, 0, dir.x).normalize().multiplyScalar(speed / BALL_RADIUS);
      ballBody.setAngvel({ x: ang.x, y: 0, z: ang.z }, true);
    }, phaseFallEnd);

    // Phase B (dynamic, no GSAP needed) — runs from phaseFallEnd → phaseRollEnd
    // physics in update() syncs mesh.

    // Phase B→C boundary: switch back to kinematic, set up teeter then drop.
    const teeterProxy = { x: 0, y: 0, z: 0 };
    tl.add(() => {
      this.switchBallToKinematic();
      // Read current physics-derived position so we don't snap visually if the
      // ball is slightly off the planned teeter spot.
      const t = ballBody.translation();
      teeterProxy.x = t.x;
      teeterProxy.y = t.y;
      teeterProxy.z = t.z;
      ballBody.setNextKinematicTranslation(t);
    }, phaseRollEnd);

    // Phase C — teeter on the rim. Tween XZ to the rim edge with tiny y wobble.
    const teeterDuration = phaseTeeterEnd - phaseRollEnd;
    tl.to(teeterProxy, {
      x: HOLE_CENTER.x + 0.1,
      z: HOLE_CENTER.z + 0.0,
      y: HOLE_CENTER.y + BALL_RADIUS + 0.02,
      duration: teeterDuration,
      ease: 'power1.inOut',
      onUpdate: () => {
        // Tiny sinusoidal y wobble layered on the tween value.
        const t = (Date.now() % 1000) / 1000;
        const wob = Math.sin(t * Math.PI * 6) * 0.012;
        ballBody.setNextKinematicTranslation({
          x: teeterProxy.x,
          y: teeterProxy.y + wob,
          z: teeterProxy.z,
        });
      },
    }, phaseRollEnd);

    // Phase C→D boundary: rim flash starts (will peak ~at phaseDropEnd).
    tl.to(this.hole, {
      // We tween the uniform via setGlow indirectly through a proxy.
      duration: phaseDropEnd - phaseTeeterEnd,
    }, phaseTeeterEnd);

    // Phase D — drop into cup. Animate y from rim → BALL_DROP_DEPTH while
    // fading opacity from 1 → 0 in the back half.
    const dropProxy = { y: HOLE_CENTER.y + BALL_RADIUS, glow: 0, opacity: 1 };
    tl.to(dropProxy, {
      y: BALL_DROP_DEPTH,
      duration: phaseDropEnd - phaseTeeterEnd,
      ease: 'power2.in',
      onUpdate: () => {
        ballBody.setNextKinematicTranslation({
          x: HOLE_CENTER.x,
          y: dropProxy.y,
          z: HOLE_CENTER.z,
        });
      },
    }, phaseTeeterEnd);
    tl.to(dropProxy, {
      glow: 0.6,
      duration: (phaseDropEnd - phaseTeeterEnd) * 0.35,
      ease: 'power2.out',
      onUpdate: () => this.hole.setGlow(dropProxy.glow),
    }, phaseTeeterEnd);
    tl.to(dropProxy, {
      glow: 0,
      duration: (phaseDropEnd - phaseTeeterEnd) * 0.65,
      ease: 'power2.in',
      onUpdate: () => this.hole.setGlow(dropProxy.glow),
    }, phaseTeeterEnd + (phaseDropEnd - phaseTeeterEnd) * 0.35);
    tl.to(dropProxy, {
      opacity: 0,
      duration: (phaseDropEnd - phaseTeeterEnd) * 0.55,
      ease: 'power2.out',
      onUpdate: () => {
        this.ballMaterial.uniforms.uOpacity.value = dropProxy.opacity;
        if (this.ballFillMaterial)
          this.ballFillMaterial.uniforms.uOpacity.value = dropProxy.opacity;
      },
    }, phaseTeeterEnd + (phaseDropEnd - phaseTeeterEnd) * 0.30);

    // Camera shake — start at phaseDropEnd, lasts 0.4s
    tl.add(() => {
      this.shakeT = 0.4;
      this.shakeAmount = 0.005; // radians
    }, phaseDropEnd);

    return tl;
  }

  private onAnimationComplete(): void {
    this.isPlaying = false;
    this.hasPlayed = true;
    // Hide ball mesh — it's at BALL_DROP_DEPTH and opacity 0, but stop drawing
    // it entirely to save the draw call.
    this.ballMesh.visible = false;
    // Make sure the body isn't still doing physics work after the finale.
    if (this.ballBody) {
      this.ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  /**
   * Sync visual + physics-body positions to the recomputed HOLE_CENTER. Called
   * after `recomputeAnchor()` on aspect change. The Hole's internal meshes
   * (rim torus, cup disc, shadow ring) bake their world positions at
   * construction, so we move them together by translating their parent group.
   */
  private repositionAnchorMeshes(): void {
    if (this.green) {
      this.green.mesh.position.x = HOLE_CENTER.x;
      this.green.mesh.position.y = HOLE_CENTER.y;
      this.green.mesh.position.z = HOLE_CENTER.z;
    }
    if (this.hole) {
      // Translate the hole-group by the delta from its baked construction
      // position so it follows the new HOLE_CENTER.
      this.hole.group.position.set(
        HOLE_CENTER.x - this.holeInitX,
        HOLE_CENTER.y - this.holeInitY,
        HOLE_CENTER.z - this.holeInitZ
      );
    }
    if (this.greenBody) {
      this.greenBody.setTranslation(
        { x: HOLE_CENTER.x, y: HOLE_CENTER.y - 0.05, z: HOLE_CENTER.z },
        true
      );
    }
    if (this.ballBody && !this.isPlaying) {
      this.ballBody.setTranslation(
        { x: BALL_START.x, y: BALL_START.y, z: BALL_START.z },
        true
      );
      this.ballMesh.position.copy(BALL_START);
    }
  }

  /** Reset state so the next entry replays the animation. */
  private resetForReplay(): void {
    if (this.timeline) {
      this.timeline.kill();
      this.timeline = null;
    }
    this.isPlaying = false;
    this.armedForReplay = true;
    this.ballMaterial.uniforms.uOpacity.value = 1.0;
    if (this.ballFillMaterial) this.ballFillMaterial.uniforms.uOpacity.value = 1.0;
    this.ballMesh.visible = false;
    this.hole.setGlow(0);

    // Contact info / footer remain at their normal CSS opacity — no DOM
    // reset needed. The ball-drop on replay is purely an ambient flourish.

    // Reset ball physics.
    if (this.ballBody) {
      this.switchBallToKinematic();
      this.ballBody.setTranslation(
        { x: BALL_START.x, y: BALL_START.y, z: BALL_START.z },
        true
      );
      this.ballMesh.position.copy(BALL_START);
    }
  }

  update(dt: number): void {
    const sp = this.scrollManager.sectionProgress(SECTION_ID);
    const inSection = sp > 0.0001;

    // Perf gate: when the contact section hasn't been touched yet AND we're
    // not in the middle of an animation, bail. Static sites with #contact
    // far below the fold burned 5+% CPU per frame on this scene's "is the
    // animation done? should we mount?" book-keeping. We still let the
    // gsap timeline tick through if it's actively playing (rare).
    if (!inSection && !this.isPlaying && !this.mounted && this.shakeT === 0) {
      return;
    }

    // Mount/unmount the visuals when entering/leaving the section.
    if (inSection) {
      this.mount();
    } else if (!this.isPlaying) {
      // Outside the section AND idle — unmount and reset for replay.
      this.unmount();
      if (this.hasPlayed && sp <= RESET_SP) {
        this.resetForReplay();
        this.hasPlayed = false;
      }
    }

    // Recompute the anchor if the camera aspect changed (resize). Cheap.
    if (this.camera.aspect !== this.cachedAspect) {
      this.recomputeAnchor();
      this.repositionAnchorMeshes();
    }

    // Camera coordination:
    //   The hole is now in the bottom-right corner of the natural camera view,
    //   so NO pitch override. We do still apply a brief shake on ball-impact —
    //   but only while the shake is decaying. That keeps us from fighting
    //   TrajectoryScene's damp-to-default writes outside of the shake window.
    //
    //   SceneManager iterates registration order, so ContactScene runs after
    //   TrajectoryScene in the same frame — our shake writes are the last word.
    if (inSection && this.shakeT > 0) {
      const phase = this.shakeT / 0.4;
      const shakeYaw = (Math.random() - 0.5) * 2 * this.shakeAmount * phase;
      const shakePitch = (Math.random() - 0.5) * 2 * this.shakeAmount * phase;
      this.camera.position.copy(DEFAULT_CAMERA_POS);
      this.camera.lookAt(
        CAMERA_DEFAULT_LOOKAT.x + shakeYaw,
        CAMERA_DEFAULT_LOOKAT.y + shakePitch,
        CAMERA_DEFAULT_LOOKAT.z
      );
      this.camera.updateMatrixWorld();
      this.shakeT = Math.max(0, this.shakeT - dt);
    }

    // Trigger logic.
    if (
      inSection &&
      sp > TRIGGER_SP &&
      !this.isPlaying &&
      this.armedForReplay
    ) {
      this.startAnimation(this.hasPlayed);
    }

    // Sync mesh from body.
    if (this.ballBody && this.ballMesh.visible) {
      const t = this.ballBody.translation();
      const r = this.ballBody.rotation();
      this.ballMesh.position.set(t.x, t.y, t.z);
      this.ballMesh.quaternion.set(r.x, r.y, r.z, r.w);
    }

    // Decay shake — handled inline above; also clear shakeAmount when t reaches 0.
    if (this.shakeT === 0) this.shakeAmount = 0;
  }

  dispose(scene: THREE.Scene): void {
    if (this.timeline) {
      this.timeline.kill();
      this.timeline = null;
    }
    if (this.liveObserver) {
      this.liveObserver.disconnect();
      this.liveObserver = null;
    }
    if (this.mounted) scene.remove(this.group);

    // Unwrap the LIVE span so the footer reverts to a single text node.
    const right = document.querySelector<HTMLElement>('.footnote span:nth-child(2)');
    if (right) {
      const liveSpan = right.querySelector('.contact-live');
      if (liveSpan) {
        right.textContent = right.textContent ?? '';
      }
    }

    if (this.styleTag && this.styleTag.parentElement) {
      this.styleTag.parentElement.removeChild(this.styleTag);
    }

    // 3D cleanup
    this.green.dispose();
    this.hole.dispose();
    // NOTE: ballMesh.geometry is the SHARED GLB cache (loadGolfBallGeometry).
    // HeroScene also references it — do NOT dispose here. Full teardown is
    // handled by `disposeSharedGolfBallAssets` at app dispose.
    this.ballMaterial.dispose();
    if (this.ballFillMaterial) this.ballFillMaterial.dispose();
    if (this.matcapTex) this.matcapTex.dispose();

    // Physics cleanup. Rapier wrapper owns the world; we don't need to
    // explicitly remove the body here in step-07 (consistent with other scenes
    // which leave bodies around through page lifetime). When App.dispose()
    // runs, physics.dispose() frees the entire world.
    void this.ballCollider;
    void this.greenCollider;
    void this.greenBody;
  }
}
