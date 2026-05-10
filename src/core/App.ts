import { Renderer } from './Renderer';
import { Camera } from './Camera';
import { Clock } from './Clock';
import { WindowResizeBroadcaster } from './ResizeObserver';
import { ScrollManager } from './ScrollManager';
import { SceneManager } from '@scenes/SceneManager';
import { HeroScene } from '@scenes/HeroScene';
import { FlythroughScene } from '@scenes/flythrough/FlythroughScene';
import { WorkScene } from '@scenes/work/WorkScene';
import { TrajectoryScene } from '@scenes/trajectory/TrajectoryScene';
import { ContactScene } from '@scenes/contact/ContactScene';
import { disposeSharedGolfBallAssets } from '@scenes/shared/golfBall';
import { disposeSharedTeeAssets } from '@scenes/shared/tee';
import { PhysicsWorld } from '@physics/PhysicsWorld';
import { assertDefined } from '@utils/assert';
import { getUserPrefs, type UserPrefs } from './UserPrefs';
import { Loader } from './Loader';
import { Postprocessing } from './Postprocessing';
import { FPSCounter } from './FPSCounter';

/**
 * The application root. Owns the renderer, camera, scenes, scroll, physics, and
 * the RAF loop. One instance per page; exposed as window.app in dev for
 * orchestrator verification (window.scrollManager etc).
 *
 * Boot sequence (post step 08 — Loader gate):
 *  1. detect prefs (mobile / reduced-motion / debug / nogate / quality override)
 *  2. mount Loader overlay synchronously
 *  3. construct subsystems (renderer + camera) — flips loader.markDone('webgl')
 *  4. wait for matcap PNG to load (mark 'matcap')
 *  5. await Rapier WASM (mark 'physics')
 *  6. register scenes (tick 'scenes' per registration)
 *  7. compile shaders via Postprocessing.warmShaders (mark 'shaders')
 *  8. wait for user click (or auto-dismiss in nogate mode)
 *  9. start RAF render loop (with composer)
 */
export class App {
  readonly resize: WindowResizeBroadcaster;
  readonly renderer: Renderer;
  readonly camera: Camera;
  readonly clock: Clock;
  readonly scrollManager: ScrollManager;
  readonly sceneManager: SceneManager;
  readonly physics: PhysicsWorld;
  readonly userPrefs: UserPrefs;
  readonly loader: Loader;
  readonly postprocessing: Postprocessing;
  readonly fpsCounter: FPSCounter | null;

  qualityLevel: 'high' | 'medium' | 'low' = 'low';

  private rafHandle: number = -1;
  private running: boolean = false;

  constructor(canvas: HTMLCanvasElement) {
    this.userPrefs = getUserPrefs();
    this.loader = new Loader(this.userPrefs.noGate);
    this.loader.mount();

    this.resize = new WindowResizeBroadcaster();
    const initialSize = this.resize.getSize();
    this.renderer = new Renderer(canvas);
    this.renderer.resize(initialSize);
    // WebGL context just constructed — flip the first loader chip immediately.
    this.loader.markDone('webgl');

    this.camera = new Camera(initialSize);
    this.clock = new Clock();
    this.scrollManager = new ScrollManager();
    this.sceneManager = new SceneManager();
    this.physics = new PhysicsWorld();

    // Postprocessing wraps the renderer + scene + camera. We construct here
    // (cheap — composer is built lazily inside) so resize-broadcast can target it.
    this.postprocessing = new Postprocessing(
      this.renderer.three,
      this.sceneManager.scene,
      this.camera.three,
      this.userPrefs
    );

    this.fpsCounter = this.userPrefs.debug ? new FPSCounter() : null;

    // Wire resize → renderer + camera + composer.
    this.resize.subscribe((size) => {
      this.renderer.resize(size);
      this.camera.resize(size);
      this.postprocessing.resize(size);
    });

    // Pre-load the matcap PNG so the loader can flip 'matcap' early. The
    // HeroScene + ContactScene each call their own TextureLoader.load() which
    // re-reads from cache — this fetch is just for loader feedback.
    this.preloadMatcap();
  }

  private preloadMatcap(): void {
    // Use Image() rather than THREE.TextureLoader so we can listen to onload
    // without binding a Three texture lifecycle to the loader.
    const img = new Image();
    img.onload = () => this.loader.markDone('matcap');
    img.onerror = () => this.loader.markDone('matcap'); // don't hang on 404
    img.src = '/textures/matcap-pearl.png';
    // If the browser already had it cached (HMR reload), `complete` may be true
    // before the listener is attached. Guard:
    if (img.complete && img.naturalWidth > 0) {
      this.loader.markDone('matcap');
    }
  }

  async start(): Promise<void> {
    // 1. Init Rapier first — physics needs to be ready before any scene module
    //    that adds bodies.
    await this.physics.init();
    this.loader.markDone('physics');

    // 2. Register scenes — tick the BUILD SCENES weighted bar per scene.
    await this.sceneManager.register(
      new HeroScene(
        this.camera.three,
        this.physics,
        this.renderer.three.domElement,
        this.scrollManager
      )
    );
    this.loader.tick('scenes');

    await this.sceneManager.register(
      new FlythroughScene(this.camera.three, this.scrollManager)
    );
    this.loader.tick('scenes');

    await this.sceneManager.register(
      new WorkScene(this.camera.three, this.scrollManager)
    );
    this.loader.tick('scenes');

    await this.sceneManager.register(
      new TrajectoryScene(this.camera.three, this.scrollManager)
    );
    this.loader.tick('scenes');

    await this.sceneManager.register(
      new ContactScene(this.camera.three, this.scrollManager, this.physics)
    );
    this.loader.tick('scenes');

    // 3. Initialize postprocessing pipeline now that scenes are registered.
    this.postprocessing.init();
    this.qualityLevel = this.postprocessing.getQuality();

    // 4. Force one off-screen compile of every scene material so the first
    //    visible frame doesn't stutter on shader-program upload.
    this.postprocessing.warmShaders();
    this.loader.markDone('shaders');

    // 5. Mount FPS counter if ?debug=1.
    if (this.fpsCounter) this.fpsCounter.mount();

    // 6. Wait for user click (or auto-dismiss in nogate mode).
    await this.loader.whenDismissed();

    // 7. Begin RAF.
    this.running = true;
    const loop = (nowMs: number): void => {
      if (!this.running) return;
      const dt = this.clock.tick(nowMs);
      // Perf gate: physics is only needed when a physics-using scene is in
      // viewport. Hero is always at the top (scrollProgress < 0.15), Contact
      // owns #contact (drop animation is gsap-driven but also touches Rapier
      // kinematic bodies during play). The Toolkit physics sandbox was removed
      // in wave-04, so #bag no longer needs physics stepping.
      if (this.shouldStepPhysics()) {
        this.physics.step(dt);
      }
      this.sceneManager.update(dt, this.scrollManager.scrollProgress);
      this.postprocessing.render(dt);
      this.qualityLevel = this.postprocessing.getQuality();
      if (this.fpsCounter) this.fpsCounter.tick(dt);
      this.rafHandle = requestAnimationFrame(loop);
    };
    this.rafHandle = requestAnimationFrame(loop);
  }

  /**
   * Decide whether to advance physics this frame. We avoid stepping when no
   * physics consumer is in or near viewport — Rapier's world.step() is a
   * non-trivial cost even with zero contacts (constraint solver, broad-phase,
   * island bookkeeping).
   */
  private shouldStepPhysics(): boolean {
    // Hero region (always at top of doc).
    if (this.scrollManager.scrollProgress < 0.15) return true;
    // Contact: only when section is engaged enough to play the drop.
    const contact = this.scrollManager.sectionProgress('contact');
    if (contact > 0 && contact < 1.15) return true;
    return false;
  }

  stop(): void {
    this.running = false;
    if (this.rafHandle !== -1) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = -1;
    }
  }

  dispose(): void {
    this.stop();
    this.sceneManager.dispose();
    // Free the shared GLB golf-ball geometry now that all consuming scenes
    // are torn down (Hero + Flythrough + Contact all reference the same
    // cached geom). Tee geometry is shared between Flythrough and any
    // future tee consumers.
    disposeSharedGolfBallAssets();
    disposeSharedTeeAssets();
    this.scrollManager.destroy();
    this.physics.dispose();
    this.postprocessing.dispose();
    if (this.fpsCounter) this.fpsCounter.dispose();
    this.renderer.dispose();
    this.resize.dispose();
  }
}

/**
 * Bootstraps the App. Returns the app instance after all scenes registered
 * (RAF starts after the loader gate dismisses).
 */
export async function bootApp(): Promise<App> {
  const canvas = assertDefined(
    document.getElementById('gl') as HTMLCanvasElement | null,
    '<canvas id="gl"> not found in DOM'
  );
  // Mark canvas decorative — screen readers should skip it.
  canvas.setAttribute('aria-hidden', 'true');
  const app = new App(canvas);
  await app.start();
  return app;
}
