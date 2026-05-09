import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '@physics/PhysicsWorld';

/**
 * SandboxBoundary — six invisible kinematic-position-based walls forming an
 * open box around the toolkit play area. Skill objects bounce gently off the
 * walls (restitution 0.1) so they never escape the visible window region.
 *
 * Walls are KINEMATIC (not fixed) because the box dimensions follow the HTML
 * element across resize / scroll. Each frame the toolkit scene calls
 * `setBox(center, halfW, halfH, halfD)` which rewrites the wall translations
 * via setNextKinematicTranslation. Rapier interpolates the sweep so high-speed
 * colliding skill bodies still get caught.
 *
 * Walls are EXTERNAL: their inward face sits exactly at ±halfW etc. — we
 * place each wall's center one wall-thickness OUTSIDE the box and size it
 * with a thin profile in the perpendicular axis. This way contacts read as
 * "ball touched the boundary" rather than "ball penetrated and got teleported".
 */
const WALL_THICKNESS = 0.5; // half-extent of the wall in its perpendicular axis

export class SandboxBoundary {
  private readonly physics: PhysicsWorld;
  private bodies: RAPIER.RigidBody[] = [];
  private built: boolean = false;

  constructor(physics: PhysicsWorld) {
    this.physics = physics;
  }

  /**
   * Build six walls (left/right/top/bottom/back/front) sized to the requested
   * half-extents. Initial center is (0,0,0); call setBox each frame to follow
   * the section anchor.
   */
  build(halfW: number, halfH: number, halfD: number): void {
    if (this.built || !this.physics.ready) return;

    // Wall geometry by axis: each wall is a thin slab. The order MUST match
    // the index map used in setBox below.
    const walls: Array<{ hx: number; hy: number; hz: number }> = [
      // 0: LEFT  — slab in YZ, thin in X, sitting at x = -halfW - thickness
      { hx: WALL_THICKNESS, hy: halfH + WALL_THICKNESS, hz: halfD + WALL_THICKNESS },
      // 1: RIGHT
      { hx: WALL_THICKNESS, hy: halfH + WALL_THICKNESS, hz: halfD + WALL_THICKNESS },
      // 2: BOTTOM — slab in XZ, thin in Y
      { hx: halfW + WALL_THICKNESS, hy: WALL_THICKNESS, hz: halfD + WALL_THICKNESS },
      // 3: TOP
      { hx: halfW + WALL_THICKNESS, hy: WALL_THICKNESS, hz: halfD + WALL_THICKNESS },
      // 4: BACK   — slab in XY, thin in Z
      { hx: halfW + WALL_THICKNESS, hy: halfH + WALL_THICKNESS, hz: WALL_THICKNESS },
      // 5: FRONT
      { hx: halfW + WALL_THICKNESS, hy: halfH + WALL_THICKNESS, hz: WALL_THICKNESS },
    ];

    for (const w of walls) {
      const desc = RAPIER.RigidBodyDesc.kinematicPositionBased();
      const body = this.physics.addRigidBody(desc);
      const colDesc = RAPIER.ColliderDesc.cuboid(w.hx, w.hy, w.hz)
        .setRestitution(0.1)
        .setFriction(0.4);
      this.physics.addCollider(colDesc, body);
      this.bodies.push(body);
    }
    this.built = true;
  }

  /**
   * Reposition the six walls so their inward faces enclose a box of given
   * half-extents centered at `center`. Uses setNextKinematicTranslation so
   * Rapier sweeps the motion and catches fast bodies.
   */
  setBox(
    center: { x: number; y: number; z: number },
    halfW: number,
    halfH: number,
    halfD: number
  ): void {
    if (!this.built) return;
    const t = WALL_THICKNESS;

    // 0: LEFT — center at x = cx - halfW - t
    this.bodies[0].setNextKinematicTranslation({
      x: center.x - halfW - t,
      y: center.y,
      z: center.z,
    });
    // 1: RIGHT
    this.bodies[1].setNextKinematicTranslation({
      x: center.x + halfW + t,
      y: center.y,
      z: center.z,
    });
    // 2: BOTTOM
    this.bodies[2].setNextKinematicTranslation({
      x: center.x,
      y: center.y - halfH - t,
      z: center.z,
    });
    // 3: TOP
    this.bodies[3].setNextKinematicTranslation({
      x: center.x,
      y: center.y + halfH + t,
      z: center.z,
    });
    // 4: BACK
    this.bodies[4].setNextKinematicTranslation({
      x: center.x,
      y: center.y,
      z: center.z - halfD - t,
    });
    // 5: FRONT
    this.bodies[5].setNextKinematicTranslation({
      x: center.x,
      y: center.y,
      z: center.z + halfD + t,
    });
  }

  dispose(): void {
    if (!this.physics.ready) return;
    for (const b of this.bodies) {
      try {
        this.physics.world.removeRigidBody(b);
      } catch {
        // Rapier already cleaned up — ignore.
      }
    }
    this.bodies.length = 0;
    this.built = false;
  }
}
