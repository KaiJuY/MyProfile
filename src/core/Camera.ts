import * as THREE from 'three';
import type { ViewportSize } from './ResizeObserver';

/**
 * Main perspective camera. Positioned at z=5 facing -z so that an element placed
 * at world z=0 (which is what `elementToWorld(elem, camera, 5)` produces with
 * camera at z=5) renders crisply in the viewport center.
 *
 * fov 45 chosen for moderate perspective — wide enough to feel cinematic, tight
 * enough that screen-to-world projection of HTML elements doesn't distort heavily
 * at the edges.
 */
export class Camera {
  readonly three: THREE.PerspectiveCamera;

  constructor(initial: ViewportSize) {
    this.three = new THREE.PerspectiveCamera(
      45,
      initial.width / initial.height,
      0.1,
      100
    );
    this.three.position.set(0, 0, 5);
    this.three.lookAt(0, 0, 0);
  }

  resize(size: ViewportSize): void {
    this.three.aspect = size.width / size.height;
    this.three.updateProjectionMatrix();
  }
}
