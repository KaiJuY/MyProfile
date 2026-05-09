import * as THREE from 'three';
import type { WorkObject } from '../WorkObject';

/**
 * PRJ_01 EFEM Automation — two interlocking gears that spin continuously in
 * opposite directions. The smaller gear's rotation rate is the larger gear's
 * rate × (largeTeeth / smallTeeth) so the meshing reads as kinematically
 * locked. Spin is wall-clock (always-on) — scrollProgress only fades the
 * group's opacity in/out.
 *
 * Visual budget: 2 meshes. Each gear is one ExtrudeGeometry from a star-shape
 * Path — single draw call per gear (2 total).
 */

const PALETTE_GEAR = 0xe2e7ec;       // bright cool gray — visible on dark page bg
const PALETTE_GEAR_DARK = 0x9aa7b3;  // mid-gray hub for tonal separation

/** Build a star-toothed flat shape (gear silhouette) with `teeth` teeth. */
function buildGearShape(
  outerR: number,
  innerR: number,
  teeth: number,
  toothDepth: number
): THREE.Shape {
  const shape = new THREE.Shape();
  const tipR = outerR;
  const valleyR = outerR - toothDepth;
  const step = (Math.PI * 2) / (teeth * 2);
  for (let i = 0; i < teeth * 2; i++) {
    const r = i % 2 === 0 ? tipR : valleyR;
    const a = i * step;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  // Hole for hub.
  const hole = new THREE.Path();
  hole.absellipse(0, 0, innerR, innerR, 0, Math.PI * 2, false, 0);
  shape.holes.push(hole);
  return shape;
}

export class EfemGear implements WorkObject {
  readonly name = 'efem-gear';
  private group!: THREE.Group;
  private gearLarge!: THREE.Mesh;
  private gearSmall!: THREE.Mesh;
  private materials: THREE.Material[] = [];
  private mounted = false;
  // Wall-clock spin angle (radians) on the LARGE gear; small follows by ratio.
  private angleLarge = 0;
  // Scroll-driven opacity fade.
  private opacity = 0;

  // Tooth counts chosen so gears don't overlap and ratio is satisfying.
  private static readonly TEETH_LARGE = 16;
  private static readonly TEETH_SMALL = 10;

  init(): void {
    this.group = new THREE.Group();
    this.group.name = 'EfemGear';

    const ext = (shape: THREE.Shape, depth: number, color: number): THREE.Mesh => {
      const geom = new THREE.ExtrudeGeometry(shape, {
        depth,
        bevelEnabled: true,
        bevelThickness: 0.01,
        bevelSize: 0.005,
        bevelSegments: 1,
        steps: 1,
        curveSegments: 8,
      });
      // Center on Z (extrusion goes 0..depth → -depth/2..+depth/2 after).
      geom.translate(0, 0, -depth / 2);
      const mat = new THREE.MeshLambertMaterial({
        color,
        transparent: true,
        opacity: 1,
      });
      this.materials.push(mat);
      return new THREE.Mesh(geom, mat);
    };

    // Large gear at left.
    const largeShape = buildGearShape(0.42, 0.10, EfemGear.TEETH_LARGE, 0.07);
    this.gearLarge = ext(largeShape, 0.10, PALETTE_GEAR);
    this.gearLarge.position.set(-0.30, 0, 0);
    this.group.add(this.gearLarge);

    // Hub disc on the large gear (visual nicety, sits at center).
    const hubGeom = new THREE.CylinderGeometry(0.08, 0.08, 0.12, 16);
    const hubMat = new THREE.MeshLambertMaterial({
      color: PALETTE_GEAR_DARK,
      transparent: true,
      opacity: 1,
    });
    this.materials.push(hubMat);
    const largeHub = new THREE.Mesh(hubGeom, hubMat);
    largeHub.rotation.x = Math.PI / 2;
    largeHub.position.copy(this.gearLarge.position);
    this.group.add(largeHub);

    // Small gear to the right, positioned so teeth visually mesh. Distance
    // between centers = pitchLarge + pitchSmall ≈ 0.36 + 0.21 = 0.57. Use
    // outerR sums minus a small overlap to look meshed.
    const smallShape = buildGearShape(0.26, 0.06, EfemGear.TEETH_SMALL, 0.05);
    this.gearSmall = ext(smallShape, 0.08, PALETTE_GEAR);
    this.gearSmall.position.set(-0.30 + 0.55, 0, 0);
    this.group.add(this.gearSmall);

    const smallHub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, 0.10, 16),
      hubMat
    );
    smallHub.rotation.x = Math.PI / 2;
    smallHub.position.copy(this.gearSmall.position);
    this.group.add(smallHub);

    // Subtle phase offset on the small gear so teeth align between the two
    // (otherwise the eye reads "almost meshed" at one frame and "off" at
    // the next when the ratio drifts).
    this.gearSmall.rotation.z = Math.PI / EfemGear.TEETH_SMALL;
  }

  mount(scene: THREE.Scene): void {
    if (this.mounted) return;
    scene.add(this.group);
    this.mounted = true;
  }

  unmount(scene: THREE.Scene): void {
    if (!this.mounted) return;
    scene.remove(this.group);
    this.mounted = false;
  }

  isMounted(): boolean {
    return this.mounted;
  }

  update(dt: number, scrollProgress: number): void {
    // Spin: continuous wall-clock rotation, ratio-locked.
    const speed = 0.7; // rad/s for the large gear
    this.angleLarge += dt * speed;
    this.gearLarge.rotation.z = this.angleLarge;
    // Small gear: opposite sign, scaled by tooth ratio. The phase offset stays
    // baked into the geometry's initial rotation.
    this.gearSmall.rotation.z =
      Math.PI / EfemGear.TEETH_SMALL -
      this.angleLarge * (EfemGear.TEETH_LARGE / EfemGear.TEETH_SMALL);

    // Fade in 0..0.3, hold, fade out 0.85..1.
    const targetOpacity =
      scrollProgress < 0.3
        ? scrollProgress / 0.3
        : scrollProgress > 0.85
        ? Math.max(0, 1 - (scrollProgress - 0.85) / 0.15)
        : 1;
    this.opacity += (targetOpacity - this.opacity) * 0.12;
    for (const m of this.materials) {
      (m as THREE.MeshLambertMaterial).opacity = this.opacity;
    }
  }

  setTransform(position: THREE.Vector3, scale: number): void {
    this.group.position.copy(position);
    this.group.scale.setScalar(scale);
  }

  getLeaderAnchor(out: THREE.Vector3): THREE.Vector3 {
    // Left side of the large gear in world space.
    out.set(-0.55, 0, 0).multiplyScalar(this.group.scale.x);
    out.add(this.group.position);
    return out;
  }

  dispose(scene: THREE.Scene): void {
    this.unmount(scene);
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
  }
}
