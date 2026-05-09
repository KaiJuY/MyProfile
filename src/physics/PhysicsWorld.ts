import RAPIER from '@dimforge/rapier3d-compat';

/**
 * Rapier physics wrapper. Step 01 just initializes the world — no bodies yet.
 *
 * Why a fixed-timestep accumulator (vs. variable dt like Three.Clock-driven loops)?
 *  - Rapier's stability degrades at non-uniform dt (constraints can explode at
 *    very small dt, miss collisions at large dt). 1/60 fixed is the sweet spot.
 *  - The accumulator pattern (gafferongames classic) lets us run physics at fixed
 *    rate while rendering at whatever rate the GPU produces, with optional
 *    interpolation between physics ticks for visual smoothness.
 */

export const FIXED_TIMESTEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 5; // cap to prevent spiral-of-death after long pauses

export class PhysicsWorld {
  /** Set to true once RAPIER.init() has resolved and `world` is constructed. */
  ready: boolean = false;
  world!: RAPIER.World;
  private accumulator: number = 0;
  private readonly gravity: { x: number; y: number; z: number };

  constructor(gravity: { x: number; y: number; z: number } = { x: 0, y: -9.81, z: 0 }) {
    this.gravity = gravity;
  }

  async init(): Promise<void> {
    // RAPIER ships its WASM inlined as base64 in the -compat build, so init is
    // synchronous-ish (no separate fetch), but the API is still async because
    // the wasm instantiation itself is async on some browsers.
    await RAPIER.init();
    this.world = new RAPIER.World(this.gravity);
    this.ready = true;
    // Surface readiness to the dev console so the orchestrator can grep for it
    // in browser_console_messages during verification.
    // eslint-disable-next-line no-console
    console.log('Rapier ready');
  }

  /**
   * Step physics. Call once per RAF with the frame's variable dt; we'll consume
   * it in fixed 1/60 chunks via accumulator, capped at MAX_STEPS_PER_FRAME.
   */
  step(dt: number): void {
    if (!this.ready) return;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_TIMESTEP && steps < MAX_STEPS_PER_FRAME) {
      this.world.step();
      this.accumulator -= FIXED_TIMESTEP;
      steps += 1;
    }
    if (steps >= MAX_STEPS_PER_FRAME) {
      // Drain remaining accumulator after long stalls (tab unfocus, GC pause)
      // to prevent unbounded catch-up next frame.
      this.accumulator = 0;
    }
  }

  /** Add a rigid body. Caller is responsible for retaining the handle. */
  addRigidBody(desc: RAPIER.RigidBodyDesc): RAPIER.RigidBody {
    return this.world.createRigidBody(desc);
  }

  /** Attach a collider to a rigid body (or to the world if body is null). */
  addCollider(desc: RAPIER.ColliderDesc, body?: RAPIER.RigidBody): RAPIER.Collider {
    return this.world.createCollider(desc, body);
  }

  /**
   * Cast a ray and return the first hit collider, or null. `maxToi` is "max time
   * of impact" — basically max distance along the ray.
   */
  raycast(
    origin: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    maxToi: number = 100
  ): RAPIER.RayColliderHit | null {
    if (!this.ready) return null;
    const ray = new RAPIER.Ray(origin, dir);
    const hit = this.world.castRay(ray, maxToi, true);
    return hit;
  }

  dispose(): void {
    if (this.ready && this.world) {
      this.world.free();
      this.ready = false;
    }
  }
}
