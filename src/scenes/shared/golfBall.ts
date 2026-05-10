import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Shared golf-ball builder.
 *
 * Both HeroScene (step 02) and ContactScene (step 07) render the same dimpled
 * pearl-matcap ball. To preserve visual continuity ("the same ball travels the
 * site"), we extract:
 *   - the procedural Fibonacci-lattice dimple normal map (legacy fallback)
 *   - the matcap+dimple+fresnel ShaderMaterial
 *   - a one-shot "build me a ready-to-use ball mesh" helper (procedural)
 *   - an async loader + builder that pulls a real GLB ball with baked dimple
 *     geometry from /models/golf_ball.glb (preferred path — Wave 2)
 *
 * Behavior is identical to the original HeroScene helpers (which are now thin
 * wrappers around these). Do not change defaults without touching both scenes.
 */

// -----------------------------------------------------------------------------
// Procedural dimple normal map (legacy fallback — kept exported so future
// scenes can opt back in without forking the shader)
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
// Shaders (matcap + optional dimple normal + fresnel rim)
//
// `uHasDimpleMap` switches between two paths in the fragment shader:
//   1.0 = sample the dimple normal map (legacy procedural sphere; baseline=1.0
//         keeps existing call-sites identical)
//   0.0 = use the geometry's own normal (GLB ball with real dimple geometry —
//         the matcap LUT alone delivers the highlight pattern correctly)
//
// When `uHasDimpleMap` is 0 we still bind a 1x1 dummy texture to `uDimple` so
// the sampler binding never resolves to null on platforms that fail with null
// sampler bindings (some Android GL drivers, and ANGLE in strict mode).
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
    // Used only when uHasDimpleMap > 0.5 (procedural path); harmless otherwise.
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
  uniform float     uHasDimpleMap;
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
    vec3 n = vViewNormal;
    if (uHasDimpleMap > 0.5) {
      vec3 nT = unpackNormal(texture2D(uDimple, vUv).rgb);
      n = normalize(vViewNormal + vec3(nT.x, nT.y, 0.0) * uDimpleStrength);
    }

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
// Public API — material
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
  /**
   * Whether the fragment shader should sample `uDimple` to perturb the view
   * normal. Default true for backwards-compatibility with the procedural ball.
   * Set false when the geometry itself has dimples baked in (GLB path).
   */
  useDimpleMap?: boolean;
}

let _dummyDimpleTex: THREE.DataTexture | null = null;

/** 1×1 transparent normal-map texture; used as a binding placeholder when
 *  `useDimpleMap=false` so the `uDimple` sampler always has something attached. */
function getDummyDimpleTexture(): THREE.DataTexture {
  if (_dummyDimpleTex) return _dummyDimpleTex;
  // Flat normal (0,0,1) encoded as RGB (128,128,255).
  const data = new Uint8Array([128, 128, 255, 255]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  _dummyDimpleTex = tex;
  return tex;
}

/**
 * Build the matcap+dimple+fresnel ShaderMaterial. Caller owns matcap + dimple
 * textures (we hold references via uniforms but do not dispose them).
 *
 * Pass `dimple = null` along with `opts.useDimpleMap = false` for the GLB
 * path (or simply pass `null` and let the auto-detect default kick in).
 *
 * Stencil props are NOT set here — caller decides (Hero uses ref=1, Contact
 * uses no stencil because it's full-viewport).
 */
export function buildGolfBallMaterial(
  matcap: THREE.Texture,
  dimple: THREE.Texture | null,
  opts: GolfBallMaterialOptions = {}
): THREE.ShaderMaterial {
  // If the caller provided no dimple texture, default to "dimple-map off" so
  // the shader uses the geometry's real normals. Caller can still override
  // explicitly by passing `useDimpleMap`.
  const useDimpleMap = opts.useDimpleMap ?? (dimple !== null);
  const dimpleBinding = dimple ?? getDummyDimpleTexture();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMatcap: { value: matcap },
      uDimple: { value: dimpleBinding },
      uHasDimpleMap: { value: useDimpleMap ? 1.0 : 0.0 },
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

// -----------------------------------------------------------------------------
// Procedural mesh builder (legacy — kept for fallback / tests)
// -----------------------------------------------------------------------------

export interface GolfBallMeshResult {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  geometry: THREE.SphereGeometry;
}

/**
 * One-shot helper: build a procedural ball mesh ready to add to a scene.
 * Caller owns disposal of geometry/material/textures (textures are passed in).
 *
 * Default radius matches HeroScene's BALL_RADIUS (0.5). Prefer
 * `buildGolfBallMeshFromGLB` for new code — it loads a real dimpled ball.
 */
export function buildGolfBallMesh(
  matcap: THREE.Texture,
  dimple: THREE.Texture,
  radius: number = 0.5,
  segments: number = 64,
  matOpts?: GolfBallMaterialOptions
): GolfBallMeshResult {
  const geometry = new THREE.SphereGeometry(radius, segments, segments);
  // Procedural path always uses the dimple normal map.
  const material = buildGolfBallMaterial(matcap, dimple, { ...matOpts, useDimpleMap: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return { mesh, material, geometry };
}

// -----------------------------------------------------------------------------
// GLB loader + builder (preferred path — Wave 2)
// -----------------------------------------------------------------------------

let _ballGeomCache: THREE.BufferGeometry | null = null;
let _ballGeomPromise: Promise<THREE.BufferGeometry> | null = null;

/**
 * Load and cache the golf-ball geometry from a GLB. We extract the mesh
 * geometries (merging if more than one), center the bounding sphere on the
 * origin, and uniformly scale so the bounding-sphere radius is 0.5 — matching
 * the procedural BALL_RADIUS that the Rapier colliders + stencil sizing assume.
 *
 * The full `gltf.scene` is intentionally NOT kept; the GLB's authored material
 * is discarded, since both consuming scenes apply our matcap+fresnel material
 * for visual continuity.
 *
 * Caches across calls (and across both consumer scenes — Hero loads first,
 * Contact reuses).
 */
export async function loadGolfBallGeometry(
  url: string = '/models/golf_ball.glb'
): Promise<THREE.BufferGeometry> {
  if (_ballGeomCache) return _ballGeomCache;
  if (_ballGeomPromise) return _ballGeomPromise;

  const loader = new GLTFLoader();
  _ballGeomPromise = (async () => {
    const gltf = await loader.loadAsync(url);

    // Walk the scene and collect every mesh's geometry. Some Sketchfab/Poly
    // exports split the ball into hemispheres or material groups — merging is
    // safest. If only one mesh exists, mergeGeometries is a no-op clone.
    const geoms: THREE.BufferGeometry[] = [];
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) {
        // Bake any per-mesh transform into the geometry so a merge preserves
        // shape regardless of nested node TRS.
        const g = m.geometry.clone();
        m.updateWorldMatrix(true, false);
        g.applyMatrix4(m.matrixWorld);
        geoms.push(g);
      }
    });

    if (geoms.length === 0) {
      throw new Error('golfBall: no mesh found in GLB');
    }

    // Merge if multiple. We strip non-position/normal/uv attributes first to
    // sidestep mismatched-attribute crashes from mergeGeometries when the
    // GLB has color/skinIndex/etc on only some sub-meshes.
    let geom: THREE.BufferGeometry;
    if (geoms.length === 1) {
      geom = geoms[0];
    } else {
      const allowedAttrs = ['position', 'normal', 'uv'];
      for (const g of geoms) {
        for (const name of Object.keys(g.attributes)) {
          if (!allowedAttrs.includes(name)) g.deleteAttribute(name);
        }
      }
      const merged = mergeGeometries(geoms, false);
      if (!merged) {
        // Fall back to the largest mesh by vertex count if merge fails (mixed
        // index/non-index, etc.).
        let largest = geoms[0];
        for (const g of geoms) {
          if ((g.attributes.position?.count ?? 0) > (largest.attributes.position?.count ?? 0)) {
            largest = g;
          }
        }
        geom = largest;
      } else {
        geom = merged;
      }
    }

    // Center on origin and normalize to bounding-sphere radius 0.5.
    geom.computeBoundingSphere();
    const bs = geom.boundingSphere;
    if (!bs) throw new Error('golfBall: failed to compute bounding sphere');
    geom.translate(-bs.center.x, -bs.center.y, -bs.center.z);
    const scale = 0.5 / bs.radius;
    geom.scale(scale, scale, scale);
    geom.computeBoundingSphere();
    geom.computeBoundingBox();

    if (!geom.attributes.normal) geom.computeVertexNormals();

    _ballGeomCache = geom;
    _ballGeomPromise = null;
    return geom;
  })();

  return _ballGeomPromise;
}

// Shared dimple-normal texture used by the GLB builder. Built lazily on first
// call so the procedural-fallback path (which builds its own) is unaffected.
let _sharedDimpleTex: THREE.CanvasTexture | null = null;
function getSharedDimpleTexture(): THREE.CanvasTexture {
  if (_sharedDimpleTex) return _sharedDimpleTex;
  _sharedDimpleTex = buildDimpleNormalMap(512, 250, 14, 0.55);
  return _sharedDimpleTex;
}

/**
 * Build a ball mesh using the GLB-derived geometry + our matcap+fresnel
 * material. Caller still owns the matcap texture; the cached geometry is
 * shared across instances (you can build many meshes that all reference it
 * — disposal is centralized in `disposeSharedGolfBallAssets`).
 *
 * The current `golf_ball.glb` is a low-poly base sphere (~960 tris, no
 * baked dimple geometry). We therefore still apply the procedural dimple
 * normal map on top — the GLB gives us authentic UVs / topology, the normal
 * map gives us the highlight pattern that makes it read as a golf ball.
 * If a future model has dimples baked into geometry, pass
 * `useDimpleMap: false` to skip the perturbation.
 *
 * Apply stencil props on the returned material from the call site (Hero uses
 * ref=1; Contact uses none).
 */
export async function buildGolfBallMeshFromGLB(
  matcap: THREE.Texture,
  options?: GolfBallMaterialOptions,
  url: string = '/models/golf_ball.glb'
): Promise<GolfBallMeshResult> {
  const geometry = await loadGolfBallGeometry(url);
  // Default to dimple-on (low-poly GLB needs the normal map for highlight
  // detail). Caller can opt out via `options.useDimpleMap = false` once the
  // GLB carries real dimple geometry.
  const useDimpleMap = options?.useDimpleMap ?? true;
  const dimple = useDimpleMap ? getSharedDimpleTexture() : null;
  const material = buildGolfBallMaterial(matcap, dimple, { ...options, useDimpleMap });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  // Cast for return-type compatibility with the procedural builder. Both
  // consumers treat .geometry as opaque (just call dispose if they own it),
  // and the GLB geometry is shared, so they should NOT dispose it.
  return { mesh, material, geometry: geometry as unknown as THREE.SphereGeometry };
}

/**
 * Free the cached GLB geometry (call only on full app teardown — both Hero
 * and Contact share this geometry, so single-scene dispose should NOT call
 * this).
 */
export function disposeSharedGolfBallAssets(): void {
  if (_ballGeomCache) {
    _ballGeomCache.dispose();
    _ballGeomCache = null;
  }
  if (_dummyDimpleTex) {
    _dummyDimpleTex.dispose();
    _dummyDimpleTex = null;
  }
  if (_sharedDimpleTex) {
    _sharedDimpleTex.dispose();
    _sharedDimpleTex = null;
  }
}
