import * as THREE from 'three';
import type { WorkObject } from '../WorkObject';

/**
 * PRJ_07 SN Version — a 3D SPC (Statistical Process Control) curve drawn from
 * a sine + low-frequency noise function, with 20 small spheres at sample
 * points and two semi-transparent horizontal "tolerance band" planes above
 * and below.
 *
 * Animation: as scrollProgress increases the curve "draws in" from left to
 * right, with each sphere appearing once the curve passes its x position.
 * Tolerance bands fade in early (alpha 0..1 over scrollProgress 0..0.2).
 *
 * Visual budget:
 *   - 1 LineSegments (the curve, drawn segmented because we need partial reveal)
 *   - 1 InstancedMesh of 20 spheres (single draw call)
 *   - 2 plane meshes (tolerance bands)
 *   = ~4 draw calls.
 */

const POINTS = 32;       // resolution of the curve (more than 20 because bezier eyes)
const SPHERES = 20;
const CURVE_X_HALF = 0.55;
const TOL_HALF_HEIGHT = 0.18;
const PALETTE_LINE = 0xff8a3a;
const PALETTE_SPHERE = 0xffd7ad;
const PALETTE_BAND = 0x8a939d;

/** Sine + cheap noise (low-freq cosine sum) → measurement curve. */
function sample(t: number): number {
  // t in [0,1]. Output in roughly [-0.18, 0.18] inside tolerance ± 1 spike.
  const x = t * Math.PI * 2;
  const base = Math.sin(x * 1.5) * 0.08;
  const noise =
    Math.sin(x * 4.1 + 1.3) * 0.04 +
    Math.cos(x * 7.7 + 2.7) * 0.02 +
    Math.sin(x * 11.0 + 0.9) * 0.015;
  return base + noise;
}

export class SnVersion implements WorkObject {
  readonly name = 'sn-version';
  private group!: THREE.Group;
  private curve!: THREE.Line;
  private curvePositions!: Float32Array;
  private curveBaseline!: Float32Array; // full curve, for reveal cutoff
  private spheres!: THREE.InstancedMesh;
  private bandUpper!: THREE.Mesh;
  private bandLower!: THREE.Mesh;
  private materials: THREE.Material[] = [];
  private mounted = false;
  private opacity = 0;
  // Per-sphere visibility (smoothed).
  private sphereVis: number[] = new Array(SPHERES).fill(0);
  private dummyMatrix = new THREE.Matrix4();
  private dummyScale = new THREE.Vector3();
  private dummyPos = new THREE.Vector3();

  init(): void {
    this.group = new THREE.Group();
    this.group.name = 'SnVersion';

    // Curve baseline (full) — POINTS samples.
    this.curveBaseline = new Float32Array(POINTS * 3);
    for (let i = 0; i < POINTS; i++) {
      const t = i / (POINTS - 1);
      const x = THREE.MathUtils.lerp(-CURVE_X_HALF, +CURVE_X_HALF, t);
      const y = sample(t);
      this.curveBaseline[i * 3 + 0] = x;
      this.curveBaseline[i * 3 + 1] = y;
      this.curveBaseline[i * 3 + 2] = 0;
    }
    // Live positions: copy baseline, will be progressively revealed.
    this.curvePositions = new Float32Array(this.curveBaseline);

    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute('position', new THREE.BufferAttribute(this.curvePositions, 3));
    const lineMat = new THREE.LineBasicMaterial({
      color: PALETTE_LINE,
      transparent: true,
      opacity: 1,
      linewidth: 1, // most browsers ignore but kept for clarity
    });
    this.materials.push(lineMat);
    this.curve = new THREE.Line(lineGeom, lineMat);
    this.group.add(this.curve);

    // Sphere markers, instanced. Single Geometry + Material → 1 draw call for
    // all 20. We hide each by setting its scale to ~0 in the matrix.
    const sphereGeom = new THREE.SphereGeometry(0.025, 10, 10);
    const sphereMat = new THREE.MeshBasicMaterial({
      color: PALETTE_SPHERE,
      transparent: true,
      opacity: 1,
    });
    this.materials.push(sphereMat);
    this.spheres = new THREE.InstancedMesh(sphereGeom, sphereMat, SPHERES);
    this.spheres.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Initialize each sphere's matrix to its target position with scale 0
    // (invisible). We'll grow them in update().
    for (let i = 0; i < SPHERES; i++) {
      const t = i / (SPHERES - 1);
      const x = THREE.MathUtils.lerp(-CURVE_X_HALF, +CURVE_X_HALF, t);
      const y = sample(t);
      this.dummyPos.set(x, y, 0);
      this.dummyScale.setScalar(0.001);
      this.dummyMatrix.compose(
        this.dummyPos,
        new THREE.Quaternion(),
        this.dummyScale
      );
      this.spheres.setMatrixAt(i, this.dummyMatrix);
    }
    this.spheres.instanceMatrix.needsUpdate = true;
    this.group.add(this.spheres);

    // Tolerance bands — two thin planes above/below the curve.
    const bandGeom = new THREE.PlaneGeometry(CURVE_X_HALF * 2 + 0.10, 0.02);
    const bandMat = new THREE.MeshBasicMaterial({
      color: PALETTE_BAND,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
    });
    this.materials.push(bandMat);
    this.bandUpper = new THREE.Mesh(bandGeom, bandMat);
    this.bandUpper.position.y = +TOL_HALF_HEIGHT;
    this.group.add(this.bandUpper);

    this.bandLower = new THREE.Mesh(bandGeom, bandMat);
    this.bandLower.position.y = -TOL_HALF_HEIGHT;
    this.group.add(this.bandLower);
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
    // Curve reveal: the line is full at all times (Three.js doesn't render
    // partial Line geometry without a custom shader), so we cheat: indices
    // beyond the reveal point all collapse onto the leading edge so the line
    // visually ends there.
    const drawT = THREE.MathUtils.clamp((scrollProgress - 0.10) / 0.65, 0, 1);
    const drawIndex = Math.floor(drawT * (POINTS - 1));
    // Find the lead point's interpolated position so the visible end isn't
    // snappy as drawIndex increments.
    const fracT = drawT * (POINTS - 1) - drawIndex;
    const i0 = drawIndex;
    const i1 = Math.min(POINTS - 1, drawIndex + 1);
    const leadX = THREE.MathUtils.lerp(
      this.curveBaseline[i0 * 3 + 0],
      this.curveBaseline[i1 * 3 + 0],
      fracT
    );
    const leadY = THREE.MathUtils.lerp(
      this.curveBaseline[i0 * 3 + 1],
      this.curveBaseline[i1 * 3 + 1],
      fracT
    );

    for (let i = 0; i < POINTS; i++) {
      if (i <= drawIndex) {
        // Restore baseline.
        this.curvePositions[i * 3 + 0] = this.curveBaseline[i * 3 + 0];
        this.curvePositions[i * 3 + 1] = this.curveBaseline[i * 3 + 1];
      } else if (i === drawIndex + 1 && i < POINTS) {
        // Lead vertex — interpolated position so the leading edge is smooth.
        this.curvePositions[i * 3 + 0] = leadX;
        this.curvePositions[i * 3 + 1] = leadY;
      } else {
        // Collapse trailing vertices onto the lead so they don't draw.
        this.curvePositions[i * 3 + 0] = leadX;
        this.curvePositions[i * 3 + 1] = leadY;
      }
    }
    (this.curve.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate =
      true;

    // Spheres appear sequentially. Sphere i becomes visible once drawT crosses
    // (i / (SPHERES-1)). We smoothly grow scale 0..1 over a small window.
    for (let i = 0; i < SPHERES; i++) {
      const threshold = i / (SPHERES - 1);
      const targetVis = drawT >= threshold ? 1 : 0;
      this.sphereVis[i] += (targetVis - this.sphereVis[i]) * 0.18;
      const t = i / (SPHERES - 1);
      const x = THREE.MathUtils.lerp(-CURVE_X_HALF, +CURVE_X_HALF, t);
      const y = sample(t);
      this.dummyPos.set(x, y, 0);
      const s = Math.max(0.001, this.sphereVis[i]);
      this.dummyScale.setScalar(s);
      this.dummyMatrix.compose(this.dummyPos, new THREE.Quaternion(), this.dummyScale);
      this.spheres.setMatrixAt(i, this.dummyMatrix);
    }
    this.spheres.instanceMatrix.needsUpdate = true;

    // Tolerance band fade.
    const bandTarget =
      scrollProgress < 0.05
        ? 0
        : scrollProgress > 0.85
        ? Math.max(0, 0.35 - ((scrollProgress - 0.85) / 0.15) * 0.35)
        : 0.35;
    (this.bandUpper.material as THREE.MeshBasicMaterial).opacity = bandTarget;
    (this.bandLower.material as THREE.MeshBasicMaterial).opacity = bandTarget;

    const targetOpacity =
      scrollProgress < 0.10
        ? scrollProgress / 0.10
        : scrollProgress > 0.85
        ? Math.max(0, 1 - (scrollProgress - 0.85) / 0.15)
        : 1;
    this.opacity += (targetOpacity - this.opacity) * 0.12;
    // Curve + spheres opacity. Bands have their own (lower) target.
    (this.curve.material as THREE.LineBasicMaterial).opacity = this.opacity;
    (this.spheres.material as THREE.MeshBasicMaterial).opacity = this.opacity;
  }

  setTransform(position: THREE.Vector3, scale: number): void {
    this.group.position.copy(position);
    this.group.scale.setScalar(scale);
  }

  getLeaderAnchor(out: THREE.Vector3): THREE.Vector3 {
    out.set(-CURVE_X_HALF - 0.05, 0, 0).multiplyScalar(this.group.scale.x);
    out.add(this.group.position);
    return out;
  }

  dispose(scene: THREE.Scene): void {
    this.unmount(scene);
    this.curve.geometry.dispose();
    this.spheres.geometry.dispose();
    this.bandUpper.geometry.dispose();
    // bandLower shares geometry with bandUpper — already disposed.
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
  }
}
