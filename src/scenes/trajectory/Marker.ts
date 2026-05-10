import * as THREE from 'three';

/**
 * Marker — one career milestone visualization.
 *
 * Composition (playbook §4):
 *   - flat ring (TorusGeometry, thin) oriented PERPENDICULAR to the path
 *     tangent so the camera "passes through" it like a checkpoint
 *   - small sphere at the ring's center
 *   - short tick line extending UPWARD from the marker (architect's annotation)
 *   - emissive glow that brightens when the camera is within ~3 units
 *
 * The materials use MeshBasicMaterial (cheap, unlit) tinted to a restrained
 * off-white-on-dark palette. No neon. The "glow" is just a color lerp on the
 * existing material's color uniform — we don't run bloom in this section.
 *
 * Active state: when the camera's path-t is closest to this marker's t,
 * we scale the ring 1.4× and pump the color brighter (playbook footer §2 —
 * "AI 第一版常常忘記做").
 */

const RING_RADIUS = 0.45;
const RING_TUBE = 0.012;
const RING_SEGMENTS_RADIAL = 8;
const RING_SEGMENTS_TUBE = 64;
const SPHERE_RADIUS = 0.05;
const TICK_HEIGHT = 0.45;

// Wave 6: ring palette aligned with site tokens (`--ink`, `--accent`) so the
// trajectory marker reads as part of the site's identity instead of an isolated
// engineering grey. Inactive markers stay dim (off-white at 60% via opacity);
// the active ring lights up to --accent (#FF6A00) for the "checkpoint reached"
// signal.
const COLOR_BASE = new THREE.Color(0x9aa1a8);  // dim ink — passive ring
const COLOR_ACTIVE = new THREE.Color(0xff6a00); // var(--accent)
const COLOR_TICK = new THREE.Color(0x556068);  // dimmer than ring
const COLOR_GLOW = new THREE.Color(0xffb27a);  // warm halo lerp target

export interface MarkerInit {
  position: THREE.Vector3;
  /** Normalized tangent direction at this marker's curve t. */
  tangent: THREE.Vector3;
  /** Whether to enable subtle emissive-style brightness (false on mobile). */
  glowEnabled: boolean;
}

export class Marker {
  readonly group: THREE.Group;
  private readonly ringMesh: THREE.Mesh;
  private readonly sphereMesh: THREE.Mesh;
  private readonly tickLine: THREE.Line;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly sphereMat: THREE.MeshBasicMaterial;
  private readonly tickMat: THREE.LineBasicMaterial;
  private readonly glowEnabled: boolean;

  // Animation state — current values, smoothly damped each frame.
  private currentScale = 1;
  private currentColor = new THREE.Color().copy(COLOR_BASE);

  constructor(init: MarkerInit) {
    this.glowEnabled = init.glowEnabled;
    this.group = new THREE.Group();
    this.group.position.copy(init.position);

    // Orient the group so its local +Z aligns with the path tangent. This way
    // the ring (a torus aligned to the XY plane by default) becomes a
    // "checkpoint" the camera flies through. lookAt aims the group's local +Z
    // toward (position + tangent), which is exactly what we want.
    const lookTarget = init.position.clone().add(init.tangent);
    this.group.lookAt(lookTarget);

    // Ring: TorusGeometry by default lies in the XY plane (perpendicular to Z).
    // Since we just oriented the group so local +Z = tangent, this gives us
    // a ring whose plane is perpendicular to the camera's flight direction.
    const ringGeom = new THREE.TorusGeometry(
      RING_RADIUS,
      RING_TUBE,
      RING_SEGMENTS_RADIAL,
      RING_SEGMENTS_TUBE
    );
    this.ringMat = new THREE.MeshBasicMaterial({
      color: COLOR_BASE.clone(),
      transparent: true,
      opacity: 0.9,
    });
    this.ringMesh = new THREE.Mesh(ringGeom, this.ringMat);
    this.group.add(this.ringMesh);

    // Center sphere — sits at marker origin.
    const sphereGeom = new THREE.SphereGeometry(SPHERE_RADIUS, 16, 12);
    this.sphereMat = new THREE.MeshBasicMaterial({
      color: COLOR_BASE.clone(),
      transparent: true,
      opacity: 0.95,
    });
    this.sphereMesh = new THREE.Mesh(sphereGeom, this.sphereMat);
    this.group.add(this.sphereMesh);

    // Tick line: extends UPWARD in WORLD-Y from the marker. Because the group
    // is rotated to align with the tangent, "world up" inside the group is
    // not necessarily group-local +Y. We add the tick as a separate THREE.Line
    // whose vertices are in WORLD coordinates, then add it to the SceneManager
    // not the group. To keep this self-contained we instead bake the world-up
    // direction into the geometry by inverse-transforming through the group's
    // rotation. Simpler: build the line in group-local space pointing along
    // the local "up" component of world-Y after the lookAt rotation.
    //
    // Compute group-local world-up: invert group quat, apply to (0,1,0).
    const groupQuat = this.group.quaternion.clone();
    const localUp = new THREE.Vector3(0, 1, 0).applyQuaternion(
      groupQuat.invert()
    );
    // We want a tick that points in the world-up direction starting from origin.
    const tickGeom = new THREE.BufferGeometry();
    const tickEnd = localUp.clone().multiplyScalar(TICK_HEIGHT);
    tickGeom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [0, 0, 0, tickEnd.x, tickEnd.y, tickEnd.z],
        3
      )
    );
    this.tickMat = new THREE.LineBasicMaterial({
      color: COLOR_TICK.clone(),
      transparent: true,
      opacity: 0.6,
    });
    this.tickLine = new THREE.Line(tickGeom, this.tickMat);
    this.group.add(this.tickLine);
  }

  /**
   * Update marker state given current camera-path-t and the closeness of the
   * camera in world-distance units. `nearness` ∈ [0,1] where 1 = camera passing
   * directly through this marker, 0 = far away.
   * `isActive` = whether this marker is the one the camera is closest to.
   */
  update(dt: number, nearness: number, isActive: boolean): void {
    // Active marker scales up to 1.4× and shifts color toward the warm pencil
    // glow (only if glowEnabled — otherwise stays at COLOR_ACTIVE off-white).
    const targetScale = isActive ? 1.4 : 1.0;
    // Damp scale toward target for a smooth pop.
    const k = 1 - Math.exp(-8 * dt);
    this.currentScale += (targetScale - this.currentScale) * k;
    this.group.scale.setScalar(this.currentScale);

    // Color: lerp from base → active by nearness. If active AND glowEnabled,
    // additionally tint toward COLOR_GLOW.
    const baseTarget = isActive ? COLOR_ACTIVE : COLOR_BASE;
    // Build a temporary target color.
    const target = baseTarget.clone();
    if (this.glowEnabled) {
      // mix in the warm glow proportional to nearness × isActive
      const glowAmt = isActive ? nearness * 0.35 : nearness * 0.15;
      target.lerp(COLOR_GLOW, glowAmt);
    }
    // Damp current color toward target.
    this.currentColor.lerp(target, k);
    this.ringMat.color.copy(this.currentColor);
    this.sphereMat.color.copy(this.currentColor);

    // Ring opacity gets a small boost when active.
    this.ringMat.opacity = isActive ? 1.0 : 0.85;
  }

  dispose(): void {
    this.ringMesh.geometry.dispose();
    this.sphereMesh.geometry.dispose();
    this.tickLine.geometry.dispose();
    this.ringMat.dispose();
    this.sphereMat.dispose();
    this.tickMat.dispose();
  }
}
