import * as THREE from 'three';

/**
 * Common contract for every per-project 3D companion object in the Work section.
 *
 * Each object owns a single THREE.Group containing all of its meshes. The group
 * is added to the scene by `mount()` and removed by `unmount()`. GPU resources
 * (geometries, materials, textures) are released by `dispose()`, called when
 * the WorkScene is unregistered.
 *
 * `update(dt, scrollProgress)` is called every frame WHILE MOUNTED. The
 * scrollProgress is the *card-local* progress: 0 when the card is just about
 * to enter the viewport from the bottom, 1 when it has just left from the top.
 * Animations are scroll-driven (per acceptance criterion #5) — wall-clock time
 * is only used for "always on" details like idle gear rotation in EFEM.
 *
 * `getLeaderAnchor()` returns the world-space point where the SVG leader line
 * should attach on the 3D side (typically the left edge of the object's
 * visible bounding box, since the HTML card sits to its left). Implementations
 * should mutate `out` and return it (avoid per-frame allocations).
 */
export interface WorkObject {
  readonly name: string;
  /** Build geometry/material here. Don't add to scene yet. Called once. */
  init(): void;
  /** Add the group to the scene. Idempotent. */
  mount(scene: THREE.Scene): void;
  /** Remove from scene without freeing GPU resources. Idempotent. */
  unmount(scene: THREE.Scene): void;
  /** Whether the group is currently in the scene graph. */
  isMounted(): boolean;
  /**
   * Per-frame tick. `scrollProgress` is 0..1 within the card's on-screen window.
   * Implementations should map this to their visual timeline (e.g. bar heights,
   * morph progress, stack count).
   */
  update(dt: number, scrollProgress: number): void;
  /** Set group transform (position from screen-to-world, optional uniform scale). */
  setTransform(position: THREE.Vector3, scale: number): void;
  /** World-space anchor point for the leader line (mutates and returns `out`). */
  getLeaderAnchor(out: THREE.Vector3): THREE.Vector3;
  /** Free GPU resources. Called once on dispose. */
  dispose(scene: THREE.Scene): void;
}
