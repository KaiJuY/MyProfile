import Lenis from 'lenis';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { saturate } from '@utils/lerp';

gsap.registerPlugin(ScrollTrigger);

/**
 * Lenis-based smooth scroll, plus helpers for section-relative progress.
 *
 * Integration with GSAP ScrollTrigger:
 *   - Lenis owns the scroll loop (via gsap.ticker)
 *   - We tell ScrollTrigger to use Lenis's update events as its scroll source
 *     via ScrollTrigger.scrollerProxy + lenis.on('scroll', ScrollTrigger.update)
 *   - This prevents the two systems from fighting (each thinking they own scroll)
 *
 * Reference: https://github.com/darkroomengineering/lenis#with-gsap-scrolltrigger
 */

export type ScrollUpdateCallback = (info: {
  scroll: number;
  limit: number;
  progress: number;
  velocity: number;
}) => void;

export class ScrollManager {
  readonly lenis: Lenis;
  private listeners: Set<ScrollUpdateCallback> = new Set();
  private latestProgress: number = 0;

  constructor() {
    this.lenis = new Lenis({
      // Default lerp produces ~0.1 smoothness — good baseline
      lerp: 0.1,
      // Disable autoRaf because we drive raf via gsap.ticker (single source of truth)
      autoRaf: false,
      // Standard wheel multiplier — matches native scroll feel
      wheelMultiplier: 1,
      // Keep keyboard arrows / Page Up / Page Down working
      smoothWheel: true,
    });

    // Lenis emits a `scroll` event after each internal update. We use it to:
    //  1. Tell ScrollTrigger to recompute (scrollerProxy bridge)
    //  2. Fan out to our own subscribers
    this.lenis.on('scroll', (event) => {
      const limit = event.limit ?? 1;
      const progress = limit > 0 ? saturate(event.scroll / limit) : 0;
      this.latestProgress = progress;
      const payload = {
        scroll: event.scroll,
        limit,
        progress,
        velocity: event.velocity ?? 0,
      };
      for (const cb of this.listeners) cb(payload);
      ScrollTrigger.update();
    });

    // Bridge ScrollTrigger to use Lenis as its scroll source.
    // Note: scrollTop must be a regular function (not arrow) so `arguments` binds
    // to its own call — ScrollTrigger calls scrollTop() with 0 args to read and
    // scrollTop(n) with 1 arg to write. Arrow functions inherit the enclosing
    // (constructor) `arguments`, which would always be empty and silently break
    // ScrollTrigger.scrollTo() / .refresh() set behavior.
    const lenis = this.lenis;
    ScrollTrigger.scrollerProxy(document.body, {
      scrollTop: function (value?: number) {
        if (arguments.length && typeof value === 'number') {
          lenis.scrollTo(value, { immediate: true });
          return undefined;
        }
        return lenis.scroll;
      },
      getBoundingClientRect: () => ({
        top: 0,
        left: 0,
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    });

    // Drive Lenis's RAF from gsap.ticker. Single ticker = single dt source.
    // gsap delivers time in seconds, Lenis wants milliseconds.
    gsap.ticker.add((time) => {
      this.lenis.raf(time * 1000);
    });
    gsap.ticker.lagSmoothing(0); // disable to keep dt deterministic

    // Refresh ScrollTrigger after init so it picks up Lenis as scroller
    ScrollTrigger.addEventListener('refresh', () => this.lenis.resize());
    ScrollTrigger.refresh();
  }

  /** Global page scroll progress, [0..1]. Updated each lenis tick. */
  get scrollProgress(): number {
    return this.latestProgress;
  }

  /**
   * Per-section progress: 0 when the element's top reaches the viewport bottom
   * (about to enter), 1 when the element's bottom reaches the viewport top
   * (about to leave). Clamped to [0, 1] in between.
   */
  sectionProgress(elementId: string): number {
    const el = document.getElementById(elementId);
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    // Total range of motion: from "top at vh" to "bottom at 0"
    // = element.height + vh
    const totalRange = rect.height + vh;
    // How far we've travelled: from initial state, we've moved `vh - rect.top`.
    // When rect.top === vh, we're at 0. When rect.top + rect.height === 0
    // (so rect.top === -rect.height), we've moved vh + rect.height = totalRange.
    const travelled = vh - rect.top;
    return saturate(travelled / totalRange);
  }

  /** Subscribe to scroll updates. Returns an unsubscribe function. */
  onUpdate(callback: ScrollUpdateCallback): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  destroy(): void {
    this.lenis.destroy();
    this.listeners.clear();
  }
}
