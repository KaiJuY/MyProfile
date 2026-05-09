import * as THREE from 'three';

/**
 * SandboxWindow — rounded-rectangle stencil mask for the toolkit section.
 *
 * Pattern mirrors HeroScene's mask but uses stencil ref = 2 (HeroScene uses
 * ref = 1). Both can coexist in a single scene because the renderer's
 * autoClearStencil = true → the stencil buffer is reset to 0 every frame
 * before the scene is drawn. So both masks fight a fresh canvas every frame;
 * neither leaks into the other.
 *
 * Mesh order:
 *   - mask: renderOrder = 10 (drawn first, writes ref=2 into stencil where
 *     the rounded rect covers; colorWrite=false so the page sees nothing).
 *   - skill objects: renderOrder = 11 (drawn after, with stencilFunc=EQUAL
 *     ref=2 → only the pixels inside the mask are painted).
 *   - labels: renderOrder = 12, stencilWrite=false so they're never clipped
 *     (per playbook §7).
 *
 * We use renderOrder values >= 10 to keep these well above HeroScene's
 * renderOrder=1/2 — Three sorts opaque objects by renderOrder ASC then by
 * material ID. The hero pair fully writes-then-clears, then we run.
 */

export const TOOLKIT_STENCIL_REF = 2;
export const TOOLKIT_RENDER_ORDER_MASK = 10;
export const TOOLKIT_RENDER_ORDER_OBJECT = 11;
export const TOOLKIT_RENDER_ORDER_LABEL = 12;

function buildRoundedRectGeometry(
  radius: number = 0.06,
  segments: number = 8
): THREE.ShapeGeometry {
  const w = 0.5;
  const h = 0.5;
  const r = Math.min(radius, w, h);
  const shape = new THREE.Shape();
  shape.moveTo(-w + r, -h);
  shape.lineTo(w - r, -h);
  shape.quadraticCurveTo(w, -h, w, -h + r);
  shape.lineTo(w, h - r);
  shape.quadraticCurveTo(w, h, w - r, h);
  shape.lineTo(-w + r, h);
  shape.quadraticCurveTo(-w, h, -w, h - r);
  shape.lineTo(-w, -h + r);
  shape.quadraticCurveTo(-w, -h, -w + r, -h);
  return new THREE.ShapeGeometry(shape, segments);
}

export class SandboxWindow {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.ShapeGeometry;
  readonly material: THREE.MeshBasicMaterial;

  constructor() {
    this.geometry = buildRoundedRectGeometry(0.05, 8);
    this.material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      colorWrite: false, // invisible
      stencilWrite: true,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilRef: TOOLKIT_STENCIL_REF,
      stencilZPass: THREE.ReplaceStencilOp,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilWriteMask: 0xff,
      stencilFuncMask: 0xff,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.renderOrder = TOOLKIT_RENDER_ORDER_MASK;
    this.mesh.frustumCulled = false; // anchor moves via DOM rect; bbox unreliable
    this.mesh.visible = false; // start hidden until anchored
  }

  /**
   * Place the mask at world-space center with given world-space size.
   */
  setBox(
    center: { x: number; y: number; z: number },
    width: number,
    height: number
  ): void {
    this.mesh.position.set(center.x, center.y, center.z);
    this.mesh.scale.set(width, height, 1);
    this.mesh.visible = true;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
