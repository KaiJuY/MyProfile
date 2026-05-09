/**
 * Step 08 — Dev FPS counter.
 *
 * Mounts a small fixed-position monospace readout in the top-left corner.
 * Activated via `?debug=1`. Updates every 500ms with rolling-average FPS.
 *
 * Kept dead-simple — no graph, no min/max, just a number. The point is to
 * have a sanity-check while tweaking postprocessing / scene settings.
 */
export class FPSCounter {
  private root!: HTMLDivElement;
  private samples: number[] = [];
  private accumDt = 0;
  private lastUpdateAt = 0;

  mount(): void {
    const root = document.createElement('div');
    root.id = 'fps-counter';
    Object.assign(root.style, {
      position: 'fixed',
      top: '12px',
      left: '12px',
      zIndex: '70',
      padding: '4px 8px',
      background: 'rgba(7, 8, 10, 0.7)',
      color: '#f3efe8',
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: '11px',
      letterSpacing: '0.10em',
      pointerEvents: 'none',
      borderRadius: '2px',
      border: '1px solid rgba(243, 239, 232, 0.15)',
    });
    root.textContent = '— fps';
    document.body.appendChild(root);
    this.root = root;
    this.lastUpdateAt = performance.now();
  }

  tick(dt: number): void {
    if (dt <= 0) return;
    this.samples.push(1 / dt);
    this.accumDt += dt;
    if (this.samples.length > 240) this.samples.shift();

    const now = performance.now();
    if (now - this.lastUpdateAt > 500) {
      const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
      this.root.textContent = `${avg.toFixed(0)} fps`;
      this.lastUpdateAt = now;
    }
  }

  dispose(): void {
    if (this.root && this.root.parentElement) {
      this.root.parentElement.removeChild(this.root);
    }
  }
}
