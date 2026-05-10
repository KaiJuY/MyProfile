import * as THREE from 'three';

/**
 * Hole — the cup. Three layered visuals:
 *
 *   1. Rim torus  — thin TorusGeometry at green-surface y, marks the lip.
 *      Driven by an emissive uniform that flashes on ball-drop (the "thunk").
 *   2. Cup disc   — black disc slightly recessed below the green surface,
 *      filling the rim's interior. Reads as "hollow cup".
 *   3. Shadow ring — a slightly larger flat ring with a radial gradient texture
 *      that darkens the ground around the rim, faking the AO/shadow under the
 *      lip. Cheap and reads well at distance.
 *
 * Coordinate convention (matches GreenSurface y=-2):
 *   - Green surface plane at y = -2
 *   - Rim torus at y = -2 (sits on the plane)
 *   - Cup disc at y = -2.05 (slightly below — recessed)
 *   - Cup interior depth used by the drop-in animation: y = -2.5 to -2.9
 */

export interface HoleOptions {
  /** Hole center (x, z) — y is fixed at the surface y. Default origin. */
  centerX?: number;
  centerZ?: number;
  /** Y of the green surface (rim sits here). Default -2. */
  surfaceY?: number;
  /** Inside radius — the cup mouth. Default 0.55. */
  rimRadius?: number;
  /** Tube radius of the torus (visual rim thickness). Default 0.02. */
  tubeRadius?: number;
}

export class Hole {
  readonly group: THREE.Group;
  /** Live cup-mouth XZ center (read by ContactScene for ball physics). */
  readonly center: THREE.Vector3;
  readonly rimRadius: number;
  readonly surfaceY: number;

  private rimMesh: THREE.Mesh;
  private cupMesh: THREE.Mesh;
  private shadowMesh: THREE.Mesh;

  private rimMaterial: THREE.ShaderMaterial;
  private shadowTex?: THREE.CanvasTexture;

  constructor(opts: HoleOptions = {}) {
    const cx = opts.centerX ?? 0;
    const cz = opts.centerZ ?? 0;
    const sy = opts.surfaceY ?? -2;
    const rr = opts.rimRadius ?? 0.55;
    const tr = opts.tubeRadius ?? 0.02;

    this.group = new THREE.Group();
    this.center = new THREE.Vector3(cx, sy, cz);
    this.rimRadius = rr;
    this.surfaceY = sy;

    // 1. Rim torus — emissive shader so we can flash it on ball-drop.
    // Glow color uses the site accent (#FF6A00) so the "thunk" reads as part
    // of the brand palette rather than a stray cool-blue tint.
    const rimGeom = new THREE.TorusGeometry(rr, tr, 12, 64);
    this.rimMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uBase: { value: new THREE.Color(0x303838) }, // dim cool gray
        uGlow: { value: new THREE.Color(0xff6a00) }, // accent flash on drop
        uGlowAmount: { value: 0.0 },                  // animated 0..1
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uBase;
        uniform vec3 uGlow;
        uniform float uGlowAmount;
        varying vec3 vNormal;
        void main() {
          // Cheap "rim shading" — light from above tilt.
          float l = clamp(vNormal.y * 0.6 + 0.6, 0.0, 1.0);
          vec3 col = uBase * l + uGlow * uGlowAmount;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      transparent: false,
    });
    this.rimMesh = new THREE.Mesh(rimGeom, this.rimMaterial);
    this.rimMesh.rotation.x = Math.PI / 2; // torus default sits in XY plane → tilt to lay on green
    this.rimMesh.position.set(cx, sy, cz);
    this.group.add(this.rimMesh);

    // 2. Cup disc — pure black, slightly recessed. Use a CircleGeometry sized
    //    INSIDE the rim so the rim's tube hides the join.
    const cupGeom = new THREE.CircleGeometry(rr - tr * 0.5, 48);
    const cupMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      // depthWrite false so the falling ball doesn't z-fight when it crosses
      // through this plane on its way into the cup.
      depthWrite: false,
    });
    this.cupMesh = new THREE.Mesh(cupGeom, cupMat);
    this.cupMesh.rotation.x = -Math.PI / 2; // lay flat
    this.cupMesh.position.set(cx, sy - 0.05, cz);
    this.cupMesh.renderOrder = 0; // ball is renderOrder default; cup paints first
    this.group.add(this.cupMesh);

    // 3. Shadow ring — radial-gradient disc, slightly above the green to bias
    //    z-test toward "ground-shadow looks". Renders BEFORE green/ball.
    this.shadowTex = buildShadowTexture(256, rr);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: this.shadowTex,
      transparent: true,
      depthWrite: false,
      color: 0xffffff,
    });
    const shadowGeom = new THREE.PlaneGeometry(rr * 4, rr * 4);
    this.shadowMesh = new THREE.Mesh(shadowGeom, shadowMat);
    this.shadowMesh.rotation.x = -Math.PI / 2;
    // sit ABOVE the green by a tiny epsilon — depthWrite is false on green
    // so this paints over correctly. y just slightly above sy.
    this.shadowMesh.position.set(cx, sy + 0.001, cz);
    this.shadowMesh.renderOrder = 0;
    this.group.add(this.shadowMesh);
  }

  /** Set rim glow [0..1]. ContactScene tween animates this on ball-drop. */
  setGlow(amount: number): void {
    this.rimMaterial.uniforms.uGlowAmount.value = amount;
  }

  dispose(): void {
    (this.rimMesh.geometry as THREE.BufferGeometry).dispose();
    this.rimMaterial.dispose();
    (this.cupMesh.geometry as THREE.BufferGeometry).dispose();
    (this.cupMesh.material as THREE.Material).dispose();
    (this.shadowMesh.geometry as THREE.BufferGeometry).dispose();
    (this.shadowMesh.material as THREE.Material).dispose();
    if (this.shadowTex) this.shadowTex.dispose();
  }
}

/**
 * Build a radial-gradient shadow texture: dark in a ring around the cup mouth,
 * fading to transparent toward the corners. The bright center is also faded
 * (we don't want the cup interior to show up under the cup disc).
 */
function buildShadowTexture(size: number, _rimRadius: number): THREE.CanvasTexture {
  void _rimRadius;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Hole: 2D ctx unavailable');

  ctx.clearRect(0, 0, size, size);

  // Plane is rr*4 wide. The rim is at radius rr → maps to size * (rr / (rr*4))
  // = size/4 from center. Shadow ring should peak just outside the rim and
  // fall off both inward (cup is black anyway) and outward.
  const cx = size / 2;
  const cy = size / 2;
  const rimNorm = size / 4; // rim's normalized pixel radius in this texture

  // Outer fade: from rimNorm * 1.05 (full dark) → rimNorm * 1.9 (transparent).
  const grad = ctx.createRadialGradient(cx, cy, rimNorm * 1.0, cx, cy, rimNorm * 1.9);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
  grad.addColorStop(0.5, 'rgba(0, 0, 0, 0.18)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Cut a hole in the middle so we don't darken the cup interior.
  ctx.globalCompositeOperation = 'destination-out';
  const innerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rimNorm * 1.0);
  innerGrad.addColorStop(0, 'rgba(0,0,0,1)');
  innerGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = innerGrad;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
