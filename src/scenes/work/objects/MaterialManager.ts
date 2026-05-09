import * as THREE from 'three';
import type { WorkObject } from '../WorkObject';

/**
 * PRJ_05 Material Manager — 5 small boxes appear and stack on each other as
 * scrollProgress goes 0..1, with a slight random rotation each so the stack
 * reads as physical inventory (not perfectly aligned).
 *
 * Camera/group is tilted toward an isometric-ish angle (rotation around Y
 * 30°, around X -25°) to give depth without per-object lights or shadows.
 *
 * Visual budget: 5 box meshes. Single MeshLambertMaterial per box (5 mats
 * for individual opacity control during pop-in).
 */

const BOX_COLORS = [0xc6cdd6, 0xa9b3bd, 0x8e98a3, 0xd5dee7, 0xb6c0cb];
const BOX_SIZE = 0.18;
const BOX_GAP = 0.005; // tiny gap so the seam between boxes is visible

export class MaterialManager implements WorkObject {
  readonly name = 'material-manager';
  private group!: THREE.Group;
  // Wrapper that carries the isometric tilt so getLeaderAnchor stays simple
  // (anchor in local space = tilt-applied world without composing matrices).
  private innerTilt!: THREE.Group;
  private boxes: { mesh: THREE.Mesh; targetY: number; tiltZ: number; tiltX: number }[] =
    [];
  private materials: THREE.MeshLambertMaterial[] = [];
  private mounted = false;
  private opacity = 0;
  // Per-box "appeared" t (smoothed). 0 = invisible/below; 1 = at target stacked Y.
  private appeared: number[] = [0, 0, 0, 0, 0];

  init(): void {
    this.group = new THREE.Group();
    this.group.name = 'MaterialManager';

    // Outer group is the leader-anchor frame (un-tilted). Inner carries tilt.
    this.innerTilt = new THREE.Group();
    // Isometric-ish: yaw 30°, pitch -25°. World up still feels like up because
    // the pitch is mild.
    this.innerTilt.rotation.y = THREE.MathUtils.degToRad(30);
    this.innerTilt.rotation.x = THREE.MathUtils.degToRad(-22);
    this.group.add(this.innerTilt);

    const N = BOX_COLORS.length;
    const stackBaseY = -0.30; // bottom box sits here once stacked

    for (let i = 0; i < N; i++) {
      const mat = new THREE.MeshLambertMaterial({
        color: BOX_COLORS[i],
        transparent: true,
        opacity: 1,
      });
      this.materials.push(mat);
      const geom = new THREE.BoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE);
      const mesh = new THREE.Mesh(geom, mat);
      // Targets: each box sits on top of the previous.
      const targetY = stackBaseY + i * (BOX_SIZE + BOX_GAP) + BOX_SIZE / 2;
      // Random small rotation for organic feel — deterministic seed via i to
      // keep look stable across mount/unmount cycles.
      const tiltZ = (Math.sin(i * 12.9898) * 0.5 + 0.5) * 0.10 - 0.05;
      const tiltX = (Math.sin(i * 78.233) * 0.5 + 0.5) * 0.08 - 0.04;
      mesh.position.set(0, targetY, 0);
      mesh.rotation.z = tiltZ;
      mesh.rotation.x = tiltX;
      // Initial state: invisible (set scale=0 so they pop in cleanly).
      mesh.scale.setScalar(0.001);
      this.boxes.push({ mesh, targetY, tiltZ, tiltX });
      this.innerTilt.add(mesh);
    }
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

  update(_dt: number, scrollProgress: number): void {
    // Sequential pop-in: each box appears at i*stagger and finishes at
    // i*stagger + window.
    const N = this.boxes.length;
    const stagger = 0.10;
    const window = 0.18;
    for (let i = 0; i < N; i++) {
      const t0 = i * stagger;
      const tNorm = THREE.MathUtils.clamp(
        (scrollProgress - t0) / window,
        0,
        1
      );
      // EaseOutBack-ish for a satisfying overshoot at landing.
      const eased = 1 - Math.pow(1 - tNorm, 3);
      this.appeared[i] += (eased - this.appeared[i]) * 0.18;
      const a = this.appeared[i];
      const b = this.boxes[i];
      // Scale snaps from 0..1 with the eased value. Position drops in from
      // slightly above the target so the eye sees it "land".
      const dropFromAbove = (1 - a) * 0.18;
      b.mesh.scale.setScalar(THREE.MathUtils.lerp(0.001, 1, a));
      b.mesh.position.y = b.targetY + dropFromAbove;
    }

    const targetOpacity =
      scrollProgress < 0.10
        ? scrollProgress / 0.10
        : scrollProgress > 0.85
        ? Math.max(0, 1 - (scrollProgress - 0.85) / 0.15)
        : 1;
    this.opacity += (targetOpacity - this.opacity) * 0.12;
    for (const m of this.materials) m.opacity = this.opacity;
  }

  setTransform(position: THREE.Vector3, scale: number): void {
    this.group.position.copy(position);
    this.group.scale.setScalar(scale);
  }

  getLeaderAnchor(out: THREE.Vector3): THREE.Vector3 {
    // Anchor at the lower-left of the stack in world space.
    out.set(-0.20, -0.10, 0).multiplyScalar(this.group.scale.x);
    out.add(this.group.position);
    return out;
  }

  dispose(scene: THREE.Scene): void {
    this.unmount(scene);
    for (const b of this.boxes) b.mesh.geometry.dispose();
    for (const m of this.materials) m.dispose();
    this.boxes.length = 0;
    this.materials.length = 0;
  }
}
