import * as THREE from 'three';
import type { WorkObject } from '../WorkObject';

/**
 * PRJ_04 PLCSimulation — vertex-shader morph from a 3D representation of curly
 * braces `{ }` (the "script source") to a small box (the "compiled module").
 *
 * Strategy:
 *  - We build a single TubeGeometry that traces the outline of two facing
 *    curly braces. That same vertex count is mapped to a target attribute
 *    `targetPosition` — the corresponding position on the surface of a small
 *    cube — so the vertex shader can lerp 1:1 with no topology mismatch.
 *  - `uMorph` (0..1) drives the lerp. A small per-vertex jitter at the wave
 *    front sells the "transformation" rather than "smooth slide".
 *
 * Why a custom mini-shader and not the pursuits morphShader: that one is for
 * "wave-sweep entrance/exit" (alpha-mask based). Here we want a *position
 * morph between two distinct shapes*. Different problem, different shader.
 */

const PALETTE_BRACE = 0xb8c2cc;
const PALETTE_BLOCK = 0xff8a3a;

const VERT = /* glsl */ `
  uniform float uMorph;        // 0 = braces, 1 = box
  attribute vec3 targetPosition;
  varying vec3 vWorldNormal;

  void main() {
    // Smoothstep for snappy-yet-organic transition through the middle.
    float t = smoothstep(0.0, 1.0, uMorph);
    vec3 p = mix(position, targetPosition, t);
    // Slight per-vertex bulge at the midpoint (when t ≈ 0.5) so the morph
    // doesn't read as a linear pour. Math: bulge peaks at t=0.5.
    float bulge = 4.0 * t * (1.0 - t); // 0 at endpoints, 1 at middle
    p += normal * bulge * 0.04;
    vWorldNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uMorph;
  uniform float uOpacity;
  varying vec3 vWorldNormal;

  void main() {
    // Cheap directional light + ambient. Keeps the shape readable at low cost.
    float ndl = max(dot(vWorldNormal, normalize(vec3(0.5, 0.8, 0.6))), 0.0);
    float t = smoothstep(0.0, 1.0, uMorph);
    vec3 base = mix(uColorA, uColorB, t);
    vec3 col = base * (0.4 + 0.6 * ndl);
    if (uOpacity < 0.01) discard;
    gl_FragColor = vec4(col, uOpacity);
  }
`;

/**
 * Generate a cluster of points evenly spaced along a 2D path traced by `pathFn`,
 * then extruded along ±z to form a "ribbon". Returns flat positions + normals
 * for a TubeGeometry-like shape.
 */
function buildBraceRibbon(
  pathFn: (t: number) => [number, number],
  segments: number,
  thickness: number
): { positions: Float32Array; normals: Float32Array; indices: Uint16Array } {
  // We'll build a tube around the 2D path: at each segment, two points
  // (one at +z, one at -z). Triangles connect consecutive segments.
  const positions = new Float32Array(segments * 2 * 3);
  const normals = new Float32Array(segments * 2 * 3);
  for (let i = 0; i < segments; i++) {
    const t = i / (segments - 1);
    const [x, y] = pathFn(t);
    positions[(i * 2 + 0) * 3 + 0] = x;
    positions[(i * 2 + 0) * 3 + 1] = y;
    positions[(i * 2 + 0) * 3 + 2] = +thickness;
    positions[(i * 2 + 1) * 3 + 0] = x;
    positions[(i * 2 + 1) * 3 + 1] = y;
    positions[(i * 2 + 1) * 3 + 2] = -thickness;
    // Normal: tangent in XY plane, rotated 90° so it points "outward". For
    // simplicity use the path direction's perpendicular.
    const dt = 0.001;
    const [x2, y2] = pathFn(Math.min(1, t + dt));
    const dx = x2 - x;
    const dy = y2 - y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    normals[(i * 2 + 0) * 3 + 0] = nx;
    normals[(i * 2 + 0) * 3 + 1] = ny;
    normals[(i * 2 + 0) * 3 + 2] = 0;
    normals[(i * 2 + 1) * 3 + 0] = nx;
    normals[(i * 2 + 1) * 3 + 1] = ny;
    normals[(i * 2 + 1) * 3 + 2] = 0;
  }
  // Indices: consecutive quad pairs.
  const idx: number[] = [];
  for (let i = 0; i < segments - 1; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2;
    const d = (i + 1) * 2 + 1;
    idx.push(a, b, c, b, d, c);
  }
  return {
    positions,
    normals,
    indices: new Uint16Array(idx),
  };
}

/** Curly brace path in 2D. t∈[0,1]. Anchored around x=ax. side=+1 right, -1 left. */
function bracePath(ax: number, side: number): (t: number) => [number, number] {
  // A standard '{' shape: vertical arc with two outward swells, a center pinch.
  // We parametrize as a sequence of cubic-ish curves stitched together.
  // For simplicity: y = lerp(-0.4, 0.4, t), x bulges using a sin-shaped offset
  // that has 3 humps (top swell, center pinch INWARD, bottom swell).
  return (t: number) => {
    const y = THREE.MathUtils.lerp(-0.40, 0.40, t);
    // Center pinch: x = ax + side * (small radius - large at extremes).
    // f(t) = base_arc - pinch
    const base = -0.10 * Math.sin(Math.PI * t); // outward swell, peaks at t=0.5
    const pinch = 0.06 * (1 - Math.cos(2 * Math.PI * t)); // inward pinch with double-hump
    const x = ax + side * (base + pinch + 0.05);
    return [x, y];
  };
}

export class PlcSimulation implements WorkObject {
  readonly name = 'plc-simulation';
  private group!: THREE.Group;
  private braceMesh!: THREE.Mesh;
  private material!: THREE.ShaderMaterial;
  private mounted = false;
  private opacity = 0;
  // Smoothed morph value (lerps toward scrollProgress so the morph doesn't
  // strobe if scroll position teleports during page-jump nav).
  private smoothMorph = 0;

  init(): void {
    this.group = new THREE.Group();
    this.group.name = 'PlcSimulation';

    // Build TWO half-ribbons (left brace + right brace) and merge into one
    // BufferGeometry so we get a single draw call.
    const SEG = 32;
    const THICK = 0.04;
    const left = buildBraceRibbon(bracePath(-0.18, -1), SEG, THICK);
    const right = buildBraceRibbon(bracePath(+0.18, +1), SEG, THICK);

    // Merge: concatenate positions/normals; offset right's indices by left's
    // vertex count.
    const totalVerts = SEG * 2 * 2;
    const positions = new Float32Array(totalVerts * 3);
    const normals = new Float32Array(totalVerts * 3);
    positions.set(left.positions, 0);
    positions.set(right.positions, left.positions.length);
    normals.set(left.normals, 0);
    normals.set(right.normals, left.normals.length);
    const indices = new Uint16Array(left.indices.length + right.indices.length);
    indices.set(left.indices, 0);
    const offset = SEG * 2;
    for (let i = 0; i < right.indices.length; i++) {
      indices[left.indices.length + i] = right.indices[i] + offset;
    }

    // Build target positions: every vertex maps to a point on the surface of a
    // 0.45×0.45×0.16 box. Use deterministic mapping: vertex.x sign → box face.
    const targets = new Float32Array(totalVerts * 3);
    for (let i = 0; i < totalVerts; i++) {
      const px = positions[i * 3 + 0];
      const py = positions[i * 3 + 1];
      const pz = positions[i * 3 + 2];
      // Shrink y to fit box; clamp x to faces.
      const tx = THREE.MathUtils.clamp(px, -0.22, 0.22);
      const ty = THREE.MathUtils.clamp(py, -0.22, 0.22);
      const tz = pz; // preserve depth so morph doesn't z-collapse
      // Project to nearest face of the box. Find which axis is largest.
      const ax = Math.abs(tx);
      const ay = Math.abs(ty);
      const az = Math.abs(tz);
      let fx = tx,
        fy = ty,
        fz = tz;
      if (ax > ay && ax > az) {
        fx = Math.sign(tx) * 0.22;
      } else if (ay > az) {
        fy = Math.sign(ty) * 0.22;
      } else {
        fz = Math.sign(tz) * 0.22;
      }
      targets[i * 3 + 0] = fx;
      targets[i * 3 + 1] = fy;
      targets[i * 3 + 2] = fz;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geom.setAttribute('targetPosition', new THREE.BufferAttribute(targets, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMorph: { value: 0 },
        uColorA: { value: new THREE.Color(PALETTE_BRACE) },
        uColorB: { value: new THREE.Color(PALETTE_BLOCK) },
        uOpacity: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
    });

    this.braceMesh = new THREE.Mesh(geom, this.material);
    this.group.add(this.braceMesh);
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
    // Map 0.15..0.75 of scroll to 0..1 morph; clamp outside.
    const t = THREE.MathUtils.clamp((scrollProgress - 0.15) / 0.60, 0, 1);
    this.smoothMorph += (t - this.smoothMorph) * 0.10;
    this.material.uniforms.uMorph.value = this.smoothMorph;

    const targetOpacity =
      scrollProgress < 0.15
        ? scrollProgress / 0.15
        : scrollProgress > 0.85
        ? Math.max(0, 1 - (scrollProgress - 0.85) / 0.15)
        : 1;
    this.opacity += (targetOpacity - this.opacity) * 0.12;
    this.material.uniforms.uOpacity.value = this.opacity;
  }

  setTransform(position: THREE.Vector3, scale: number): void {
    this.group.position.copy(position);
    this.group.scale.setScalar(scale);
  }

  getLeaderAnchor(out: THREE.Vector3): THREE.Vector3 {
    out.set(-0.36, 0, 0).multiplyScalar(this.group.scale.x);
    out.add(this.group.position);
    return out;
  }

  dispose(scene: THREE.Scene): void {
    this.unmount(scene);
    this.braceMesh.geometry.dispose();
    this.material.dispose();
  }
}
