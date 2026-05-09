import * as THREE from 'three';

/**
 * Shared golf-ball builder.
 *
 * Both HeroScene (step 02) and ContactScene (step 07) render the same dimpled
 * pearl-matcap ball. To preserve visual continuity ("the same ball travels the
 * site"), we extract:
 *   - the procedural Fibonacci-lattice dimple normal map
 *   - the matcap+dimple+fresnel ShaderMaterial
 *   - a one-shot "build me a ready-to-use ball mesh" helper
 *
 * Behavior is identical to the original HeroScene helpers (which are now thin
 * wrappers around these). Do not change defaults without touching both scenes.
 */

// -----------------------------------------------------------------------------
// Procedural dimple normal map
// -----------------------------------------------------------------------------

/**
 * Build a `size`×`size` RGBA normal map with `dimpleCount` dimples laid out in
 * a Fibonacci lattice across the UV plane. See HeroScene history for the full
 * derivation; in summary:
 *
 *   - Start with flat-up tangent normal (128,128,255) everywhere.
 *   - For each dimple center, rasterize a circular depression with smoothstep
 *     radial profile h(r) = -depth * (4t(1-t))  (t = r/R).
 *   - Encode tangent-space normal n = normalize(-dh/du, -dh/dv, 1) → RGB.
 *
 * Why a 2D normal map and not displacement: matcap shading is rotationally
 * symmetric in screen space, so perturbing the view-space normal in xy by the
 * tangent-space normal's xy reads as if the surface were actually dimpled.
 */
export function buildDimpleNormalMap(
  size: number = 512,
  dimpleCount: number = 250,
  dimpleRadiusPx: number = 14,
  dimpleDepth: number = 0.55
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('golfBall: failed to acquire 2D context for dimple map');
  }

  const img = ctx.createImageData(size, size);
  const data = img.data;

  // Flat-up baseline normal (0,0,1) → (128,128,255)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 128;
    data[i + 1] = 128;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }

  // Fibonacci lattice in [0,1)^2 — uniform spread, no banding.
  const PHI = (1 + Math.sqrt(5)) / 2;
  const dimples: { cx: number; cy: number }[] = [];
  for (let i = 0; i < dimpleCount; i++) {
    const u = (i / PHI) % 1;
    const v = (i + 0.5) / dimpleCount;
    dimples.push({ cx: u * size, cy: v * size });
  }

  const R = dimpleRadiusPx;

  for (const { cx, cy } of dimples) {
    const minX = Math.max(0, Math.floor(cx - R));
    const maxX = Math.min(size - 1, Math.ceil(cx + R));
    const minY = Math.max(0, Math.floor(cy - R));
    const maxY = Math.min(size - 1, Math.ceil(cy + R));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r > R) continue;
        const t = r / R;
        // Inward dent: h(t) = -depth * 4t(1-t), so dh/dr = -depth*(4-8t)/R.
        const dhdr = -dimpleDepth * (4 - 8 * t) / R;
        const inv_r = r > 1e-4 ? 1 / r : 0;
        const gx = dhdr * dx * inv_r;
        const gy = dhdr * dy * inv_r;

        const nx = -gx;
        const ny = -gy;
        const nz = 1;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        const nnx = nx / len;
        const nny = ny / len;
        const nnz = nz / len;

        const idx = (y * size + x) * 4;
        data[idx] = Math.round((nnx * 0.5 + 0.5) * 255);
        data[idx + 1] = Math.round((nny * 0.5 + 0.5) * 255);
        data[idx + 2] = Math.round((nnz * 0.5 + 0.5) * 255);
        data[idx + 3] = 255;
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace; // normal maps are linear data, not sRGB
  tex.needsUpdate = true;
  return tex;
}

// -----------------------------------------------------------------------------
// Shaders (matcap + dimple normal + fresnel rim)
// -----------------------------------------------------------------------------

export const GOLF_BALL_VERT = /* glsl */ `
  varying vec3 vViewNormal;
  varying vec3 vViewPosition;
  varying vec2 vUv;

  void main() {
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPos;
    vViewNormal = normalize(normalMatrix * normal);
    vViewPosition = -mvPos.xyz;

    // Spherical UV from object-space normal — avoids SphereGeometry pole stretch.
    vec3 n = normalize(position);
    float u = atan(n.z, n.x) / 6.2831853 + 0.5;
    float v = asin(n.y) / 3.1415926 + 0.5;
    vUv = vec2(u * 4.0, v * 2.0);
  }
`;

export const GOLF_BALL_FRAG = /* glsl */ `
  precision highp float;

  uniform sampler2D uMatcap;
  uniform sampler2D uDimple;
  uniform float     uRimStrength;
  uniform vec3      uRimColor;
  uniform float     uDimpleStrength;
  uniform float     uOpacity;

  varying vec3 vViewNormal;
  varying vec3 vViewPosition;
  varying vec2 vUv;

  vec3 unpackNormal(vec3 rgb) {
    return normalize(rgb * 2.0 - 1.0);
  }

  void main() {
    vec3 nT = unpackNormal(texture2D(uDimple, vUv).rgb);
    vec3 n = normalize(vViewNormal + vec3(nT.x, nT.y, 0.0) * uDimpleStrength);

    vec2 matcapUv = n.xy * 0.5 + 0.5;
    vec3 matcap = texture2D(uMatcap, matcapUv).rgb;

    vec3 viewDir = normalize(vViewPosition);
    float fresnel = pow(1.0 - max(dot(viewDir, n), 0.0), 3.0);
    vec3 rim = uRimColor * fresnel * uRimStrength;

    vec3 col = matcap + rim;
    gl_FragColor = vec4(col, uOpacity);
  }
`;

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface GolfBallMaterialOptions {
  /** 0..1, fresnel rim term (default 0.35 — subtle). */
  rimStrength?: number;
  /** Rim tint color (default cool blue). */
  rimColor?: THREE.Color;
  /** 0..1, how strongly the dimple normal perturbs (default 0.55). */
  dimpleStrength?: number;
  /** Initial alpha (default 1.0). Use ShaderMaterial.uniforms.uOpacity to animate. */
  opacity?: number;
  /** Set to true if you want the ball to fade out — enables blending. */
  transparent?: boolean;
}

/**
 * Build the matcap+dimple+fresnel ShaderMaterial. Caller owns matcap + dimple
 * textures (we hold references via uniforms but do not dispose them).
 *
 * Stencil props are NOT set here — caller decides (Hero uses ref=1, Contact
 * uses no stencil because it's full-viewport).
 */
export function buildGolfBallMaterial(
  matcap: THREE.Texture,
  dimple: THREE.Texture,
  opts: GolfBallMaterialOptions = {}
): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMatcap: { value: matcap },
      uDimple: { value: dimple },
      uRimStrength: { value: opts.rimStrength ?? 0.35 },
      uRimColor: { value: opts.rimColor ?? new THREE.Color(0x9ec3d6) },
      uDimpleStrength: { value: opts.dimpleStrength ?? 0.55 },
      uOpacity: { value: opts.opacity ?? 1.0 },
    },
    vertexShader: GOLF_BALL_VERT,
    fragmentShader: GOLF_BALL_FRAG,
    transparent: opts.transparent ?? false,
  });
  return mat;
}

export interface GolfBallMeshResult {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  geometry: THREE.SphereGeometry;
}

/**
 * One-shot helper: build a ball mesh ready to add to a scene. Caller owns
 * disposal of geometry/material/textures (textures are passed in).
 *
 * Default radius matches HeroScene's BALL_RADIUS (0.5).
 */
export function buildGolfBallMesh(
  matcap: THREE.Texture,
  dimple: THREE.Texture,
  radius: number = 0.5,
  segments: number = 64,
  matOpts?: GolfBallMaterialOptions
): GolfBallMeshResult {
  const geometry = new THREE.SphereGeometry(radius, segments, segments);
  const material = buildGolfBallMaterial(matcap, dimple, matOpts);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return { mesh, material, geometry };
}
