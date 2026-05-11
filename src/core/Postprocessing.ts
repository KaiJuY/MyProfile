import * as THREE from 'three';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  ChromaticAberrationEffect,
  NoiseEffect,
  ToneMappingEffect,
  ToneMappingMode,
  KernelSize,
  BlendFunction,
} from 'postprocessing';

import type { ViewportSize } from './ResizeObserver';
import type { UserPrefs } from './UserPrefs';

/**
 * Step 08 — Postprocessing pipeline.
 *
 * Pipeline (HIGH quality):
 *   RenderPass → EffectPass(Bloom + ChromaticAberration + Noise + ToneMapping)
 *
 * Quality levels:
 *   HIGH    — full pipeline (default desktop)
 *   MEDIUM  — RenderPass + Bloom only
 *   LOW     — direct renderer.render() (no composer)
 *
 * Auto-detect:
 *   isMobile → LOW
 *   reducedMotion → LOW (heavy postprocessing IS visual motion at idle)
 *   else → HIGH, but downgrade to MEDIUM if avg FPS < 50 over 5s
 *
 * Stencil compatibility (CRITICAL — HeroScene + ToolkitScene rely on stencil):
 *   The `postprocessing` package's EffectComposer uses its own offscreen
 *   render targets but inherits stencil format from the renderer. We construct
 *   the composer with `stencilBuffer: true` on its render targets and verify
 *   `renderer.autoClearStencil` is true (default). HeroScene's mask renders
 *   each frame and is reset between frames — same behaviour with composer.
 *
 * Manual toggle: small bottom-right HTML button cycles HIGH→MEDIUM→LOW.
 */

export type QualityLevel = 'high' | 'medium' | 'low';

const FPS_WINDOW_S = 5;
const FPS_DOWNGRADE_THRESHOLD = 50;
// Auto-upgrade from MEDIUM → HIGH if sustained ≥55fps over 3s.
const FPS_UPGRADE_WINDOW_S = 3;
const FPS_UPGRADE_THRESHOLD = 55;
// Auto-downgrade from MEDIUM → LOW if sustained <40fps over 5s.
const FPS_LOW_DOWNGRADE_THRESHOLD = 40;

export class Postprocessing {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private prefs: UserPrefs;

  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private bloomEffect: BloomEffect | null = null;
  private effectPassFull: EffectPass | null = null;
  private effectPassBloomOnly: EffectPass | null = null;

  private current: QualityLevel = 'low';

  // FPS sampling for auto-downgrade / auto-upgrade.
  private fpsSamples: number[] = [];
  private fpsAccumDt = 0;
  /** True if user has manually overridden quality (or auto-downgrade fired). */
  private manualOverride = false;
  /** True once we've upgraded MEDIUM → HIGH automatically (don't re-upgrade). */
  private autoUpgradedToHigh = false;

  // UI toggle
  private toggleBtn: HTMLButtonElement | null = null;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    prefs: UserPrefs
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.prefs = prefs;
  }

  init(): void {
    // FX quality LOCKED at LOW for all platforms (desktop + mobile).
    // `manualOverride = true` disables the FPS-based auto-promotion path
    // inside render() so the level can't drift back up to MEDIUM/HIGH even
    // if FPS is sustained high. Manual toggle button still works for
    // ad-hoc inspection — the lock applies to automatic behavior only.
    //
    // qualityOverride from prefs still takes precedence if set (e.g.
    // `?quality=high` URL param) so power users can opt out.
    const initial: QualityLevel = this.prefs.qualityOverride ?? 'low';
    this.manualOverride = true;
    this.setQuality(initial);
    this.injectToggle();
  }

  /** Build composer + passes lazily on first non-low quality activation. */
  private buildComposerIfNeeded(): void {
    if (this.composer) return;

    // EffectComposer with stencil-aware render targets so HeroScene and
    // ToolkitScene's stencil masking still works through the post pipeline.
    // Multisampling: when rendering to an FBO the renderer's `antialias: true`
    // is bypassed; we re-enable it via composer multisampling. 4 samples is
    // a sweet spot for visible AA without tanking perf on integrated GPUs.
    const maxSamples = this.renderer.capabilities.isWebGL2
      ? this.renderer.capabilities.maxSamples
      : 0;
    this.composer = new EffectComposer(this.renderer, {
      stencilBuffer: true,
      depthBuffer: true,
      // HalfFloatType is the postprocessing default but explicit is good for
      // iOS Safari where Float32 textures are flaky.
      frameBufferType: THREE.HalfFloatType,
      multisampling: Math.min(4, maxSamples),
    });

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    // Bloom — only emissive elements bleed (luminanceThreshold high so the
    // pearl ball + matcap material stay restrained).
    this.bloomEffect = new BloomEffect({
      intensity: 0.4,
      radius: 0.5,
      luminanceThreshold: 0.7,
      luminanceSmoothing: 0.05,
      kernelSize: KernelSize.MEDIUM,
      mipmapBlur: true,
    });

    const ca = new ChromaticAberrationEffect({
      // Subtle — playbook explicitly says "barely perceptible".
      offset: new THREE.Vector2(0.0008, 0.0008),
      // Disable radial modulation — uniform offset feels more "cinematic film".
      radialModulation: false,
      modulationOffset: 0,
    });

    const noise = new NoiseEffect({
      premultiply: true,
      blendFunction: BlendFunction.OVERLAY,
    });
    // Intensity = blend opacity. The Effect base class exposes `blendMode`
    // whose `opacity` uniform we tweak directly.
    noise.blendMode.opacity.value = 0.05;

    const tone = new ToneMappingEffect({
      mode: ToneMappingMode.ACES_FILMIC,
    });

    this.effectPassFull = new EffectPass(this.camera, this.bloomEffect, ca, noise, tone);
    this.effectPassBloomOnly = new EffectPass(this.camera, this.bloomEffect, tone);

    // Both passes added but only one is enabled at a time. Cheap.
    this.composer.addPass(this.effectPassFull);
    this.composer.addPass(this.effectPassBloomOnly);
    this.effectPassFull.enabled = false;
    this.effectPassBloomOnly.enabled = false;
  }

  /** Set quality. Cycles UI button label. */
  setQuality(q: QualityLevel): void {
    this.current = q;
    if (q === 'low') {
      // Tear-down by simply not calling composer.render — no need to dispose
      // (we may switch back). Do disable passes to keep things clean.
      if (this.effectPassFull) this.effectPassFull.enabled = false;
      if (this.effectPassBloomOnly) this.effectPassBloomOnly.enabled = false;
    } else {
      this.buildComposerIfNeeded();
      if (q === 'medium') {
        if (this.effectPassFull) this.effectPassFull.enabled = false;
        if (this.effectPassBloomOnly) this.effectPassBloomOnly.enabled = true;
      } else {
        if (this.effectPassFull) this.effectPassFull.enabled = true;
        if (this.effectPassBloomOnly) this.effectPassBloomOnly.enabled = false;
      }
    }
    this.updateToggleLabel();
  }

  getQuality(): QualityLevel {
    return this.current;
  }

  /** Render. Called once per RAF in lieu of `renderer.render`. */
  render(dt: number): void {
    if (this.current === 'low' || !this.composer) {
      this.renderer.render(this.scene, this.camera);
    } else {
      this.composer.render(dt);
    }
    // Auto quality detection. Skipped when:
    //  - prefs override forces a specific level
    //  - user manually clicked the toggle (sticky from then on)
    //  - dt is bogus (paused tab returning)
    if (
      !this.manualOverride &&
      !this.prefs.qualityOverride &&
      dt > 0
    ) {
      const fps = 1 / dt;
      this.fpsSamples.push(fps);
      this.fpsAccumDt += dt;
      if (this.fpsSamples.length > 600) this.fpsSamples.shift();

      // Window varies by direction we're testing (3s for upgrade, 5s for downgrade).
      const window =
        this.current === 'medium' && !this.autoUpgradedToHigh
          ? FPS_UPGRADE_WINDOW_S
          : FPS_WINDOW_S;
      if (this.fpsAccumDt >= window) {
        const avg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;

        if (this.current === 'high' && avg < FPS_DOWNGRADE_THRESHOLD) {
          // HIGH → MEDIUM (legacy path, for users who flipped to HIGH manually
          // before the rule fired, or for the upgrade-then-can't-sustain case).
          this.manualOverride = true;
          // eslint-disable-next-line no-console
          console.log(`[postprocessing] auto-downgrade HIGH→MEDIUM (avg fps ${avg.toFixed(1)})`);
          this.setQuality('medium');
        } else if (this.current === 'medium' && avg < FPS_LOW_DOWNGRADE_THRESHOLD) {
          // MEDIUM → LOW when sustained <40fps over 5s.
          this.manualOverride = true;
          // eslint-disable-next-line no-console
          console.log(`[postprocessing] auto-downgrade MEDIUM→LOW (avg fps ${avg.toFixed(1)})`);
          this.setQuality('low');
        } else if (
          this.current === 'medium' &&
          !this.autoUpgradedToHigh &&
          avg >= FPS_UPGRADE_THRESHOLD
        ) {
          // MEDIUM → HIGH after sustained ≥55fps for 3s.
          this.autoUpgradedToHigh = true;
          // eslint-disable-next-line no-console
          console.log(`[postprocessing] auto-upgrade MEDIUM→HIGH (avg fps ${avg.toFixed(1)})`);
          this.setQuality('high');
        }

        // Reset window for next observation.
        this.fpsSamples = [];
        this.fpsAccumDt = 0;
      }
    }
  }

  resize(size: ViewportSize): void {
    if (this.composer) {
      this.composer.setSize(size.width, size.height);
    }
  }

  /**
   * Force a one-frame off-screen render to trigger shader compilation. Useful
   * for the loader's "COMPILE SHADERS" step — runs after all scenes registered
   * so every program needed for first-paint is hot.
   */
  warmShaders(): void {
    // renderer.compile() is the canonical Three API for this; it walks the
    // scene graph and uploads programs for every material it finds.
    this.renderer.compile(this.scene, this.camera);
  }

  /** Inject a small bottom-right toggle button. Hidden if quality is forced. */
  private injectToggle(): void {
    if (this.prefs.qualityOverride) return;
    const btn = document.createElement('button');
    btn.id = 'pp-quality-toggle';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Visual quality');
    Object.assign(btn.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      zIndex: '60', // above canvas (z=2) + nav (z=50)
      padding: '6px 10px',
      background: 'rgba(7, 8, 10, 0.6)',
      color: 'rgba(243, 239, 232, 0.7)',
      border: '1px solid rgba(243, 239, 232, 0.15)',
      borderRadius: '2px',
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: '10px',
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      cursor: 'pointer',
      backdropFilter: 'blur(6px)',
    });
    btn.addEventListener('click', () => {
      const next: QualityLevel =
        this.current === 'high' ? 'medium' : this.current === 'medium' ? 'low' : 'high';
      // Manual toggle disables auto quality decisions for the rest of the session.
      this.manualOverride = true;
      this.setQuality(next);
    });
    document.body.appendChild(btn);
    this.toggleBtn = btn;
    this.updateToggleLabel();
  }

  private updateToggleLabel(): void {
    if (!this.toggleBtn) return;
    this.toggleBtn.textContent = `FX · ${this.current.toUpperCase()}`;
  }

  dispose(): void {
    if (this.composer) {
      this.composer.dispose();
      this.composer = null;
    }
    if (this.toggleBtn && this.toggleBtn.parentElement) {
      this.toggleBtn.parentElement.removeChild(this.toggleBtn);
    }
  }
}
