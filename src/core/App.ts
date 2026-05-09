import { Renderer } from './Renderer';
import { Camera } from './Camera';
import { Clock } from './Clock';
import { WindowResizeBroadcaster } from './ResizeObserver';
import { ScrollManager } from './ScrollManager';
import { SceneManager } from '@scenes/SceneManager';
import { TestCube } from '@scenes/TestCube';
import { PhysicsWorld } from '@physics/PhysicsWorld';
import { assertDefined } from '@utils/assert';

/**
 * The application root. Owns the renderer, camera, scenes, scroll, physics, and
 * the RAF loop. One instance per page; exposed as window.app in dev for
 * orchestrator verification (window.scrollManager etc).
 *
 * Boot sequence:
 *  1. Construct subsystems synchronously (renderer, camera, scenes, scroll)
 *  2. Wait for Rapier WASM to init (async)
 *  3. Register scene modules
 *  4. Start RAF
 */
export class App {
  readonly resize: WindowResizeBroadcaster;
  readonly renderer: Renderer;
  readonly camera: Camera;
  readonly clock: Clock;
  readonly scrollManager: ScrollManager;
  readonly sceneManager: SceneManager;
  readonly physics: PhysicsWorld;
  private rafHandle: number = -1;
  private running: boolean = false;

  constructor(canvas: HTMLCanvasElement) {
    this.resize = new WindowResizeBroadcaster();
    const initialSize = this.resize.getSize();
    this.renderer = new Renderer(canvas);
    this.renderer.resize(initialSize);
    this.camera = new Camera(initialSize);
    this.clock = new Clock();
    this.scrollManager = new ScrollManager();
    this.sceneManager = new SceneManager();
    this.physics = new PhysicsWorld();

    // Wire resize → renderer + camera. Single subscriber, two callees.
    this.resize.subscribe((size) => {
      this.renderer.resize(size);
      this.camera.resize(size);
    });
  }

  async start(): Promise<void> {
    // Init Rapier first — physics needs to be ready before any scene module that
    // adds bodies. Step 01 has no bodies, but the discipline is set here.
    await this.physics.init();

    // Register scene modules. TestCube is the only one for step 01.
    await this.sceneManager.register(new TestCube(this.camera.three, 5));

    // Begin RAF
    this.running = true;
    const loop = (nowMs: number): void => {
      if (!this.running) return;
      const dt = this.clock.tick(nowMs);
      this.physics.step(dt);
      this.sceneManager.update(dt, this.scrollManager.scrollProgress);
      this.renderer.render(this.sceneManager.scene, this.camera.three);
      this.rafHandle = requestAnimationFrame(loop);
    };
    this.rafHandle = requestAnimationFrame(loop);
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
    this.scrollManager.destroy();
    this.physics.dispose();
    this.renderer.dispose();
    this.resize.dispose();
  }
}

/**
 * Bootstraps the App. Returns the app instance after Rapier has initialized.
 */
export async function bootApp(): Promise<App> {
  const canvas = assertDefined(
    document.getElementById('gl') as HTMLCanvasElement | null,
    '<canvas id="gl"> not found in DOM'
  );
  const app = new App(canvas);
  await app.start();
  return app;
}
