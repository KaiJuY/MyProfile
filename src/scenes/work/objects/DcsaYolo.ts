import * as THREE from 'three';
import type { WorkObject } from '../WorkObject';

/**
 * PRJ_03 DCSA-YOLO — 5 vertical bars (mAP@50 benchmark comparison) that rise
 * sequentially as the card scrolls through the viewport. The 0.836 bar (your
 * DCSA result) is highlighted in the brand accent; the other four (competing
 * baselines) are gray.
 *
 * Heights from playbook: [0.800, 0.836, 0.78, 0.81, 0.79]. The 0.836 sits at
 * index 1 (sorted to second-from-left so the highlighted bar is in the middle
 * of the visual scan path).
 *
 * Animation: each bar's effective height = targetHeight * easedT, where
 *   easedT = saturate( (scrollProgress - i*stagger) / (1 - stagger*N) )
 * — staggered so bars rise in sequence, last bar finishing at scrollProgress=1.
 *
 * Visual budget: 5 bars + 1 baseline plate = 6 meshes, all simple geometry.
 */

const HEIGHTS = [0.800, 0.836, 0.78, 0.81, 0.79];
const HIGHLIGHT_INDEX = 1; // the 0.836 bar
const BAR_WIDTH = 0.10;
const BAR_DEPTH = 0.10;
const BAR_GAP = 0.04;
const BASELINE_GRAY = 0x8a939d;
const PLATE_GRAY = 0x4a525e;

export class DcsaYolo implements WorkObject {
  readonly name = 'dcsa-yolo';
  private group!: THREE.Group;
  private bars: THREE.Mesh[] = [];
  private plate!: THREE.Mesh;
  private materials: THREE.Material[] = [];
  private mounted = false;
  private opacity = 0;
  // Eased height per bar (lerped each frame for snappy-but-not-instant rise).
  private easedH: number[] = [0, 0, 0, 0, 0];

  init(): void {
    this.group = new THREE.Group();
    this.group.name = 'DcsaYolo';

    // Get accent color from CSS var (with fallback). Used only for the
    // highlight bar — keeping the palette minimal per playbook brief.
    const accentHex =
      getComputedStyle(document.documentElement)
        .getPropertyValue('--accent')
        .trim() || '#FF6A00';
    const accent = new THREE.Color(accentHex);

    // Baseline plate under bars (subtle).
    const plateW = HEIGHTS.length * BAR_WIDTH + (HEIGHTS.length - 1) * BAR_GAP + 0.08;
    const plateGeom = new THREE.BoxGeometry(plateW, 0.02, BAR_DEPTH + 0.06);
    const plateMat = new THREE.MeshLambertMaterial({
      color: PLATE_GRAY,
      transparent: true,
      opacity: 1,
    });
    this.materials.push(plateMat);
    this.plate = new THREE.Mesh(plateGeom, plateMat);
    this.plate.position.y = -0.01; // top sits at y=0
    this.group.add(this.plate);

    // Bars. Use a unit-tall BoxGeometry whose pivot is at the BOTTOM (so we
    // scale Y from 0..1 without dancing the position). Translate the geometry
    // by +0.5 in y so its origin is at y=0 (bottom face).
    const barGeom = new THREE.BoxGeometry(BAR_WIDTH, 1, BAR_DEPTH);
    barGeom.translate(0, 0.5, 0);

    const totalW = HEIGHTS.length * BAR_WIDTH + (HEIGHTS.length - 1) * BAR_GAP;
    const startX = -totalW / 2 + BAR_WIDTH / 2;
    for (let i = 0; i < HEIGHTS.length; i++) {
      const isHighlight = i === HIGHLIGHT_INDEX;
      const mat = new THREE.MeshLambertMaterial({
        color: isHighlight ? accent : BASELINE_GRAY,
        transparent: true,
        opacity: 1,
      });
      this.materials.push(mat);
      const bar = new THREE.Mesh(barGeom, mat);
      bar.position.x = startX + i * (BAR_WIDTH + BAR_GAP);
      bar.position.y = 0;
      // Initial scaleY = 0 → invisible bar. Animation grows this.
      bar.scale.y = 0.001;
      this.bars.push(bar);
      this.group.add(bar);
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
    // Stagger window: bars start at i*stagger and finish at i*stagger + 0.4.
    // With N=5 and stagger=0.1, the last bar finishes at 0.5, leaving 0.5..1
    // for "fully grown + fade-out" — feels confident, not rushed.
    const stagger = 0.10;
    const window = 0.40;
    for (let i = 0; i < this.bars.length; i++) {
      const t0 = i * stagger;
      const tNorm = THREE.MathUtils.clamp((scrollProgress - t0) / window, 0, 1);
      // EaseOutCubic for a satisfying "settle".
      const eased = 1 - Math.pow(1 - tNorm, 3);
      const target = HEIGHTS[i] * eased;
      // Lerp toward target so heights don't jump if scroll teleports.
      this.easedH[i] += (target - this.easedH[i]) * 0.18;
      const h = Math.max(0.001, this.easedH[i]); // avoid degenerate zero scale
      this.bars[i].scale.y = h;
    }

    // Hold from 0.6 → 0.85, fade out 0.85..1.
    const targetOpacity =
      scrollProgress < 0.15
        ? scrollProgress / 0.15
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
    // Left side of the leftmost bar, halfway up the tallest bar (~0.4).
    out.set(-0.45, 0.4, 0).multiplyScalar(this.group.scale.x);
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
