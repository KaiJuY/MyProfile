import { lerp, clamp, saturate } from '@utils/lerp';
import type { Milestone } from './PathBuilder';

/**
 * HUD — engineering instrument readout overlaid on the trajectory section.
 *
 * Format (playbook §7):
 *   POS · 2018.02
 *   DEPTH · 142m
 *   STEP · 2 / 4
 *   ▔▔▔▔▔▔ (progress bar — width = sectionProgress * 100%)
 *
 * Implementation: pure HTML overlay (NOT WebGL). Reasons:
 *   - Crisp text at any DPR without MSDF/SDF font rendering pipeline
 *   - Easy to style with the existing site CSS variables (--ink, --ink-2)
 *     so it reads as "site identity" not "Lusion HUD"
 *   - Trivial to fade in/out by toggling opacity
 *
 * Style: monospace, all-caps, file-header palette ("FILE — 06.05.2026" vibe).
 * Position: top-right corner, fixed. Above the canvas, below the nav bar.
 */

// Issue #3 fix: hold the HUD until the career section actually fills the
// viewport (sectionProgress ≈ 0.32 for a 220vh-tall section on a 100vh
// viewport). Previously fading in at 0.02 meant the HUD appeared while the
// user was still seeing 90% Bag.
const HUD_VISIBLE_BAND_START = 0.32;
const HUD_VISIBLE_BAND_END = 0.97;   // fade out near exit transition

export class HUD {
  private root: HTMLDivElement;
  private posValueEl: HTMLSpanElement;
  private depthValueEl: HTMLSpanElement;
  private stepValueEl: HTMLSpanElement;
  private barFillEl: HTMLDivElement;

  private milestones: Milestone[];
  private totalSteps: number;

  private currentOpacity = 0;

  constructor(milestones: Milestone[]) {
    this.milestones = milestones;
    this.totalSteps = milestones.length;

    const root = document.createElement('div');
    root.className = 'trajectory-hud';
    // All inline styles so we don't need a separate CSS file edit beyond the
    // small additive block in style.css for the progress-bar fill.
    Object.assign(root.style, {
      position: 'fixed',
      top: '88px', // below the existing nav (which is ~64-72px tall)
      right: '24px',
      zIndex: '40', // above canvas (z=2), below nav (z=50)
      pointerEvents: 'none',
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, "JetBrains Mono", "Roboto Mono", Consolas, monospace',
      fontSize: '11px',
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      color: 'var(--ink-2, rgba(243,239,232,0.6))',
      lineHeight: '1.7',
      textAlign: 'right',
      opacity: '0',
      transition: 'opacity 0.35s ease-out',
      mixBlendMode: 'normal',
    });

    // Each row: "LABEL · VALUE" — label dim, value brighter.
    const buildRow = (label: string): { row: HTMLDivElement; value: HTMLSpanElement } => {
      const row = document.createElement('div');
      row.className = 'trajectory-hud-row';
      const labelSpan = document.createElement('span');
      labelSpan.textContent = label + ' · ';
      labelSpan.style.color = 'var(--ink-3, rgba(243,239,232,0.38))';
      const valueSpan = document.createElement('span');
      valueSpan.textContent = '—';
      valueSpan.style.color = 'var(--ink, #f3efe8)';
      row.appendChild(labelSpan);
      row.appendChild(valueSpan);
      return { row, value: valueSpan };
    };

    const filename = document.createElement('div');
    filename.textContent = 'FILE — TRAJECTORY_06.04.2026';
    filename.style.color = 'var(--ink-3, rgba(243,239,232,0.38))';
    filename.style.marginBottom = '6px';
    root.appendChild(filename);

    const pos = buildRow('POS');
    this.posValueEl = pos.value;
    root.appendChild(pos.row);

    const depth = buildRow('DEPTH');
    this.depthValueEl = depth.value;
    root.appendChild(depth.row);

    const step = buildRow('STEP');
    this.stepValueEl = step.value;
    root.appendChild(step.row);

    // Progress bar: a thin wrapper with a filled inner div.
    const barWrap = document.createElement('div');
    Object.assign(barWrap.style, {
      marginTop: '8px',
      width: '120px',
      height: '2px',
      background: 'rgba(243,239,232,0.12)',
      marginLeft: 'auto', // align right because text-align:right doesn't affect blocks
      position: 'relative',
      overflow: 'hidden',
    });
    const barFill = document.createElement('div');
    Object.assign(barFill.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      bottom: '0',
      width: '0%',
      background: 'var(--ink, #f3efe8)',
      transformOrigin: 'left center',
      transition: 'width 0.08s linear',
    });
    barWrap.appendChild(barFill);
    root.appendChild(barWrap);
    this.barFillEl = barFill;

    document.body.appendChild(root);
    this.root = root;
  }

  /**
   * Update the HUD readouts.
   * @param pathT camera's current curve t in [0,1]
   * @param sectionProgress raw section scroll progress [0,1]
   * @param worldZ camera's current Z (used for DEPTH readout)
   */
  update(pathT: number, sectionProgress: number, worldZ: number): void {
    // 1. POS — interpolate between adjacent milestone date strings.
    //    pathT === 0 → first; pathT === 1 → last; else lerp the two
    //    bracketing milestones' year+month numerically and reformat.
    const posStr = this.interpolateDate(pathT);
    this.posValueEl.textContent = posStr;

    // 2. DEPTH — |Z| × factor. Path Z ∈ [0, -32], so |Z| ∈ [0, 32]. Multiply
    //    by 4.5 → range [0, 144]m. Monotonically increasing along the path
    //    because the curve is monotone in Z (control points strictly
    //    decreasing in Z). Per playbook footer requirement.
    const depthM = Math.abs(worldZ) * 4.5;
    this.depthValueEl.textContent = `${Math.round(depthM)}m`;

    // 3. STEP — current milestone (1-indexed) / total.
    //    "Current" = the marker whose t is closest to pathT. We bias slightly
    //    so a marker is only "current" when the camera has reached or just
    //    passed it — feels more like odometer ticks than smooth interpolation.
    let step = 1;
    for (let i = 0; i < this.milestones.length; i++) {
      if (pathT + 0.001 >= this.milestones[i].t) step = i + 1;
    }
    this.stepValueEl.textContent = `${step} / ${this.totalSteps}`;

    // 4. Progress bar — section scroll progress, clamped 0..1.
    this.barFillEl.style.width = `${saturate(sectionProgress) * 100}%`;

    // 5. Visibility envelope.
    let targetOpacity = 0;
    if (sectionProgress >= HUD_VISIBLE_BAND_START && sectionProgress <= HUD_VISIBLE_BAND_END) {
      // Soft fade in/out within the band. Slightly slower entry fade (0.06)
      // so the HUD slides in as the section settles into view.
      const fadeIn = saturate((sectionProgress - HUD_VISIBLE_BAND_START) / 0.06);
      const fadeOut = saturate((HUD_VISIBLE_BAND_END - sectionProgress) / 0.04);
      targetOpacity = Math.min(fadeIn, fadeOut);
    }
    if (Math.abs(targetOpacity - this.currentOpacity) > 0.005) {
      this.currentOpacity = targetOpacity;
      this.root.style.opacity = `${targetOpacity}`;
    }

    // Step 08 deferred fix: when fully outside the section (opacity 0), set
    // display:none so the HUD never participates in layout / interaction. This
    // had been "harmless" because pointer-events were already disabled, but it
    // shows up as a stray a11y stop on screen readers.
    const wantHidden = targetOpacity <= 0.001;
    const isHidden = this.root.style.display === 'none';
    if (wantHidden && !isHidden) {
      this.root.style.display = 'none';
    } else if (!wantHidden && isHidden) {
      this.root.style.display = '';
    }
  }

  /**
   * Convert pathT ∈ [0,1] to a date string by linearly interpolating between
   * adjacent milestones. Milestones may NOT be evenly spaced in pathT —
   * we use their actual `t` values (which on the 5-control-point curve are
   * 0, 0.25, 0.5, 0.75 with the trailing fly-past beyond 0.75).
   *
   * For pathT > last milestone's t (the fly-past zone), we pin to the last
   * milestone's date — so the HUD reads "2025.11" all the way through the
   * exit fly-past instead of extrapolating a fictional future date.
   */
  private interpolateDate(pathT: number): string {
    if (this.milestones.length === 0) return '—';
    if (this.milestones.length === 1) return this.milestones[0].date;

    const tClamped = clamp(pathT, 0, 1);

    // Past the last milestone? Pin to its date.
    const last = this.milestones[this.milestones.length - 1];
    if (tClamped >= last.t) return last.date;

    // Find bracketing pair using actual milestone.t values.
    let i = 0;
    for (; i < this.milestones.length - 1; i++) {
      if (this.milestones[i + 1].t > tClamped) break;
    }
    const ms0 = this.milestones[i];
    const ms1 = this.milestones[i + 1];
    const span = ms1.t - ms0.t;
    const localT = span > 0 ? (tClamped - ms0.t) / span : 0;

    const a = parseDate(ms0.date);
    const b = parseDate(ms1.date);
    if (!a || !b) return ms0.date;

    const numA = a.year + (a.month - 1) / 12;
    const numB = b.year + (b.month - 1) / 12;
    const num = lerp(numA, numB, localT);
    const year = Math.floor(num);
    const monthIdx = Math.floor((num - year) * 12) + 1;
    const month = clamp(monthIdx, 1, 12);
    return `${year}.${String(month).padStart(2, '0')}`;
  }

  dispose(): void {
    if (this.root.parentElement) {
      this.root.parentElement.removeChild(this.root);
    }
  }
}

function parseDate(s: string): { year: number; month: number } | null {
  const m = /^(\d{4})\.(\d{1,2})/.exec(s);
  if (!m) return null;
  return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
}
