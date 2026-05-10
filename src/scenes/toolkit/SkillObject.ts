import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Text } from 'troika-three-text';
import type { PhysicsWorld } from '@physics/PhysicsWorld';
import { createSkillText } from './msdfText';
import {
  TOOLKIT_STENCIL_REF,
  TOOLKIT_RENDER_ORDER_OBJECT,
  TOOLKIT_RENDER_ORDER_LABEL,
} from './SandboxWindow';

/**
 * Geometry vocabulary for skills — different shapes for different vibes.
 * Sized so each fits roughly inside a sphere of radius 0.5 → uniform ball
 * collider radius for physics simplicity.
 */
export type SkillGeometry =
  | 'octahedron'
  | 'rounded_cube'
  | 'tetrahedron'
  | 'icosahedron'
  | 'torus'
  | 'cylinder';

/**
 * Build geometry for a skill. Sizes target a ~0.55 unit "outer radius" so the
 * ball collider (radius 0.5) approximates the visual silhouette without too
 * much air-gap on contact.
 */
function buildSkillGeometry(kind: SkillGeometry): THREE.BufferGeometry {
  switch (kind) {
    case 'octahedron':
      return new THREE.OctahedronGeometry(0.55, 0);
    case 'rounded_cube':
      // Three doesn't ship a rounded box natively; use BoxGeometry with light
      // bevel via segment subdivision is overkill — a plain box reads well at
      // this size. Slight subdivisions help shading on the matcap.
      return new THREE.BoxGeometry(0.85, 0.85, 0.85, 2, 2, 2);
    case 'tetrahedron':
      return new THREE.TetrahedronGeometry(0.7, 0);
    case 'icosahedron':
      return new THREE.IcosahedronGeometry(0.55, 0);
    case 'torus':
      return new THREE.TorusGeometry(0.42, 0.16, 16, 32);
    case 'cylinder':
      return new THREE.CylinderGeometry(0.45, 0.45, 0.7, 24, 1);
  }
}

/** Static descriptor for a single skill. */
export interface SkillDescriptor {
  id: string;
  label: string; // e.g. "C# / .NET"
  /** Display angle (degrees). 0 means "no angle" → falls back to upright tilt. */
  angle: number;
  /** Whether the angle is meaningful (e.g. "—" placeholder maps to NaN). */
  hasAngle: boolean;
  geometry: SkillGeometry;
  /** Index 0..7; used for grid layout when physics is off. */
  index: number;
}

/** Tunable physics constants. Exposed here so ToolkitScene can also reference. */
export const SKILL_CONSTANTS = {
  /** Mass of each skill body. */
  MASS: 1.0,
  /** Linear damping (Rapier built-in). Higher = stops faster. */
  LINEAR_DAMPING: 1.5,
  /** Angular damping. */
  ANGULAR_DAMPING: 1.5,
  /** Ball-collider radius. Matches roughly to bounding sphere of geometries. */
  COLLIDER_RADIUS: 0.5,
  /** Restitution between skill bodies. Low → no bouncy chaos. */
  RESTITUTION: 0.15,
};

/**
 * SkillObject — one physics body + visible mesh + world-space MSDF label.
 *
 * The mesh is a child of an outer "tilt holder" group that bakes the skill's
 * angle into a permanent X-axis rotation. The PHYSICS body's rotation is
 * applied to the holder; the mesh inside is then offset by the angle. That
 * way the rigid body free-rotates in physics-space (so contacts work
 * naturally) while the visible mesh always reads the angle as "9° forward
 * tilt" relative to its current orientation.
 *
 * UPDATE — that approach makes the angle relative-to-self (rotates with the
 * body), which loses readability as the body tumbles. Per playbook §3 we
 * actually want a TORQUE toward upright + initial tilt by angle. The compromise:
 *   - On creation, set the body's rotation to a quaternion = angle around X.
 *   - Each frame, ToolkitScene applies a torque toward "upright = angle on X".
 *   - The mesh just mirrors the body — no holder needed.
 *
 * Labels billboard around Y so they stay readable from camera. They sit at
 * +0.85 above the body so they don't get swallowed by the mesh.
 */
export class SkillObject {
  readonly desc: SkillDescriptor;
  readonly mesh: THREE.Mesh;
  readonly label: Text;
  readonly material: THREE.MeshLambertMaterial;
  body?: RAPIER.RigidBody;
  /** Home position inside the sandbox (used for attractive force). */
  home: THREE.Vector3 = new THREE.Vector3();
  /** Reusable scratch for label billboarding. */
  private tmp = new THREE.Vector3();

  constructor(desc: SkillDescriptor) {
    this.desc = desc;

    // 1. Geometry + material. Lambert reads as a clean monochrome under the
    //    shared scene lights (we lean on WorkScene's lighting if present, and
    //    add fallbacks here when toolkit is the only mounted scene). No matcap
    //    here intentionally — matcap UV doesn't play well with the per-face
    //    octa/icosa silhouettes; lambert + edge fresnel-via-rim looks crisper.
    const geom = buildSkillGeometry(desc.geometry);
    this.material = new THREE.MeshLambertMaterial({
      color: 0xc7cdd1, // restrained off-white-grey, monochrome aesthetic
      emissive: 0x0a0a0a,
      emissiveIntensity: 0.18,
      flatShading: true, // play well with low-poly geometries
    });
    // Stencil setup — clip to ref = 2 written by SandboxWindow.
    this.material.stencilWrite = true;
    this.material.stencilFunc = THREE.EqualStencilFunc;
    this.material.stencilRef = TOOLKIT_STENCIL_REF;
    this.material.stencilZPass = THREE.KeepStencilOp;
    this.material.stencilFail = THREE.KeepStencilOp;
    this.material.stencilZFail = THREE.KeepStencilOp;
    this.material.stencilFuncMask = 0xff;
    this.material.stencilWriteMask = 0x00; // don't overwrite ref=2

    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.renderOrder = TOOLKIT_RENDER_ORDER_OBJECT;
    this.mesh.frustumCulled = false;

    // 2. Label. troika-three-text manages its own MSDF atlas.
    const labelText = desc.hasAngle
      ? `${desc.label} · ${desc.angle}°`
      : desc.label;
    this.label = createSkillText({ text: labelText, fontSize: 0.13 });
    this.label.renderOrder = TOOLKIT_RENDER_ORDER_LABEL;
    // Labels are NOT stencil-clipped — they always show even when overflow
    // outside the rounded-rect window. (Playbook §7.)
    // Troika builds its own material per-Text on first sync(); we patch
    // after sync via .material — but the simplest path is to leave it as-is
    // (default troika material has stencilWrite undefined → false).
    this.label.frustumCulled = false;
  }

  /**
   * Initialise physics. Call once after constructor.
   */
  initPhysics(physics: PhysicsWorld, home: THREE.Vector3): void {
    if (!physics.ready) return;
    this.home.copy(home);

    // Initial quaternion = angle (rad) around X-axis so the geometry visibly
    // tilts to match the TrackMan-style number. Skills with hasAngle=false
    // (the "—" item) start upright.
    const angleRad = this.desc.hasAngle ? (this.desc.angle * Math.PI) / 180 : 0;
    const halfAngle = angleRad * 0.5;
    const quat = {
      x: Math.sin(halfAngle), // axis = (1,0,0)
      y: 0,
      z: 0,
      w: Math.cos(halfAngle),
    };

    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(home.x, home.y, home.z)
      .setRotation(quat)
      .setLinearDamping(SKILL_CONSTANTS.LINEAR_DAMPING)
      .setAngularDamping(SKILL_CONSTANTS.ANGULAR_DAMPING)
      .setGravityScale(0); // float, no gravity (per playbook hardcoded list)
    this.body = physics.addRigidBody(desc);

    const colDesc = RAPIER.ColliderDesc.ball(SKILL_CONSTANTS.COLLIDER_RADIUS)
      .setRestitution(SKILL_CONSTANTS.RESTITUTION)
      .setFriction(0.4)
      // Density derived from desired mass: m = (4/3)πr³ * ρ.
      .setDensity(
        SKILL_CONSTANTS.MASS / ((4 / 3) * Math.PI * SKILL_CONSTANTS.COLLIDER_RADIUS ** 3)
      );
    physics.addCollider(colDesc, this.body);
  }

  /**
   * Place at fixed home position (no physics) — used by mobile fallback and
   * by initial setup before physics has produced a frame.
   */
  setStaticPose(home: THREE.Vector3): void {
    this.home.copy(home);
    this.mesh.position.copy(home);
    if (this.desc.hasAngle) {
      this.mesh.rotation.set((this.desc.angle * Math.PI) / 180, 0, 0);
    }
    // Place label above mesh.
    this.label.position.set(home.x, home.y + 0.85, home.z);
  }

  /**
   * Sync mesh + label from physics body each frame. Called by ToolkitScene.
   * @param updateLabelRotation when false, skip the (relatively expensive)
   *   yaw recompute. Camera barely moves between frames in #bag (only a tiny
   *   ContactScene tilt much later in the page), so updating yaw at half-rate
   *   is visually identical and cuts the per-skill cost in half on the
   *   throttled frames.
   */
  syncFromBody(camera: THREE.PerspectiveCamera, updateLabelRotation: boolean = true): void {
    if (!this.body) return;
    const t = this.body.translation();
    const r = this.body.rotation();
    this.mesh.position.set(t.x, t.y, t.z);
    this.mesh.quaternion.set(r.x, r.y, r.z, r.w);

    // Label: above the body, billboard around Y to face camera. (Per playbook
    // §7: text always faces camera so it's readable.)
    this.label.position.set(t.x, t.y + 0.85, t.z);

    if (!updateLabelRotation) return;

    // Y-only billboard: compute yaw from camera direction, ignore pitch.
    this.tmp.subVectors(camera.position, this.label.position);
    this.tmp.y = 0;
    if (this.tmp.lengthSq() < 1e-6) return;
    this.tmp.normalize();
    // atan2 gives yaw such that label's -Z axis points at the camera.
    const yaw = Math.atan2(this.tmp.x, this.tmp.z);
    this.label.rotation.set(0, yaw, 0);
  }

  /**
   * Update label position only (mobile path — no physics).
   */
  syncStaticLabel(camera: THREE.PerspectiveCamera): void {
    this.label.position.set(this.mesh.position.x, this.mesh.position.y + 0.85, this.mesh.position.z);
    this.tmp.subVectors(camera.position, this.label.position);
    this.tmp.y = 0;
    if (this.tmp.lengthSq() < 1e-6) return;
    this.tmp.normalize();
    const yaw = Math.atan2(this.tmp.x, this.tmp.z);
    this.label.rotation.set(0, yaw, 0);
  }

  /**
   * Compute the desired-upright quaternion (angle around X) into `out`.
   * ToolkitScene calls this each frame to derive a torque that nudges the
   * body back toward "tilt visibly matches the displayed angle".
   */
  desiredQuat(out: THREE.Quaternion): void {
    const angleRad = this.desc.hasAngle ? (this.desc.angle * Math.PI) / 180 : 0;
    out.setFromAxisAngle(new THREE.Vector3(1, 0, 0), angleRad);
  }

  /** Quaternion currently held by body, as Three.Quaternion. */
  currentQuat(out: THREE.Quaternion): void {
    if (!this.body) {
      out.identity();
      return;
    }
    const r = this.body.rotation();
    out.set(r.x, r.y, r.z, r.w);
  }

  dispose(scene: THREE.Scene, physics: PhysicsWorld | null): void {
    scene.remove(this.mesh);
    scene.remove(this.label);
    this.mesh.geometry.dispose();
    this.material.dispose();
    // troika cleans GPU resources via its own dispose method.
    this.label.dispose();
    if (this.body && physics?.ready) {
      try {
        physics.world.removeRigidBody(this.body);
      } catch {
        // ignore
      }
      this.body = undefined;
    }
  }
}
