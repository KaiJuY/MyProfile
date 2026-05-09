import * as THREE from 'three';

/**
 * LeaderLine — a thin dashed SVG `<path>` overlay that connects the right edge
 * of an HTML project card to its 3D companion's projected screen position.
 *
 * Why an SVG overlay and not a 3D line:
 *  - The HTML card's right edge is in DOM space; the 3D anchor is a world-space
 *    point that we project to screen coords each frame. Both ends live in the
 *    same coordinate system (pixels) only at the screen-space level — using a
 *    full-window SVG with `viewBox="0 0 vw vh"` makes the math one-step.
 *  - 1px dashed strokes look crisp in SVG; in 3D you'd need a screen-space line
 *    shader to avoid 1.0001px hairline thickness drift.
 *
 * Why update via RAF and not the `scroll` event (playbook footer warning):
 *  - Lenis transforms the page during smooth scroll, so element bounding-rects
 *    move in *every* RAF tick — we must read them on the same RAF that paints,
 *    or the line lags by 1 frame and visibly jitters.
 *  - The WorkScene calls `update()` on this manager once per frame from inside
 *    its own RAF (driven by App's main loop), so we're already in lockstep.
 *
 * Animation:
 *  - When a leader is first registered AND its card is in viewport, we run a
 *    one-shot `stroke-dashoffset: full → 0` transition (CSS-driven, 700ms).
 *    Each subsequent re-entry replays the draw-in.
 *  - Once drawn, the dashoffset stays at 0 and the dasharray pattern (2,4)
 *    just renders as a stable dotted line.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Animation length (px). Larger than any plausible curve length so the path
 *  draws fully regardless of viewport. */
const DRAW_LENGTH = 800;
/** Re-trigger threshold: how far must the card scroll OUT of viewport before
 *  re-entry triggers a fresh draw-in animation? */
const REPLAY_HYSTERESIS = 100;

interface LeaderEntry {
  /** SVG <path> element (one per leader, lives inside the shared SVG). */
  path: SVGPathElement;
  /** HTML element whose right-edge midpoint is the source. */
  htmlEl: HTMLElement;
  /** Function that returns world-space 3D anchor (the implementation injects
   *  this so it can do per-frame logic). */
  getWorldAnchor: (out: THREE.Vector3) => THREE.Vector3;
  /** Last-known card-in-viewport state, for replay-on-reentry detection. */
  wasInViewport: boolean;
  /** True once we've fired the initial draw-in animation. */
  hasDrawnIn: boolean;
}

export class LeaderLineManager {
  private svg: SVGSVGElement;
  private camera: THREE.PerspectiveCamera;
  private leaders: Map<string, LeaderEntry> = new Map();
  private accentColor: string;
  // Reusable scratch — one allocation total, mutated each frame.
  private worldScratch = new THREE.Vector3();
  private projectScratch = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;

    // Read the brand accent so leader hover state can echo it later. For now
    // we render leaders in a low-contrast gray (matches "industrial schematic"
    // look — playbook §4) but caching the accent makes future hover trivial.
    this.accentColor = (
      getComputedStyle(document.documentElement)
        .getPropertyValue('--accent')
        .trim() || '#FF6A00'
    );

    // Single SVG covers the full viewport. pointer-events:none so it never
    // blocks card hover/click. position:fixed so scroll doesn't move it
    // (we redraw paths with absolute pixel coords each frame).
    this.svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    this.svg.setAttribute('class', 'work-leader-svg');
    this.svg.setAttribute('aria-hidden', 'true');
    Object.assign(this.svg.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      pointerEvents: 'none',
      // z=2 so it sits above the canvas (z=1) but under nav (z=50). #content
      // is z=1 too but later in DOM — DOM-order beats equal z-index, so we
      // need z >= 2 to clear #content's text.
      zIndex: '2',
      // Subtle mix-blend so the dashed line feels embossed rather than painted
      // over the dark gradient.
      mixBlendMode: 'screen',
      opacity: '0.85',
    });
    this.updateViewBox();
    document.body.appendChild(this.svg);

    // Resize listener — viewBox must follow viewport so px coords map 1:1.
    window.addEventListener('resize', this.handleResize);
  }

  private handleResize = (): void => {
    this.updateViewBox();
  };

  private updateViewBox(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.svg.setAttribute('width', String(w));
    this.svg.setAttribute('height', String(h));
  }

  /** Register a leader for a project. Idempotent on key. */
  register(
    key: string,
    htmlEl: HTMLElement,
    getWorldAnchor: (out: THREE.Vector3) => THREE.Vector3
  ): void {
    if (this.leaders.has(key)) return;
    const path = document.createElementNS(SVG_NS, 'path') as SVGPathElement;
    path.setAttribute('fill', 'none');
    // 1px hairline. Even at DPR=2 SVG renders this crisply.
    path.setAttribute('stroke', 'rgba(180,190,200,0.7)');
    path.setAttribute('stroke-width', '1');
    path.setAttribute('stroke-dasharray', '2,4');
    path.setAttribute('stroke-linecap', 'round');
    // Begin "undrawn" — we'll animate to 0 when card enters viewport.
    path.setAttribute('stroke-dashoffset', String(DRAW_LENGTH));
    path.style.transition = 'none';
    // We cheat: we override stroke-dasharray during the draw-in (using the
    // animation-friendly "drawLen, drawLen" trick), then restore "2,4" once
    // drawn. This way the dashoffset animation looks like a continuous reveal
    // before falling back to the dotted hairline.
    this.svg.appendChild(path);

    this.leaders.set(key, {
      path,
      htmlEl,
      getWorldAnchor,
      wasInViewport: false,
      hasDrawnIn: false,
    });
  }

  /** Unregister and remove the path. */
  unregister(key: string): void {
    const e = this.leaders.get(key);
    if (!e) return;
    if (e.path.parentNode) e.path.parentNode.removeChild(e.path);
    this.leaders.delete(key);
  }

  /**
   * Pause/resume an entry: when an object unmounts we hide its leader (rather
   * than fully unregister) so re-mount re-shows without re-creating DOM.
   */
  setVisible(key: string, visible: boolean): void {
    const e = this.leaders.get(key);
    if (!e) return;
    e.path.style.display = visible ? '' : 'none';
    if (!visible) {
      // Reset to undrawn so next show replays the draw-in.
      e.path.style.transition = 'none';
      e.path.setAttribute('stroke-dashoffset', String(DRAW_LENGTH));
      e.path.setAttribute('stroke-dasharray', `${DRAW_LENGTH},${DRAW_LENGTH}`);
      e.hasDrawnIn = false;
      e.wasInViewport = false;
    }
  }

  /** Per-frame update — recomputes path geometry and fires draw-in animation. */
  update(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (const e of this.leaders.values()) {
      if (e.path.style.display === 'none') continue;
      const rect = e.htmlEl.getBoundingClientRect();
      // HTML anchor: right edge midpoint of the project card.
      const startX = rect.right;
      const startY = rect.top + rect.height / 2;

      // 3D anchor in world → screen px.
      e.getWorldAnchor(this.worldScratch);
      this.projectScratch.copy(this.worldScratch).project(this.camera);
      const endX = ((this.projectScratch.x + 1) / 2) * vw;
      const endY = ((-this.projectScratch.y + 1) / 2) * vh;

      // If end is offscreen (project failed or outside frustum), skip drawing.
      const offscreen =
        this.projectScratch.z < -1 ||
        this.projectScratch.z > 1 ||
        endX < -200 ||
        endX > vw + 200 ||
        endY < -200 ||
        endY > vh + 200;
      if (offscreen) {
        // Hide path this frame by setting d to empty.
        e.path.setAttribute('d', '');
        continue;
      }

      // Bezier curve: midpoint biased slightly toward end so the curve hugs
      // the 3D object side; tuned for visual elegance, not physics.
      const dx = endX - startX;
      const dy = endY - startY;
      // Control points: cp1 horizontal off the card (3-o'clock), cp2 horizontal
      // off the 3D anchor approaching from the left. The result is a gentle
      // S-shape that reads as a "schematic callout".
      const cp1X = startX + Math.max(20, Math.abs(dx) * 0.45);
      const cp1Y = startY;
      const cp2X = endX - Math.max(20, Math.abs(dx) * 0.45);
      const cp2Y = endY - dy * 0.15;

      e.path.setAttribute(
        'd',
        `M ${startX.toFixed(1)} ${startY.toFixed(1)} ` +
          `C ${cp1X.toFixed(1)} ${cp1Y.toFixed(1)}, ` +
          `${cp2X.toFixed(1)} ${cp2Y.toFixed(1)}, ` +
          `${endX.toFixed(1)} ${endY.toFixed(1)}`
      );

      // Card visibility for animation gate. Use the HTML rect (NOT the 3D
      // projection) — the leader animates when the *card* enters viewport.
      const inViewport =
        rect.bottom > 0 &&
        rect.top < vh &&
        rect.right > 0 &&
        rect.left < vw;

      if (inViewport && !e.hasDrawnIn) {
        // prefers-reduced-motion: skip the draw-in transition entirely; just
        // present the final dotted pattern in one frame.
        const reducedMotion =
          typeof window !== 'undefined' &&
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reducedMotion) {
          e.path.style.transition = 'none';
          e.path.setAttribute('stroke-dasharray', '2,4');
          e.path.setAttribute('stroke-dashoffset', '0');
          e.hasDrawnIn = true;
          continue;
        }

        // Fire draw-in: dasharray = full length so the dashoffset animation
        // reads as a continuous reveal, then settle to the dotted pattern.
        e.path.style.transition = 'none';
        e.path.setAttribute('stroke-dasharray', `${DRAW_LENGTH},${DRAW_LENGTH}`);
        e.path.setAttribute('stroke-dashoffset', String(DRAW_LENGTH));
        // Force layout flush so the next change re-triggers transition.
        // getBoundingClientRect() is the cheapest forced-reflow.
        void e.path.getBoundingClientRect();
        e.path.style.transition = 'stroke-dashoffset 0.7s cubic-bezier(0.22, 1, 0.36, 1)';
        e.path.setAttribute('stroke-dashoffset', '0');
        // After draw-in completes, swap to the dotted pattern (no transition).
        window.setTimeout(() => {
          if (!this.leaders.has(e.path.id) && this.leaders.get(this.findKey(e)) !== e) {
            // entry was removed mid-animation; bail.
          }
          e.path.style.transition = 'none';
          e.path.setAttribute('stroke-dasharray', '2,4');
          e.path.setAttribute('stroke-dashoffset', '0');
        }, 720);
        e.hasDrawnIn = true;
      } else if (!inViewport && e.hasDrawnIn) {
        // Allow replay once card is "comfortably" out of view (hysteresis).
        const farOut =
          rect.bottom < -REPLAY_HYSTERESIS || rect.top > vh + REPLAY_HYSTERESIS;
        if (farOut) {
          e.hasDrawnIn = false;
          e.path.style.transition = 'none';
          e.path.setAttribute('stroke-dasharray', `${DRAW_LENGTH},${DRAW_LENGTH}`);
          e.path.setAttribute('stroke-dashoffset', String(DRAW_LENGTH));
        }
      }

      e.wasInViewport = inViewport;
      // accentColor reserved for future hover feedback — silence "unused" lint.
      void this.accentColor;
    }
  }

  /** Linear scan; only used inside a stale-callback guard (rare). */
  private findKey(target: LeaderEntry): string {
    for (const [k, v] of this.leaders.entries()) if (v === target) return k;
    return '';
  }

  dispose(): void {
    window.removeEventListener('resize', this.handleResize);
    for (const k of Array.from(this.leaders.keys())) this.unregister(k);
    if (this.svg.parentNode) this.svg.parentNode.removeChild(this.svg);
  }
}
