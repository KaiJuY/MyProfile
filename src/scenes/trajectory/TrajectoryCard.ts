import * as THREE from 'three';
import type { Milestone } from './PathBuilder';
import { saturate } from '@utils/lerp';

/**
 * TrajectoryCard — single floating HTML card pinned to the currently-active
 * milestone marker.
 *
 * Why HTML and not WebGL text?
 *   - Crisp at any DPR with no MSDF/SDF font rendering pipeline (we removed
 *     troika in wave 4).
 *   - Site CSS variables (--bg, --ink, --accent, --line) compose for free —
 *     the card automatically follows the user's "Tweak" / theme settings.
 *   - Trivial to swap text content per active milestone (innerHTML assignment).
 *
 * Source-of-truth for content: the existing `<div class="tl-item">` blocks in
 * index.html. We CLONE the year + h4 + .tl-org + p + .tl-tags out of the
 * current-language DOM (i18n already swapped them) — never hardcode copy.
 *
 * Position: each frame we project the active marker's world position to NDC
 * via the shared camera and convert to viewport pixels, then offset the card
 * to sit to the right of the ring (or to the left if the ring is on the right
 * half of the screen — keeps the card visible).
 *
 * Transition: when the active milestone index changes we cross-fade. The
 * outgoing copy fades 1→0 + scale(1 → 0.92) over 480ms; the incoming copy
 * fades 0→1 + scale(1.06 → 1.0) starting 80ms in. Plain CSS transitions; no
 * GSAP — keeping the dep surface as small as possible.
 *
 * reduced-motion: snap-update only, no transitions, no per-frame opacity work.
 *
 * Mobile: Trajectory card is desktop-only. Constructor returns a no-op shell
 * if `enabled === false`; TrajectoryScene gates that off `isMobile`.
 */

// Issue #2 (focus-pull cross-fade): outgoing card recedes (-Z + scale + blur);
// incoming card appears clear and sharp. Slightly slower than before so the
// "rack focus" feel registers.
const FADE_OUT_MS = 600;
const FADE_IN_MS = 520;
const FADE_IN_DELAY_MS = 120;

// Distance in pixels between the projected marker position and the card edge.
// Card sits ALWAYS to the right of the ring (Issue #2 — user wants it pinned
// right, not auto-flipping). Wider offset accommodates the larger card.
// Bumped 120 → 144 (×1.2) per follow-up feedback: card needed slightly more
// breathing room from the ring. Right-edge clamp below still keeps the card
// fully visible on narrow viewports.
const HORIZONTAL_OFFSET_PX = 144;
const VERTICAL_OFFSET_PX = 0;

interface CardContent {
  year: string;
  title: string;
  org: string;
  paragraph: string;
  tagsHTML: string;
}

export class TrajectoryCard {
  private root!: HTMLDivElement;
  private layer!: HTMLDivElement; // holds front + back copies for cross-fade
  private frontEl!: HTMLDivElement; // currently-visible card content
  private backEl!: HTMLDivElement;  // previous content during transition
  private milestones: Milestone[];
  private timelineItems: HTMLElement[];
  private camera: THREE.PerspectiveCamera;
  private contents: CardContent[] = [];

  /** Last active milestone index applied to the card. -1 = none yet. */
  private currentIndex = -1;
  /** Smoothed target opacity for the whole card (entry/exit envelope). */
  private currentOpacity = 0;
  /** Cached viewport dims — refreshed each frame from the renderer. */
  private vw = 0;
  private vh = 0;

  // Reusable scratch.
  private tmpProj = new THREE.Vector3();

  private enabled: boolean;
  private reducedMotion: boolean;

  constructor(opts: {
    milestones: Milestone[];
    timelineItems: HTMLElement[];
    camera: THREE.PerspectiveCamera;
    enabled: boolean;
    reducedMotion: boolean;
  }) {
    this.milestones = opts.milestones;
    this.timelineItems = opts.timelineItems;
    this.camera = opts.camera;
    this.enabled = opts.enabled;
    this.reducedMotion = opts.reducedMotion;

    if (!this.enabled) return;

    this.buildDOM();
    this.refreshContents();
  }

  private buildDOM(): void {
    const root = document.createElement('div');
    root.className = 'trajectory-card';
    // Inline positioning + base styles so the card works even if the project
    // CSS file fails to load. Visual styling (palette, padding, typography)
    // lives in src/style.css for tweakability.
    Object.assign(root.style, {
      position: 'fixed',
      top: '0px',
      left: '0px',
      // Will be driven by transform per-frame.
      transform: 'translate3d(-9999px,-9999px,0)',
      willChange: 'transform, opacity',
      pointerEvents: 'none',
      opacity: '0',
      zIndex: '40', // above canvas (z=2), below nav (z=50)
      transition: 'opacity 0.35s ease-out',
    });

    // The transition layer wraps two stacked copies (front + back). When
    // currentIndex changes, we copy front → back, write new content into front,
    // and run the cross-fade animation.
    //
    // Width bumped 320 → 420 (Issue #2: "可以把整個Card做大一點"). The CSS
    // `.trajectory-card` rules in src/style.css carry the matching padding
    // and font-size adjustments.
    const layer = document.createElement('div');
    layer.className = 'trajectory-card-layer';
    Object.assign(layer.style, {
      position: 'relative',
      width: '420px',
    });

    const front = this.makeFace();
    const back = this.makeFace();
    front.style.position = 'relative';
    back.style.position = 'absolute';
    back.style.top = '0';
    back.style.left = '0';
    back.style.width = '100%';
    back.style.opacity = '0';
    back.style.pointerEvents = 'none';

    layer.appendChild(back);
    layer.appendChild(front);
    root.appendChild(layer);
    document.body.appendChild(root);

    this.root = root;
    this.layer = layer;
    this.frontEl = front;
    this.backEl = back;
  }

  private makeFace(): HTMLDivElement {
    const face = document.createElement('div');
    face.className = 'trajectory-card-face';
    // Inner skeleton — populated/replaced by setFrontContent.
    face.innerHTML = `
      <div class="trajectory-card-year"></div>
      <h4 class="trajectory-card-title"></h4>
      <div class="trajectory-card-org"></div>
      <p class="trajectory-card-text"></p>
      <div class="trajectory-card-tags"></div>
    `;
    return face;
  }

  /**
   * Read content from the existing .tl-item DOM nodes. Called once at
   * construction and again whenever the i18n language flips (the consumer
   * can call refreshContents()).
   *
   * Items are oldest-first (already reversed by TrajectoryScene), matching
   * milestone index 0..N-1.
   */
  refreshContents(): void {
    if (!this.enabled) return;
    const out: CardContent[] = [];
    for (const el of this.timelineItems) {
      const year = el.querySelector<HTMLElement>('.tl-year')?.textContent ?? '';
      const title = el.querySelector<HTMLElement>('h4')?.textContent ?? '';
      const org = el.querySelector<HTMLElement>('.tl-org')?.textContent ?? '';
      const paragraph = el.querySelector<HTMLElement>('p')?.textContent ?? '';
      const tagsHTML = el.querySelector<HTMLElement>('.tl-tags')?.innerHTML ?? '';
      out.push({ year, title, org, paragraph, tagsHTML });
    }
    this.contents = out;
    // If a card is currently shown, re-write it so the language flip is visible
    // immediately rather than waiting for the next milestone change.
    if (this.currentIndex >= 0) {
      this.writeFace(this.frontEl, this.contents[this.currentIndex]);
    }
  }

  private writeFace(face: HTMLDivElement, content: CardContent | undefined): void {
    if (!content) return;
    const yearEl = face.querySelector<HTMLElement>('.trajectory-card-year');
    const titleEl = face.querySelector<HTMLElement>('.trajectory-card-title');
    const orgEl = face.querySelector<HTMLElement>('.trajectory-card-org');
    const textEl = face.querySelector<HTMLElement>('.trajectory-card-text');
    const tagsEl = face.querySelector<HTMLElement>('.trajectory-card-tags');
    if (yearEl) yearEl.textContent = content.year;
    if (titleEl) titleEl.textContent = content.title;
    if (orgEl) orgEl.textContent = content.org;
    if (textEl) textEl.textContent = content.paragraph;
    if (tagsEl) tagsEl.innerHTML = content.tagsHTML;
  }

  /**
   * Per-frame update.
   * @param activeIndex which milestone (0..N-1) is currently active. -1 = none.
   * @param sectionProgress raw scroll progress through #career, used for the
   *                        soft-fade envelope at the entry/exit bands.
   */
  update(activeIndex: number, sectionProgress: number): void {
    if (!this.enabled) return;

    // Visibility envelope — issue #3 fix. Previously [0.02, 0.97]: the card
    // was visible while the user still saw 90% of the Bag section above
    // because career section is 220vh tall; sectionProgress is non-zero from
    // the moment the section's top crosses the viewport bottom. Move start
    // band to ~0.32 so the card only fades in once career FILLS the viewport.
    let targetOpacity = 0;
    if (sectionProgress >= 0.32 && sectionProgress <= 0.97 && activeIndex >= 0) {
      // Slightly wider entry fade (0.06 vs 0.04) so the appearance feels
      // intentional rather than abrupt.
      const fadeIn = saturate((sectionProgress - 0.32) / 0.06);
      const fadeOut = saturate((0.97 - sectionProgress) / 0.04);
      targetOpacity = Math.min(fadeIn, fadeOut);
    }
    if (Math.abs(targetOpacity - this.currentOpacity) > 0.005) {
      this.currentOpacity = targetOpacity;
      this.root.style.opacity = `${targetOpacity}`;
    }
    if (targetOpacity <= 0.001) {
      // Hide off-screen so we don't trigger any layout work and screen readers
      // skip the card entirely while we're outside the section.
      if (this.root.style.display !== 'none') {
        this.root.style.display = 'none';
      }
      return;
    } else {
      if (this.root.style.display === 'none') {
        this.root.style.display = '';
      }
    }

    // Swap content if active milestone changed.
    if (activeIndex !== this.currentIndex) {
      this.transitionTo(activeIndex);
      this.currentIndex = activeIndex;
    }

    // Project the active marker's world position to screen pixels and apply
    // a transform. Lenis + canvas DPR don't affect DOM `position: fixed`
    // coordinates — they're already in CSS pixels relative to the viewport.
    if (activeIndex < 0 || activeIndex >= this.milestones.length) return;
    const m = this.milestones[activeIndex];
    this.tmpProj.copy(m.position).project(this.camera);
    this.vw = window.innerWidth;
    this.vh = window.innerHeight;
    const sx = (this.tmpProj.x * 0.5 + 0.5) * this.vw;
    const sy = (-this.tmpProj.y * 0.5 + 0.5) * this.vh;

    // Issue #2: always pin to the RIGHT of the ring (no auto-flip). The
    // viewport-edge clamp below still keeps the card visible if the projected
    // marker drifts to the right side of the screen.
    const cardWidth = this.layer.offsetWidth || 420;
    const cx = sx + HORIZONTAL_OFFSET_PX;
    // Vertical anchor: center of card aligned to marker (slightly biased up
    // because the marker has a tick line going UP — the card looks balanced
    // when its visual center sits a touch above the ring's center).
    const cardHeight = this.layer.offsetHeight || 280;
    const cy = sy - cardHeight * 0.5 + VERTICAL_OFFSET_PX;

    // Keep the card on-screen even if the marker briefly goes off-screen during
    // entry/exit transitions. Clamp the resulting top-left within a small
    // margin of the viewport.
    const margin = 16;
    const clx = Math.max(margin, Math.min(this.vw - cardWidth - margin, cx));
    const cly = Math.max(margin + 80 /* nav */, Math.min(this.vh - cardHeight - margin, cy));

    this.root.style.transform = `translate3d(${Math.round(clx)}px, ${Math.round(cly)}px, 0)`;
  }

  /**
   * Cross-fade animation with focus-pull (Issue #2). Outgoing card recedes
   * (translate-Z back, scale 0.92, blur 8px, fade to 0) while incoming card
   * comes from a slight foreground (scale 1.06, no blur) to neutral (scale 1.0,
   * sharp). The CSS `filter: blur(...)` handles the optical focus-shift for
   * free — no postprocess pass needed.
   * Reduced-motion: snap to new content with no transition at all.
   */
  private transitionTo(newIndex: number): void {
    if (this.reducedMotion || this.currentIndex < 0) {
      // First-paint or reduced-motion: just write the new content with no
      // outgoing copy.
      this.writeFace(this.frontEl, this.contents[newIndex]);
      this.frontEl.style.transition = 'none';
      this.frontEl.style.opacity = '1';
      this.frontEl.style.transform = 'translate3d(0,0,0) scale(1)';
      this.frontEl.style.filter = 'blur(0)';
      this.backEl.style.opacity = '0';
      this.backEl.style.filter = 'blur(0)';
      return;
    }

    // Copy front → back (so back holds the previous milestone), snap back to
    // fully visible + sharp, then animate it RECEDING (back+blur+fade).
    // Meanwhile prep front with the new content, slightly forward + invisible,
    // then animate it INTO focus.
    this.backEl.innerHTML = this.frontEl.innerHTML;
    this.backEl.style.transition = 'none';
    this.backEl.style.opacity = '1';
    this.backEl.style.transform = 'translate3d(0,0,0) scale(1)';
    this.backEl.style.filter = 'blur(0)';

    this.writeFace(this.frontEl, this.contents[newIndex]);
    this.frontEl.style.transition = 'none';
    this.frontEl.style.opacity = '0';
    // Foreground origin: closer to camera + slightly scaled up + soft blur
    // (out-of-focus close subject), then "rack focus" pulls it into clarity.
    this.frontEl.style.transform = 'translate3d(0, 0, 30px) scale(1.06)';
    this.frontEl.style.filter = 'blur(6px)';

    // Force reflow so the upcoming transitions actually run from the
    // just-set starting values.
    void this.frontEl.offsetWidth;

    // Outgoing card: recede + blur + fade. The combined effect reads as
    // "shifting depth-of-field" rather than a flat opacity tween.
    this.backEl.style.transition =
      `opacity ${FADE_OUT_MS}ms ease-out, transform ${FADE_OUT_MS}ms ease-out, filter ${FADE_OUT_MS}ms ease-out`;
    this.backEl.style.opacity = '0';
    this.backEl.style.transform = 'translate3d(0, 0, -50px) scale(0.92)';
    this.backEl.style.filter = 'blur(8px)';

    // Slight delay so the incoming card crests as the outgoing one is mostly
    // gone — only ONE card is the visual focus at any given moment (Issue #2).
    window.setTimeout(() => {
      this.frontEl.style.transition =
        `opacity ${FADE_IN_MS}ms ease-out, transform ${FADE_IN_MS}ms ease-out, filter ${FADE_IN_MS}ms ease-out`;
      this.frontEl.style.opacity = '1';
      this.frontEl.style.transform = 'translate3d(0, 0, 0) scale(1)';
      this.frontEl.style.filter = 'blur(0)';
    }, FADE_IN_DELAY_MS);
  }

  dispose(): void {
    if (!this.enabled) return;
    if (this.root.parentElement) {
      this.root.parentElement.removeChild(this.root);
    }
  }
}
