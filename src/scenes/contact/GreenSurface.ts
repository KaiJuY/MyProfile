import * as THREE from 'three';

/**
 * GreenSurface — the "putting green" patch under the hole.
 *
 * Visual: a wide flat plane with a subtle procedural noise texture for surface
 * variation, dark cool-gray-green tone that reads as "minimal monochrome golf
 * green" (NOT photoreal grass — keeps the playbook's aesthetic restraint).
 *
 * The plane is large (8×6) so even at the camera's slight downward tilt the
 * green fills the lower frame and the camera doesn't see a horizon edge. We
 * also fade the green at its outer ring via vertex alpha so it dissolves into
 * the dark background instead of cutting hard.
 *
 * Stencil: NONE — full-viewport finale, no clip.
 */

function buildGreenTexture(size: number = 256): THREE.CanvasTexture {
  // Procedural value-noise tile. Cheap and deterministic; we don't need a
  // perlin-grade texture for an aesthetic "subtle grain" pass.
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('GreenSurface: 2D ctx unavailable');

  // Base fill — dark cool-gray with a hint of green. Kept low contrast.
  ctx.fillStyle = '#0d1413';
  ctx.fillRect(0, 0, size, size);

  // Stipple noise: a few hundred semi-transparent dots — reads as "tight grass"
  // at distance without becoming busy.
  const N = 1800;
  for (let i = 0; i < N; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 0.4 + Math.random() * 0.9;
    const a = 0.06 + Math.random() * 0.14;
    // Slight green/teal jitter
    const g = 30 + Math.floor(Math.random() * 40);
    const b = 28 + Math.floor(Math.random() * 30);
    ctx.fillStyle = `rgba(20, ${g}, ${b}, ${a})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // A faint diagonal directional brushing — the slight "putting line" hint.
  ctx.globalAlpha = 0.05;
  for (let i = 0; i < 60; i++) {
    const y = (i / 60) * size + (Math.random() - 0.5) * 4;
    ctx.fillStyle = '#1a2a26';
    ctx.fillRect(0, y, size, 0.6);
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export interface GreenSurfaceOptions {
  /** World y-coordinate of the plane (default -2). */
  y?: number;
  /** Width × depth (default 8 × 6). */
  width?: number;
  depth?: number;
}

export class GreenSurface {
  readonly mesh: THREE.Mesh;
  private texture: THREE.CanvasTexture;
  private material: THREE.ShaderMaterial;

  constructor(opts: GreenSurfaceOptions = {}) {
    const w = opts.width ?? 8;
    const d = opts.depth ?? 6;
    const y = opts.y ?? -2;

    this.texture = buildGreenTexture(256);
    // Repeat the noise tile so close-up detail still looks fine.
    this.texture.repeat.set(4, 3);

    // Custom shader: standard textured lit-flat + radial alpha falloff toward
    // the plane edges (so the green dissolves rather than cuts at its border).
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: this.texture },
        uTint: { value: new THREE.Color(0x141d1b) },
        uOpacity: { value: 1.0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec2 vLocalUv; // 0..1 across plane, for radial fade
        void main() {
          // SphereGeometry-style uv repetition was applied via texture.repeat,
          // but we still need raw 0..1 plane UV for the radial fade.
          vUv = uv;          // already includes the repeat factor
          vLocalUv = uv;     // 0..1 across the plane (PlaneGeometry default)
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uMap;
        uniform vec3 uTint;
        uniform float uOpacity;
        varying vec2 vUv;
        varying vec2 vLocalUv;
        void main() {
          // Sampling with the original UV — texture.repeat applies in the
          // sampler, so vUv * 1 reads tiled noise.
          vec3 noise = texture2D(uMap, vUv).rgb;
          // Tint + slight noise lift.
          vec3 col = mix(uTint, noise, 0.65);
          // Radial fade from plane center toward edges. vLocalUv ∈ [0,1]^2,
          // remap to [-0.5, 0.5] then take length → 0 at center, ~0.71 at corner.
          vec2 c = vLocalUv - 0.5;
          float r = length(c);
          // Aggressive vignette — only the immediate area around the cup is
          // opaque, rest of the plane fades fast so contact text behind it
          // remains readable. Solid out to ~0.18, ramps to 0 by ~0.42.
          float alpha = smoothstep(0.42, 0.18, r) * 0.85;
          gl_FragColor = vec4(col, alpha * uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false, // it's a flat ground plane, don't fight ball's depth
    });

    const geom = new THREE.PlaneGeometry(w, d, 1, 1);
    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.rotation.x = -Math.PI / 2; // lay flat on XZ
    this.mesh.position.y = y;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1; // draw before the hole/ball so ball reads on top
  }

  /** Drive the green's overall alpha (used during reveal/idle). */
  setOpacity(o: number): void {
    this.material.uniforms.uOpacity.value = o;
  }

  dispose(): void {
    (this.mesh.geometry as THREE.BufferGeometry).dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
