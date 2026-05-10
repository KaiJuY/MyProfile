import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { gsap } from 'gsap';

import type { SceneModule } from '../SceneManager';
import type { ScrollManager } from '@core/ScrollManager';
import type { PhysicsWorld } from '@physics/PhysicsWorld';
import { damp } from '@utils/lerp';
import { getUserPrefs } from '@core/UserPrefs';

import { buildGolfBallMeshFromGLB } from '../shared/golfBall';
import { Hole } from './Hole';
import { GreenSurface } from './GreenSurface';

/**
 * ContactScene — finale animation. A golf ball drops into the cup; the contact
 * info + footer fade in once the ball is gone.
 *
 * Design (per playbook 07 §3 + footer notes):
 *   - Hybrid physics + GSAP. First ~1.5s use Rapier (real rolling), then
 *     ~0.7s use GSAP scripted (so the ball can't get stuck on the rim).
 *   - Ball arrives from upper-side (positive x, positive y) with directional
 *     motion — feels deliberate, not "dropped from camera".
 *   - On mobile, skip the roll and Rapier physics entirely: kinematic Y tween
 *     from above-hole straight into the cup.
 *
 * Camera coordination with TrajectoryScene (CRITICAL):
 *   TrajectoryScene damps the camera back to (0,0,5) lookAt origin when the
 *   user leaves #career. By the time #contact is in view (sectionProgress > 0)
 *   that handoff is already done. ContactScene then tilts the camera DOWN by
 *   ~10° to give a "putting view" angle for the drop animation. We damp the
 *   tilt with sectionProgress so the user gets a smooth pitch transition as
 *   they scroll into Contact, and back up if they scroll away.
 *
 * Stencil: NONE — full-viewport finale.
 *
 * Pointer-events: this scene adds NO DOM that intercepts clicks. It only
 *   - reads contact/footer DOM nodes to set initial opacity:0
 *   - tweens those nodes' opacity/transform via GSAP
 *   - injects a single <style> tag with the LIVE-pulse keyframe
 *   No pointer-events:auto introduced; mailto/tel/github stay clickable.
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

// Camera tilt (radians). 10° down at full sectionProgress.
const CAMERA_PITCH_MAX = -(10 * Math.PI) / 180;
const CAMERA_PITCH_LAMBDA = 4;
const DEFAULT_CAMERA_POS = new THREE.Vector3(0, 0, 5);

// World coords (matches Hole defaults).
const HOLE_CENTER = new THREE.Vector3(0, -2, 0);

// Ball geometry
const BALL_RADIUS = 0.18; // visually smaller than the rim (rim radius 0.55)

// Drop entry point (above-and-to-side).
const BALL_START = new THREE.Vector3(2.0, 2.4, 0.6);
// Where the ball lands on the green BEFORE rolling.
const BALL_LAND = new THREE.Vector3(0.9, -2 + BALL_RADIUS, 0.4);
// Where the ball is when it teeters on the rim.
const BALL_TEETER = new THREE.Vector3(0.45, -2 + BALL_RADIUS, 0.0);
// Resting depth in cup (we fade at the same time so this just needs to be below).
const BALL_DROP_DEPTH = -2.7;

const isMobile =
  typeof window !== 'undefined' &&
  (window.innerWidth < 768 ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches));

interface FadeTarget {
  el: HTMLElement;
  /** index in stagger order (0 = first to appear). */
  order: number;
}

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

  // Smoothed camera pitch
  private currentPitch = 0;

  // DOM fade targets (contact + footer)
  private fadeTargets: FadeTarget[] = [];
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

    // ------- Visuals (3D) -------
    this.group = new THREE.Group();
    this.green = new GreenSurface({
      y: HOLE_CENTER.y,
      width: 9,
      depth: 7,
    });
    this.group.add(this.green.mesh);

    this.hole = new Hole({
      centerX: HOLE_CENTER.x,
      centerZ: HOLE_CENTER.z,
      surfaceY: HOLE_CENTER.y,
      rimRadius: 0.55,
      tubeRadius: 0.025,
    });
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
      rimStrength: 0.35,
      rimColor: new THREE.Color(0x9ec3d6),
      dimpleStrength: 0.55,
      opacity: 1.0,
      transparent: true, // we fade the ball after drop
    });
    this.ballMesh = built.mesh;
    this.ballMaterial = built.material;
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
      const greenColDesc = RAPIER.ColliderDesc.cuboid(6, 0.05, 4)
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

    // ------- DOM fade targets -------
    this.collectFadeTargets();
    this.injectStyles();

    // Don't mount yet — only mount when entering the section to save draw calls
    // for users who never reach the contact section.

    // Initialize smoothed pitch from current camera quaternion. We can't read
    // a clean pitch off a quaternion robustly mid-flight (TrajectoryScene may
    // be writing to it on prior frames), so just start at 0 — the damper will
    // converge by frame ~30 anyway.
    this.currentPitch = 0;
  }

  /** Register fade-in DOM targets and pre-set them invisible. */
  private collectFadeTargets(): void {
    const targets: FadeTarget[] = [];

    // Inner left column (h2 + p)
    const left = document.querySelector<HTMLElement>('#contact .contact > div:not(.contact-side)');
    if (left) targets.push({ el: left, order: 0 });

    // Right column links — stagger 1, 2, 3
    const links = document.querySelectorAll<HTMLAnchorElement>('#contact .contact-side a');
    links.forEach((a, i) => {
      // CRITICAL: no pointer-events:none. Just opacity + transform.
      targets.push({ el: a, order: 1 + i });
    });

    // Footer spans
    const footerSpans = document.querySelectorAll<HTMLElement>('.footnote span');
    footerSpans.forEach((s, i) => {
      targets.push({ el: s, order: 4 + i });
    });

    for (const t of targets) {
      t.el.style.opacity = '0';
      t.el.style.transform = 'translateY(20px)';
      t.el.style.willChange = 'opacity, transform';
      // No pointer-events change — keep links clickable as soon as opacity fades in.
    }

    this.fadeTargets = targets;

    // Mark the LIVE word inside the right footer span.
    // Existing markup is "VER 9.4.0 · TRACKED · LIVE" (single text node).
    // We wrap "LIVE" in its own span so we can attach a CSS animation.
    this.wrapLiveWord();

    // Step 08: lang-toggle robustness. The site's `applyLang(lang)` does
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
  /* Pulse only kicks in once the parent span is visible (handled by parent
   * opacity 0 → 1 fade); this rule is harmless before then. */
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
   * Reduced-motion: zero-duration timeline that just snaps fade targets to 1
   * and triggers `onAnimationComplete`. No ball drop, no shake.
   */
  private buildReducedMotionTimeline(): gsap.core.Timeline {
    const tl = gsap.timeline({
      onComplete: () => this.onAnimationComplete(),
    });
    for (const t of this.fadeTargets) {
      t.el.style.opacity = '1';
      t.el.style.transform = 'translateY(0)';
    }
    // Tiny duration so the onComplete fires next tick.
    tl.to({}, { duration: 0.01 });
    return tl;
  }

  /** Mobile: simplified — kinematic Y from above-hole straight to in-cup over total*0.6s. */
  private buildMobileTimeline(total: number): gsap.core.Timeline {
    const tl = gsap.timeline({
      onComplete: () => this.onAnimationComplete(),
    });

    // Place the ball directly above the hole.
    this.ballMesh.position.set(HOLE_CENTER.x, 1.6, HOLE_CENTER.z);

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
    }, `-=${total * 0.20}`);

    // Footer fade-in begins after ball is gone.
    this.scheduleFadeIn(tl, total * 0.85);

    // No camera shake on mobile.
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
      },
    }, phaseTeeterEnd + (phaseDropEnd - phaseTeeterEnd) * 0.30);

    // Camera shake — start at phaseDropEnd, lasts 0.4s
    tl.add(() => {
      this.shakeT = 0.4;
      this.shakeAmount = 0.005; // radians
    }, phaseDropEnd);

    // Footer fade-in begins right at phaseDropEnd.
    this.scheduleFadeIn(tl, phaseDropEnd);

    return tl;
  }

  /** Stagger fade-in of contact + footer DOM. */
  private scheduleFadeIn(tl: gsap.core.Timeline, startAt: number): void {
    const STAGGER = 0.10;
    for (const t of this.fadeTargets) {
      tl.to(t.el, {
        opacity: 1,
        y: 0,
        duration: 0.4,
        ease: 'power2.out',
        onUpdate: () => {
          // gsap can't directly tween a transform string we set inline; use
          // explicit style update.
          t.el.style.transform = `translateY(${(1 - (gsap.getProperty(t.el, 'opacity') as number)) * 20}px)`;
        },
      }, startAt + t.order * STAGGER);
    }
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

  /** Reset state so the next entry replays the animation. */
  private resetForReplay(): void {
    if (this.timeline) {
      this.timeline.kill();
      this.timeline = null;
    }
    this.isPlaying = false;
    this.armedForReplay = true;
    this.ballMaterial.uniforms.uOpacity.value = 1.0;
    this.ballMesh.visible = false;
    this.hole.setGlow(0);

    // Reset DOM fades back to invisible so the replay re-staggers them.
    for (const t of this.fadeTargets) {
      t.el.style.opacity = '0';
      t.el.style.transform = 'translateY(20px)';
    }

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
    if (!inSection && !this.isPlaying && !this.mounted && this.currentPitch === 0) {
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

    // Camera coordination:
    //   We want to add a downward pitch as the user enters Contact, BUT only if
    //   TrajectoryScene isn't currently writing to the camera (it only does so
    //   while inside #career). Practically, by the time sectionProgress(contact)
    //   > 0, the user has scrolled past #career, so trajectory is in its
    //   damp-back-to-default branch and writing (0,0,5)+lookAt(0,0,0) every
    //   frame. We then OVERRIDE the camera AFTER trajectory by writing on the
    //   NEXT frame.
    //
    //   Because SceneManager iterates registration order, ContactScene runs
    //   AFTER TrajectoryScene in the same frame — so our writes are the last
    //   word and they win.
    if (inSection) {
      const reducedMotion = getUserPrefs().reducedMotion;
      const targetPitch = reducedMotion ? 0 : CAMERA_PITCH_MAX * Math.min(sp / 0.4, 1);
      this.currentPitch = reducedMotion
        ? 0
        : damp(this.currentPitch, targetPitch, CAMERA_PITCH_LAMBDA, dt);

      // Apply over the trajectory's reset write. We assume trajectory has just
      // written (0,0,5)+lookAt(0,0,0). We re-aim at a point below origin to
      // give the "putting view" pitch.
      this.camera.position.copy(DEFAULT_CAMERA_POS);
      // Compute a lookAt that produces our desired pitch:
      //   yaw=0, pitch=currentPitch (negative = look down)
      //   forward = (0, sin(pitch), -cos(pitch))
      const fx = 0;
      const fy = Math.sin(this.currentPitch);
      const fz = -Math.cos(this.currentPitch);
      // Camera shake — small Y rotation jitter, dampened over shakeT.
      let shakeYaw = 0;
      let shakePitch = 0;
      if (this.shakeT > 0) {
        const phase = this.shakeT / 0.4; // 1 → 0 over 0.4s (we decrement below)
        shakeYaw = (Math.random() - 0.5) * 2 * this.shakeAmount * phase;
        shakePitch = (Math.random() - 0.5) * 2 * this.shakeAmount * phase;
        this.shakeT = Math.max(0, this.shakeT - dt);
      }
      const lookAt = new THREE.Vector3(
        DEFAULT_CAMERA_POS.x + fx + shakeYaw,
        DEFAULT_CAMERA_POS.y + fy + shakePitch,
        DEFAULT_CAMERA_POS.z + fz
      );
      this.camera.lookAt(lookAt);
      this.camera.updateMatrixWorld();
    } else {
      // Damp pitch back to 0 — but DON'T touch camera unless we already had
      // a non-zero pitch (otherwise we'd fight TrajectoryScene). Simple guard:
      // only override if pitch is appreciably non-zero.
      this.currentPitch = damp(this.currentPitch, 0, CAMERA_PITCH_LAMBDA, dt);
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

    // Restore DOM
    for (const t of this.fadeTargets) {
      t.el.style.opacity = '';
      t.el.style.transform = '';
      t.el.style.willChange = '';
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
