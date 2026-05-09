import * as THREE from 'three';
import { getUserPrefs } from '@core/UserPrefs';
import { gsap } from 'gsap';
import type { SceneModule } from '../SceneManager';
import type { ScrollManager } from '@core/ScrollManager';
import { elementToWorld, elementToWorldSize } from '@core/ScreenToWorld';
import { saturate } from '@utils/lerp';

import { AutomationFrame } from './AutomationFrame';
import { ProtocolsFrame } from './ProtocolsFrame';
import { AiResearchFrame } from './AiResearchFrame';
import { SaasFrame } from './SaasFrame';

/**
 * PursuitsScene — coordinator for the 4 mini-scenes that anchor next to the
 * `.glass-card[data-card="N"]` elements in the existing `flythrough` section.
 *
 * Architecture:
 *   - We own four sub-frames (AutomationFrame, ProtocolsFrame, AiResearchFrame,
 *     SaasFrame) all implementing PursuitsFrame.
 *   - Each frame manages its own meshes, materials, and morph uniforms.
 *   - PursuitsScene reads `scrollManager.sectionProgress("flythrough")` each
 *     frame, decides which frame is active (and which neighbour, if in a
 *     transition zone), and tweens uMorphProgress on each accordingly.
 *   - Only the active frame is mounted to THREE.Scene at a time; during a
 *     cross-fade transition both old + new are mounted; after a debounce
 *     window past the transition end the inactive frame is unmounted to
 *     reclaim GPU work.
 *
 * Interactions:
 *   - SaasFrame flips on hover: we run a per-frame DOM bounding-rect test
 *     against the cursor (cheaper than 3D raycasting for a UI element that's
 *     already DOM-anchored) and call `setHovered()` on the SaasFrame.
 *
 * Mobile: bail in update() (no mounts, no morphs). The existing CSS-driven
 * flythrough animation plays unaffected.
 */

export interface FrameUpdateContext {
  scrollProgress: number; // 0..1 within the flythrough section
  frameProgress: number; // 0..1 within the active frame's lane
  isActive: boolean;
}

export interface PursuitsFrame {
  readonly name: string;
  /** 0..3 — index of the .glass-card this frame anchors to. */
  readonly cardIndex: number;
  /** Build geometries/materials. Called once. Don't add to scene yet. */
  init(scene: THREE.Scene): void;
  /** Add the frame's group to the scene. Idempotent. */
  mount(scene: THREE.Scene): void;
  /** Remove from scene. Idempotent. Should NOT dispose GPU resources. */
  unmount(scene: THREE.Scene): void;
  /** Whether the frame is currently in the scene graph. */
  isMounted(): boolean;
  /** Drive entrance/exit. 0 = invisible, 1 = fully visible. */
  setMorphProgress(t: number): void;
  /** Per-frame tick. `time` is seconds since app start. */
  update(dt: number, ctx: FrameUpdateContext, time: number): void;
  /** Reposition + uniform-scale the frame's group. */
  setTransform(position: THREE.Vector3, scale: number): void;
  /** Free GPU resources. */
  dispose(scene: THREE.Scene): void;
}

const HEAD_DEPTH = 5; // same plane as Hero so screen→world maps cleanly

// Each frame occupies a 1/N slice of the section progress, with a small
// crossfade buffer on either side. Tuned so the morph reads as a wave (not a
// flash) given the playbook's 800–1200ms guidance.
const FRAME_COUNT = 4;
const CROSSFADE = 0.07; // half-width of the cross-fade buffer (in section units)

// Time after a transition ends before we unmount the inactive frame.
const UNMOUNT_DELAY_MS = 200;

function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.innerWidth < 768) return true;
  if (typeof window.matchMedia === 'function') {
    if (window.matchMedia('(pointer: coarse)').matches) return true;
  }
  return false;
}

export class PursuitsScene implements SceneModule {
  readonly name = 'pursuits';

  private readonly camera: THREE.PerspectiveCamera;
  private readonly scrollManager: ScrollManager;

  private scene!: THREE.Scene;
  private frames: PursuitsFrame[] = [];
  private cardEls: (HTMLElement | null)[] = [];
  private flythroughEl: HTMLElement | null = null;

  // Bookkeeping for mount/unmount delays.
  private lastActiveAt: number[] = [0, 0, 0, 0];
  private targetMorph: number[] = [0, 0, 0, 0];
  private currentMorph: number[] = [0, 0, 0, 0];

  // Time accumulator (passed to frames).
  private timeSec = 0;

  // Hover tracking.
  private cursorClient = { x: -1e6, y: -1e6 };
  private onMouseMove = (e: MouseEvent): void => {
    this.cursorClient.x = e.clientX;
    this.cursorClient.y = e.clientY;
  };

  // Cached world-position scratch.
  private tmpVec3 = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, scrollManager: ScrollManager) {
    this.camera = camera;
    this.scrollManager = scrollManager;
  }

  init(scene: THREE.Scene): void {
    this.scene = scene;
    this.frames = [
      new AutomationFrame(),
      new ProtocolsFrame(),
      new AiResearchFrame(),
      new SaasFrame(),
    ];
    for (const f of this.frames) f.init(scene);

    // Cache DOM lookups.
    this.flythroughEl = document.getElementById('flythrough');
    this.cardEls = [0, 1, 2, 3].map((i) =>
      document.querySelector<HTMLElement>(`.glass-card[data-card="${i}"]`)
    );

    if (!isMobileViewport()) {
      window.addEventListener('mousemove', this.onMouseMove, { passive: true });
    }
  }

  /**
   * Decide morph targets for each frame given current section progress.
   * Returns array of target morph values [0..1] per frame.
   */
  private computeMorphTargets(secProgress: number): number[] {
    const targets = [0, 0, 0, 0];
    const sliceSize = 1 / FRAME_COUNT;

    for (let i = 0; i < FRAME_COUNT; i++) {
      // Frame i is fully active in [i*sliceSize + CROSSFADE, (i+1)*sliceSize - CROSSFADE]
      // and crossfades on either side.
      const sliceStart = i * sliceSize;
      const sliceEnd = (i + 1) * sliceSize;
      // entrance: ramps 0→1 across [sliceStart - CROSSFADE, sliceStart + CROSSFADE]
      const entranceStart = sliceStart - CROSSFADE;
      const entranceEnd = sliceStart + CROSSFADE;
      // exit: ramps 1→0 across [sliceEnd - CROSSFADE, sliceEnd + CROSSFADE]
      const exitStart = sliceEnd - CROSSFADE;
      const exitEnd = sliceEnd + CROSSFADE;

      // First and last frames clamp to 1 outside the section so the section's
      // first/last visible state isn't blank.
      let v: number;
      if (i === 0 && secProgress <= entranceEnd) {
        v = 1; // ensure frame 0 is visible at top of section
      } else if (i === FRAME_COUNT - 1 && secProgress >= exitStart) {
        v = 1; // ensure frame 3 stays visible at bottom of section
      } else if (secProgress < entranceStart) {
        v = 0;
      } else if (secProgress < entranceEnd) {
        v = saturate((secProgress - entranceStart) / (entranceEnd - entranceStart));
      } else if (secProgress < exitStart) {
        v = 1;
      } else if (secProgress < exitEnd) {
        v = 1 - saturate((secProgress - exitStart) / (exitEnd - exitStart));
      } else {
        v = 0;
      }
      targets[i] = v;
    }
    return targets;
  }

  update(dt: number, _scrollProgress: number): void {
    this.timeSec += dt;

    // Mobile: bail. Existing CSS animation handles the section.
    if (isMobileViewport()) {
      // Make sure no frames are mounted (in case viewport size changed mid-session).
      for (const f of this.frames) {
        if (f.isMounted()) f.unmount(this.scene);
      }
      return;
    }

    if (!this.flythroughEl) return;

    // Section progress drives which frame is active.
    const secProgress = this.scrollManager.sectionProgress('flythrough');

    // 1. Compute morph targets per frame.
    const targets = this.computeMorphTargets(secProgress);
    const now = performance.now();

    const reducedMotion = getUserPrefs().reducedMotion;
    for (let i = 0; i < FRAME_COUNT; i++) {
      this.targetMorph[i] = targets[i];
      if (reducedMotion) {
        // Snap directly — no morph wave.
        this.currentMorph[i] = this.targetMorph[i];
      } else {
        // Frame-rate-independent damp toward target. Lambda ~5 → ~200ms
        // convergence which combines with our crossfade window (~scroll 0.14
        // wide ≈ many frames) to feel like an 800–1000ms wave when scrolling.
        const dampFactor = 1 - Math.exp(-5 * dt);
        this.currentMorph[i] += (this.targetMorph[i] - this.currentMorph[i]) * dampFactor;
        if (Math.abs(this.currentMorph[i] - this.targetMorph[i]) < 0.001) {
          this.currentMorph[i] = this.targetMorph[i];
        }
      }

      const morph = this.currentMorph[i];
      const frame = this.frames[i];

      // Mount / unmount based on whether this frame contributes to the visual.
      if (morph > 0.01) {
        if (!frame.isMounted()) frame.mount(this.scene);
        this.lastActiveAt[i] = now;
      } else if (frame.isMounted()) {
        // Wait for the unmount delay to pass before tearing down.
        if (now - this.lastActiveAt[i] > UNMOUNT_DELAY_MS) {
          frame.unmount(this.scene);
        }
      }

      frame.setMorphProgress(morph);
    }

    // 2. Position each mounted frame to its anchor card.
    for (let i = 0; i < FRAME_COUNT; i++) {
      const frame = this.frames[i];
      if (!frame.isMounted()) continue;

      const cardEl = this.cardEls[i];
      if (!cardEl) continue;
      // Re-resolve anchor each frame so resize / scroll layout shifts work.
      elementToWorld(cardEl, this.camera, HEAD_DEPTH, this.tmpVec3);

      // Offset the 3D content to the right of the card so it doesn't sit on top
      // of the card text. Use elementToWorldSize for a layout-aware offset.
      const cardSize = elementToWorldSize(cardEl, this.camera, HEAD_DEPTH);
      this.tmpVec3.x += cardSize.width * 0.85;
      // Slight downward bias so visual center sits with the card body (not the title).
      this.tmpVec3.y -= cardSize.height * 0.05;

      // Scale: roughly proportional to card height so the 3D content feels
      // attached to the card across viewport sizes.
      const scale = Math.max(0.5, Math.min(1.5, cardSize.height / 0.4));

      frame.setTransform(this.tmpVec3, scale);

      const ctx: FrameUpdateContext = {
        scrollProgress: secProgress,
        frameProgress: saturate((secProgress - i / FRAME_COUNT) * FRAME_COUNT),
        isActive: this.targetMorph[i] > 0.5,
      };
      frame.update(dt, ctx, this.timeSec);
    }

    // 3. SaasFrame hover handling: cursor-inside-card-rect test.
    const saas = this.frames[3] as SaasFrame;
    const saasCard = this.cardEls[3];
    if (saasCard && saas.isMounted()) {
      const r = saasCard.getBoundingClientRect();
      // Expand the test rect to include the rendered 3D card area on the right
      // (we render at +85% card width offset, so widen the right edge).
      const padded = {
        left: r.left,
        right: r.right + r.width * 1.0,
        top: r.top - r.height * 0.2,
        bottom: r.bottom + r.height * 0.2,
      };
      const inside =
        this.cursorClient.x >= padded.left &&
        this.cursorClient.x <= padded.right &&
        this.cursorClient.y >= padded.top &&
        this.cursorClient.y <= padded.bottom;
      saas.setHovered(inside);
    }
  }

  dispose(scene: THREE.Scene): void {
    window.removeEventListener('mousemove', this.onMouseMove);
    for (const f of this.frames) f.dispose(scene);
    this.frames = [];
    // gsap kills its own tweens on next tick; if we want a clean break:
    gsap.killTweensOf(this); // safe no-op
  }
}
