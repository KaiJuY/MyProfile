import * as THREE from 'three';
import type { SceneModule } from './SceneManager';
import { elementToWorld } from '@core/ScreenToWorld';

/**
 * TEMPORARY scene module — exists only to prove the canvas is alive and the
 * screen-to-world pipeline is wired correctly. Will be deleted in step 02
 * when the actual hero ball lands.
 *
 * Behavior:
 *  - 1×1×1 cube with MeshNormalMaterial (colorful, no lighting needed)
 *  - Repositioned each frame to sit at the world-space anchor of the hero's <h1>
 *  - Slow rotation so we can visually confirm dt is flowing
 */
export class TestCube implements SceneModule {
  readonly name = 'test-cube';
  private mesh!: THREE.Mesh;
  private camera: THREE.PerspectiveCamera;
  private heroEl: HTMLElement | null = null;
  private readonly distance: number;
  private readonly tmpPos = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, distance: number = 5) {
    this.camera = camera;
    this.distance = distance;
  }

  init(scene: THREE.Scene): void {
    const geom = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshNormalMaterial();
    this.mesh = new THREE.Mesh(geom, mat);
    scene.add(this.mesh);

    // Lazily resolve hero h1; the DOM is guaranteed ready by now (we boot main.ts
    // after DOMContentLoaded), but we re-fetch each frame anyway in case the i18n
    // toggle replaces the h1's innerHTML (data-i18n).
  }

  update(dt: number): void {
    // Re-query each tick — i18n re-renders innerHTML which can detach nodes,
    // and a layout shift could move the headline. Cost is negligible.
    if (!this.heroEl || !document.body.contains(this.heroEl)) {
      this.heroEl = document.querySelector('#hero h1');
    }

    if (this.heroEl) {
      // Camera at z=5, distance=5 → cube lands at z≈0 with proper x/y centered
      // on the headline's screen position. Re-runs each frame so resize / scroll
      // / i18n shifts all stay aligned.
      elementToWorld(this.heroEl, this.camera, this.distance, this.tmpPos);
      this.mesh.position.copy(this.tmpPos);
    }

    // Slow rotation so dt is visually verifiable
    this.mesh.rotation.x += dt * 0.4;
    this.mesh.rotation.y += dt * 0.6;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
