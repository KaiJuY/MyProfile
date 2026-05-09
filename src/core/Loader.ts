/**
 * Step 08 — Boot loader overlay.
 *
 * Behaviour (per playbook §1):
 *   - Full-screen dark overlay injected before App.start() runs
 *   - Five boot-sequence rows that flip from blank → [ok] as resources resolve:
 *       INIT WEBGL CONTEXT       (synchronous — flips on Renderer construction)
 *       LOAD MATCAP TEXTURE      (texture loader callback)
 *       INIT PHYSICS WORLD       (Rapier WASM init)
 *       COMPILE SHADERS          (renderer.compile() after all scenes registered)
 *       BUILD SCENES             (incremented per scene registered)
 *   - 100ms stagger between row appears (visual flair, not technical)
 *   - "READY · CLICK TO ENTER" prompt once all rows are [ok]
 *   - On click → fade overlay opacity 1→0 over 400ms, set pointer-events:none,
 *     resolve `whenDismissed()` so App can start the RAF loop
 *   - 10s timeout → "LOAD FAILED · CLICK TO RETRY"
 *   - In `?nogate=1` mode (test harness), the overlay still renders briefly
 *     but auto-dismisses on completion — no click required
 *
 * Architecture: standalone class. App holds a reference and pings updateStep()
 * as resources resolve. Loader owns its own DOM, listeners, and timing.
 */

export type LoaderStepKey =
  | 'webgl'
  | 'matcap'
  | 'physics'
  | 'shaders'
  | 'scenes';

interface LoaderStep {
  key: LoaderStepKey;
  label: string;
  done: boolean;
  /**
   * Steps with weight > 1 represent multi-stage progress (e.g. 6 scenes).
   * `progress` increments by 1 each tick until == weight, at which point the
   * step is considered done.
   */
  weight: number;
  progress: number;
}

export class Loader {
  private root!: HTMLDivElement;
  private rowEls: Map<LoaderStepKey, HTMLDivElement> = new Map();
  private statusEls: Map<LoaderStepKey, HTMLSpanElement> = new Map();
  private percentEl!: HTMLSpanElement;
  private barFillEl!: HTMLDivElement;
  private promptEl!: HTMLDivElement;
  private styleTag!: HTMLStyleElement;

  private steps: LoaderStep[] = [
    { key: 'webgl',   label: 'INIT WEBGL CONTEXT', done: false, weight: 1, progress: 0 },
    { key: 'matcap',  label: 'LOAD MATCAP TEXTURE', done: false, weight: 1, progress: 0 },
    { key: 'physics', label: 'INIT PHYSICS WORLD', done: false, weight: 1, progress: 0 },
    { key: 'shaders', label: 'COMPILE SHADERS', done: false, weight: 1, progress: 0 },
    { key: 'scenes',  label: 'BUILD SCENES', done: false, weight: 6, progress: 0 },
  ];

  private dismissed = false;
  private allDoneCalled = false;
  private dismissResolve: (() => void) | null = null;
  private timeoutHandle: number | null = null;
  private failed = false;
  private noGate: boolean;

  constructor(noGate: boolean) {
    this.noGate = noGate;
  }

  /**
   * Mount the overlay into the DOM. Call BEFORE App.start() so the user sees
   * the boot sequence immediately on first paint.
   */
  mount(): void {
    this.injectStyles();

    this.root = document.createElement('div');
    this.root.id = 'app-loader';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.root.setAttribute('aria-label', 'Loading');

    // Container interior — boot sequence + progress + identity
    const inner = document.createElement('div');
    inner.className = 'app-loader__inner';

    const seq = document.createElement('div');
    seq.className = 'app-loader__seq';

    // Stagger reveal of each row
    this.steps.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'app-loader__row';
      row.style.animationDelay = `${i * 100}ms`;

      const label = document.createElement('span');
      label.className = 'app-loader__label';
      label.textContent = s.label;

      const status = document.createElement('span');
      status.className = 'app-loader__status';
      status.textContent = '';

      row.appendChild(label);
      row.appendChild(status);
      seq.appendChild(row);

      this.rowEls.set(s.key, row);
      this.statusEls.set(s.key, status);
    });

    const progressLine = document.createElement('div');
    progressLine.className = 'app-loader__progress-line';
    progressLine.textContent = 'LOADING ··· ';
    this.percentEl = document.createElement('span');
    this.percentEl.className = 'app-loader__percent';
    this.percentEl.textContent = '0%';
    progressLine.appendChild(this.percentEl);

    const bar = document.createElement('div');
    bar.className = 'app-loader__bar';
    this.barFillEl = document.createElement('div');
    this.barFillEl.className = 'app-loader__bar-fill';
    bar.appendChild(this.barFillEl);

    this.promptEl = document.createElement('div');
    this.promptEl.className = 'app-loader__prompt';
    this.promptEl.textContent = '';

    const id = document.createElement('div');
    id.className = 'app-loader__identity';
    id.textContent = 'PROFILE_v9.4 / TPE-HSZ / KAI-JU YANG';

    inner.appendChild(seq);
    inner.appendChild(progressLine);
    inner.appendChild(bar);
    inner.appendChild(this.promptEl);
    inner.appendChild(id);
    this.root.appendChild(inner);
    document.body.appendChild(this.root);

    // 10-second hard timeout — if any step hangs, surface the failure.
    this.timeoutHandle = window.setTimeout(() => {
      if (!this.allComplete()) this.markFailed();
    }, 10_000);
  }

  /** Mark a single-weight step done. Idempotent. */
  markDone(key: LoaderStepKey): void {
    const s = this.steps.find((x) => x.key === key);
    if (!s) return;
    if (s.done) return;
    s.progress = s.weight;
    s.done = true;
    const statusEl = this.statusEls.get(key);
    if (statusEl) statusEl.textContent = '[ok]';
    const rowEl = this.rowEls.get(key);
    if (rowEl) rowEl.classList.add('is-done');
    this.refreshProgress();
  }

  /** Increment a multi-weight step by 1. Idempotent past `weight`. */
  tick(key: LoaderStepKey): void {
    const s = this.steps.find((x) => x.key === key);
    if (!s) return;
    if (s.done) return;
    s.progress = Math.min(s.weight, s.progress + 1);
    if (s.progress >= s.weight) {
      this.markDone(key);
      return;
    }
    const statusEl = this.statusEls.get(key);
    if (statusEl) {
      statusEl.textContent = `[${Math.round((s.progress / s.weight) * 100)}%]`;
    }
    this.refreshProgress();
  }

  /** Returns once the user clicks (or noGate auto-dismisses). */
  whenDismissed(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.dismissResolve = resolve;
    });
  }

  /** True if the overlay is gone from view (post-fade). */
  isDismissed(): boolean {
    return this.dismissed;
  }

  /** Programmatic dismiss — used by `?nogate=1` mode. */
  forceDismiss(): void {
    this.dismiss();
  }

  /** Compute total percent across all weighted steps. */
  private percent(): number {
    let total = 0;
    let done = 0;
    for (const s of this.steps) {
      total += s.weight;
      done += s.progress;
    }
    return total === 0 ? 0 : Math.round((done / total) * 100);
  }

  private refreshProgress(): void {
    const p = this.percent();
    this.percentEl.textContent = `${p}%`;
    this.barFillEl.style.width = `${p}%`;

    if (this.allComplete() && !this.allDoneCalled) {
      this.allDoneCalled = true;
      this.onAllComplete();
    }
  }

  private allComplete(): boolean {
    return this.steps.every((s) => s.done);
  }

  private onAllComplete(): void {
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    if (this.noGate) {
      // Auto-dismiss for verification harness; brief delay so user sees "READY".
      this.promptEl.textContent = 'READY';
      this.promptEl.classList.add('is-ready');
      window.setTimeout(() => this.dismiss(), 60);
      return;
    }
    this.promptEl.textContent = 'READY · CLICK TO ENTER';
    this.promptEl.classList.add('is-ready');
    const onClick = (): void => {
      this.root.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
      this.dismiss();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' || e.key === ' ') {
        this.root.removeEventListener('click', onClick);
        window.removeEventListener('keydown', onKey);
        this.dismiss();
      }
    };
    this.root.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    // Make the root itself the click target — we set pointer-events:auto in CSS.
  }

  private markFailed(): void {
    if (this.failed) return;
    this.failed = true;
    this.promptEl.textContent = 'LOAD FAILED · CLICK TO RETRY';
    this.promptEl.classList.add('is-failed');
    const onClick = (): void => {
      this.root.removeEventListener('click', onClick);
      location.reload();
    };
    this.root.addEventListener('click', onClick);
  }

  private dismiss(): void {
    if (this.dismissed) return;
    this.dismissed = true;
    this.root.classList.add('is-dismissing');
    // CSS handles the 400ms opacity fade; remove from DOM after.
    window.setTimeout(() => {
      if (this.root && this.root.parentElement) {
        this.root.parentElement.removeChild(this.root);
      }
      if (this.styleTag && this.styleTag.parentElement) {
        this.styleTag.parentElement.removeChild(this.styleTag);
      }
      if (this.dismissResolve) {
        this.dismissResolve();
        this.dismissResolve = null;
      }
    }, 420);
  }

  private injectStyles(): void {
    const css = `
#app-loader {
  position: fixed;
  inset: 0;
  z-index: 99999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #050608;
  color: #f3efe8;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  cursor: default;
  pointer-events: auto;
  opacity: 1;
  transition: opacity 0.4s ease-out;
}
#app-loader.is-dismissing {
  opacity: 0;
  pointer-events: none;
}
.app-loader__inner {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 320px;
  max-width: 420px;
  padding: 28px 24px;
}
.app-loader__seq {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 4px;
}
.app-loader__row {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  opacity: 0;
  animation: app-loader-row-in 0.5s ease-out forwards;
}
@keyframes app-loader-row-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
.app-loader__label {
  color: rgba(243, 239, 232, 0.55);
  white-space: nowrap;
}
.app-loader__row.is-done .app-loader__label {
  color: rgba(243, 239, 232, 0.95);
}
.app-loader__status {
  color: #ff6a00;
  white-space: nowrap;
  min-width: 4em;
  text-align: right;
}
.app-loader__progress-line {
  margin-top: 4px;
  color: rgba(243, 239, 232, 0.55);
}
.app-loader__percent {
  color: #f3efe8;
}
.app-loader__bar {
  width: 100%;
  height: 2px;
  background: rgba(243, 239, 232, 0.10);
  overflow: hidden;
}
.app-loader__bar-fill {
  height: 100%;
  width: 0%;
  background: #f3efe8;
  transition: width 0.18s ease-out;
}
.app-loader__prompt {
  margin-top: 18px;
  min-height: 1.4em;
  color: rgba(243, 239, 232, 0.75);
  text-align: center;
  letter-spacing: 0.18em;
  opacity: 0;
  transition: opacity 0.3s ease-out;
}
.app-loader__prompt.is-ready {
  opacity: 1;
  color: #f3efe8;
  animation: app-loader-blink 1.4s ease-in-out infinite;
}
.app-loader__prompt.is-failed {
  opacity: 1;
  color: #ff6a00;
}
@keyframes app-loader-blink {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.45; }
}
.app-loader__identity {
  margin-top: 14px;
  color: rgba(243, 239, 232, 0.30);
  font-size: 10px;
  text-align: center;
}
@media (prefers-reduced-motion: reduce) {
  .app-loader__row { animation: none; opacity: 1; }
  .app-loader__prompt.is-ready { animation: none; }
}
`.trim();
    this.styleTag = document.createElement('style');
    this.styleTag.id = 'app-loader-style';
    this.styleTag.textContent = css;
    document.head.appendChild(this.styleTag);
  }
}
