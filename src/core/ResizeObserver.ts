import { debounce } from '@utils/throttle';

/**
 * Window-resize broadcaster. Subscribers receive { width, height, dpr }.
 *
 * Why this and not the native ResizeObserver API?
 *  - We're observing the viewport, not a single element
 *  - We need to debounce: Three resize is expensive (re-allocates depth buffers)
 *  - We need to share the cap-2 DPR across the whole app
 */

export interface ViewportSize {
  width: number;
  height: number;
  dpr: number;
}

export type ResizeCallback = (size: ViewportSize) => void;

const DEBOUNCE_MS = 100;

export class WindowResizeBroadcaster {
  private listeners: Set<ResizeCallback> = new Set();
  private current: ViewportSize;
  private readonly debounced: () => void;

  constructor() {
    this.current = WindowResizeBroadcaster.snapshot();
    this.debounced = debounce(() => this.broadcast(), DEBOUNCE_MS);
    window.addEventListener('resize', this.debounced, { passive: true });
  }

  static snapshot(): ViewportSize {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: Math.min(window.devicePixelRatio, 2),
    };
  }

  /** Returns the most recent viewport snapshot without forcing a re-broadcast. */
  getSize(): ViewportSize {
    return { ...this.current };
  }

  /** Subscribe to resize events. Returns an unsubscribe function. */
  subscribe(cb: ResizeCallback): () => void {
    this.listeners.add(cb);
    // Push current size on subscribe so new subscribers don't have to wait
    // for the next resize to learn the viewport size.
    cb({ ...this.current });
    return () => {
      this.listeners.delete(cb);
    };
  }

  private broadcast(): void {
    this.current = WindowResizeBroadcaster.snapshot();
    for (const cb of this.listeners) {
      cb({ ...this.current });
    }
  }

  dispose(): void {
    window.removeEventListener('resize', this.debounced);
    this.listeners.clear();
  }
}
