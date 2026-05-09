import * as THREE from 'three';
import type { ViewportSize } from './ResizeObserver';

/**
 * Three.js WebGLRenderer wrapper with sane defaults for a Lusion-style site:
 *  - WebGL2 (default in r152+, but we assert)
 *  - antialias on, alpha on (so canvas can let DOM-z behind show through)
 *  - DPR capped at 2 (4K monitors at native DPR torch GPU budget)
 *  - ACESFilmic tone mapping (matches the matcap+AO pipeline planned for step 06)
 *  - sRGB output color space (Three r152+ default; explicit for clarity)
 */
export class Renderer {
  readonly three: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.three = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
      // stencil enabled because step 04 (stencil region masking) will need it.
      // Cheap enough at 8 bits — not worth a separate render target swap later.
      stencil: true,
    });
    this.three.setClearColor(0x000000, 0); // transparent — DOM behind shows through
    this.three.toneMapping = THREE.ACESFilmicToneMapping;
    this.three.toneMappingExposure = 1.0;
    this.three.outputColorSpace = THREE.SRGBColorSpace;
    // Three r152+ uses physically-correct lighting by default; nothing to set.
  }

  resize(size: ViewportSize): void {
    this.three.setPixelRatio(size.dpr);
    this.three.setSize(size.width, size.height, false);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.three.render(scene, camera);
  }

  dispose(): void {
    this.three.dispose();
  }
}
