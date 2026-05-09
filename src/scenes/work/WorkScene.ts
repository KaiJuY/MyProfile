import * as THREE from 'three';
import type { SceneModule } from '../SceneManager';
import { elementToWorldSize } from '@core/ScreenToWorld';
import type { WorkObject } from './WorkObject';
import { LeaderLineManager } from './LeaderLine';
import { EfemGear } from './objects/EfemGear';
import { SecsSimulator } from './objects/SecsSimulator';
import { DcsaYolo } from './objects/DcsaYolo';
import { PlcSimulation } from './objects/PlcSimulation';
import { MaterialManager } from './objects/MaterialManager';
import { DivineWhisper } from './objects/DivineWhisper';
import { SnVersion } from './objects/SnVersion';

/**
 * WorkScene — owns one 3D companion per project card in #projects, plus a
 * shared SVG leader-line overlay.
 *
 * Lifecycle per card:
 *   1. Discovery: in init(), query `section#projects .project[data-href]?` and
 *      read `.pid` text to derive the project number ("PRJ_01" → 1).
 *   2. Per-frame in update():
 *      a. Recompute the card's bounding rect.
 *      b. If the card is within ±200vh of viewport, ensure its WorkObject is
 *         mounted; else ensure unmounted.
 *      c. If mounted, derive world position via screen-to-world, scale
 *         proportional to card height, and feed card-local scrollProgress.
 *      d. Tick the leader-line manager (one batched DOM/SVG update per frame).
 *
 * Mobile bail: if `window.innerWidth < 768` OR `(pointer: coarse)`, skip all
 * 3D work. Existing HTML cards stay; the leader-line SVG is created hidden.
 *
 * Lighting: a single ambient + one directional light shared across all
 * objects. We don't add per-object lights — playbook §6 explicit cap.
 */

const HEAD_DEPTH = 5; // same depth as Hero/Pursuits so screen→world maps cleanly
const PRELOAD_VH = 200; // mount when card is within this many vh of viewport
const UNMOUNT_DELAY_MS = 200; // small grace period after leaving the window

interface CardEntry {
  /** "01" through "07" — derived from .pid text. */
  pid: string;
  /** Card's outermost .project element. */
  el: HTMLElement;
  /** The WorkObject implementation for this project. */
  obj: WorkObject;
  /** Last time the card was within the preload window (ms timestamp). */
  lastInWindowMs: number;
  /** Current opacity-driving scrollProgress (smoothed). */
  cardLocalScroll: number;
}

function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.innerWidth < 768) return true;
  if (typeof window.matchMedia === 'function') {
    if (window.matchMedia('(pointer: coarse)').matches) return true;
  }
  return false;
}

/** Map "PRJ_NN" → WorkObject implementation. New project? Wire it here. */
function makeObjectFor(pid: string): WorkObject | null {
  switch (pid) {
    case '01':
      return new EfemGear();
    case '02':
      return new SecsSimulator();
    case '03':
      return new DcsaYolo();
    case '04':
      return new PlcSimulation();
    case '05':
      return new MaterialManager();
    case '06':
      return new DivineWhisper();
    case '07':
      return new SnVersion();
    default:
      return null;
  }
}

export class WorkScene implements SceneModule {
  readonly name = 'work';

  private readonly camera: THREE.PerspectiveCamera;
  private scene!: THREE.Scene;
  private cards: CardEntry[] = [];
  private leaderManager?: LeaderLineManager;
  private mobileMode = false;

  // Shared lighting — added/removed when ANY card is mounted to keep the
  // light count low when the section is off-screen.
  private ambient?: THREE.AmbientLight;
  private directional?: THREE.DirectionalLight;
  private lightsMounted = false;

  // Reusable scratch.
  private tmpVec3 = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  init(scene: THREE.Scene): void {
    this.scene = scene;
    this.mobileMode = isMobileViewport();

    if (this.mobileMode) {
      // Existing CSS cards handle the section. Nothing to mount.
      return;
    }

    // Discover cards. We query inside #projects only — the toolkit/career
    // sections also have card-shaped elements but we don't decorate those.
    const projectEls = document.querySelectorAll<HTMLElement>('section#projects .project');

    for (const el of Array.from(projectEls)) {
      const pidEl = el.querySelector<HTMLElement>('.pid');
      if (!pidEl) continue;
      const pidText = (pidEl.textContent ?? '').trim();
      // "PRJ_01" → "01"
      const m = /PRJ_(\d+)/.exec(pidText);
      if (!m) continue;
      const pid = m[1];
      const obj = makeObjectFor(pid);
      if (!obj) continue;
      obj.init();
      this.cards.push({
        pid,
        el,
        obj,
        lastInWindowMs: 0,
        cardLocalScroll: 0,
      });
    }

    // Lighting — created here, mounted lazily once a card mounts.
    // Both lights are intentionally bright (Lusion-style WebGL renders against
    // a dark page background; without strong fill, gray Lambert objects read
    // as nearly-black silhouettes — see step-04 verification screenshots).
    this.ambient = new THREE.AmbientLight(0xffffff, 1.10);
    this.directional = new THREE.DirectionalLight(0xffffff, 1.20);
    this.directional.position.set(2, 3, 4);

    // Leader manager.
    this.leaderManager = new LeaderLineManager(this.camera);
    for (const card of this.cards) {
      const captured = card; // close over this entry, not the loop var
      this.leaderManager.register(`prj-${card.pid}`, card.el, (out) =>
        captured.obj.getLeaderAnchor(out)
      );
      // Leaders start hidden; revealed when the corresponding object mounts.
      this.leaderManager.setVisible(`prj-${card.pid}`, false);
    }
  }

  /**
   * Compute card-local scrollProgress per playbook formula:
   *   t = clamp((vh - rect.top) / (rect.height + vh), 0, 1)
   * → 0 when card is just below viewport (top at vh), 1 when card has just
   *   left from the top (bottom at 0).
   */
  private cardScrollProgress(rect: DOMRect, vh: number): number {
    const total = rect.height + vh;
    const travelled = vh - rect.top;
    return Math.max(0, Math.min(1, travelled / total));
  }

  private mountLights(): void {
    if (this.lightsMounted || !this.ambient || !this.directional) return;
    this.scene.add(this.ambient);
    this.scene.add(this.directional);
    this.lightsMounted = true;
  }

  private unmountLights(): void {
    if (!this.lightsMounted || !this.ambient || !this.directional) return;
    this.scene.remove(this.ambient);
    this.scene.remove(this.directional);
    this.lightsMounted = false;
  }

  update(_dt: number, _scrollProgress: number): void {
    // Mobile: nothing to do. The leader manager wasn't created on mobile.
    if (this.mobileMode) return;
    if (!this.leaderManager) return;
    if (this.cards.length === 0) {
      this.leaderManager.update();
      return;
    }

    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const now = performance.now();
    let anyMounted = false;

    for (const card of this.cards) {
      const rect = card.el.getBoundingClientRect();

      // Preload window: mount when card is within ±PRELOAD_VH of viewport.
      // "Within": rect.top < vh + PRELOAD_VH (card within a screen below) AND
      //           rect.bottom > -PRELOAD_VH (card within a screen above).
      const inWindow =
        rect.top < vh + PRELOAD_VH * (vh / 100) &&
        rect.bottom > -(PRELOAD_VH * (vh / 100));

      if (inWindow) {
        card.lastInWindowMs = now;
        if (!card.obj.isMounted()) {
          this.mountLights();
          card.obj.mount(this.scene);
          this.leaderManager.setVisible(`prj-${card.pid}`, true);
        }
      } else if (card.obj.isMounted() && now - card.lastInWindowMs > UNMOUNT_DELAY_MS) {
        card.obj.unmount(this.scene);
        this.leaderManager.setVisible(`prj-${card.pid}`, false);
      }

      if (!card.obj.isMounted()) continue;
      anyMounted = true;

      // Positioning. We map a SCREEN-space target rect to world coordinates
      // via a synthesized DOM box, instead of card-relative offsets. This
      // gives full control over WHERE on the screen the 3D companion sits,
      // independent of the existing 12-column project grid.
      //
      // Strategy:
      //  - Wide projects (.wide, span 12): place over the right portion of
      //    the .pviz image area — the chart PNG provides a busy backdrop
      //    that the 3D bars/curve read crisply against.
      //  - Other projects: place at the card's right edge, clipped to the
      //    viewport so narrow cards on the right column don't push 3D off
      //    screen. The 3D anchor's LEFT edge sits ~at the card's RIGHT edge,
      //    so the leader line always travels rightward.
      const isWide = card.el.classList.contains('wide');
      const isFeat = card.el.classList.contains('feat');
      const isThird = card.el.classList.contains('third');
      const isStd = card.el.classList.contains('std');
      // World-space size of the card (used only for the scale heuristic below).
      const cardSize = elementToWorldSize(card.el, this.camera, HEAD_DEPTH);

      // We use the same `rect` from the preload-window check above for the
      // screen-anchor math — re-using avoids a second forced layout. (A
      // browser may batch `getBoundingClientRect` calls but reading from a
      // single local var is unambiguously cheaper.)
      const rectScreen = rect;

      // Estimate object's screen-space half-width based on intended scale +
      // depth. We compute this AFTER scale so the math is closed-form.
      // Pixels per world-unit at HEAD_DEPTH = (vh / 2) / tan(fov/2). Cache.
      const fovRad = (this.camera.fov * Math.PI) / 180;
      const worldHeight = 2 * HEAD_DEPTH * Math.tan(fovRad / 2);
      const pxPerWorld = vh / worldHeight;

      // Default object size estimate (most objects are ~1 world unit wide).
      const objWorldHalfWidth = 0.5; // ~1 unit total
      // Scale is tuned by card class to keep the on-screen 3D footprint
      // proportional to the card. Smaller for narrow cards so the 3D
      // companion doesn't overwhelm the cards in the same row.
      const baseScale = cardSize.height / 0.6;
      const maxScale = isWide ? 0.95 : isFeat ? 0.75 : isThird || isStd ? 0.55 : 0.75;
      const scale = Math.max(0.40, Math.min(maxScale, baseScale));
      const objScreenHalfWidth = objWorldHalfWidth * scale * pxPerWorld;

      // Target screen-X of 3D CENTER. For non-wide cards: place so the
      // object's LEFT edge sits ~12px to the right of card.right (pure gutter
      // visual). Then clamp center so the right edge stays inside viewport.
      let targetCx: number;
      const cardCenterY = rectScreen.top + rectScreen.height / 2;
      if (isWide) {
        // Wide: put over the right ~70% of card (where .pviz lives).
        targetCx = rectScreen.right - rectScreen.width * 0.20;
      } else {
        // Position so the object's LEFT edge is just past the card's right edge.
        targetCx = rectScreen.right + 12 + objScreenHalfWidth;
      }
      // Clamp so right edge stays in viewport with 8px margin.
      targetCx = Math.min(targetCx, vw - objScreenHalfWidth - 8);
      // And so left edge doesn't disappear behind card-center on extreme overlap.
      targetCx = Math.max(targetCx, rectScreen.right - objScreenHalfWidth + 4);

      // Convert (targetCx, cardCenterY) to world via NDC unproject (same as
      // ScreenToWorld.elementToWorld but without the bounding-rect read).
      const ndcX = (targetCx / vw) * 2 - 1;
      const ndcY = -(((cardCenterY - rectScreen.height * 0.05) / vh) * 2 - 1);
      this.tmpVec3.set(ndcX, ndcY, 0.5).unproject(this.camera);
      this.tmpVec3.sub(this.camera.position).normalize();
      this.tmpVec3.multiplyScalar(HEAD_DEPTH).add(this.camera.position);

      card.obj.setTransform(this.tmpVec3, scale);

      // Card-local scrollProgress.
      const t = this.cardScrollProgress(rect, vh);
      // Smooth a touch — Lenis already smooths, but our targets (heights, etc.)
      // benefit from another small EMA so they don't strobe at high velocity.
      card.cardLocalScroll += (t - card.cardLocalScroll) * 0.20;
      card.obj.update(_dt, card.cardLocalScroll);
    }

    if (!anyMounted) this.unmountLights();

    // Single batched leader update — once per frame, after positions are set.
    this.leaderManager.update();
  }

  dispose(scene: THREE.Scene): void {
    if (this.leaderManager) {
      this.leaderManager.dispose();
      this.leaderManager = undefined;
    }
    for (const card of this.cards) {
      card.obj.dispose(scene);
    }
    this.cards.length = 0;
    this.unmountLights();
    this.ambient = undefined;
    this.directional = undefined;
  }
}
