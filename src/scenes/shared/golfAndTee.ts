import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import {
  buildGolfBallMaterial,
  type GolfBallMaterialOptions,
} from './golfBall';

/**
 * Combined GolfAndTee.glb loader — single source of truth for the BALL and TEE
 * meshes. Replaces the previous separate `loadGolfBallGeometry` + `loadGolfTeeGeometry`
 * helpers which targeted `/models/golf_ball.glb` and `/models/golf_tee.glb`
 * respectively. The artist now ships ONE model file with both meshes, and the
 * tee is positioned beneath the ball as "ball-on-tee" in the source.
 *
 * Mesh extraction strategy (single GLB, two named meshes):
 *   - BALL: `name` includes "GeoSphere" OR cubeLikeness >= 0.9
 *   - TEE:  `name` includes "Line"      OR cubeLikeness < 0.5 AND height/width > 1.5
 *
 * Each is centered on origin (after baking world transforms), then normalized:
 *   - BALL → bounding-sphere radius 0.5  (matches existing BALL_RADIUS)
 *   - TEE  → bounding-box height 0.6     (taller than wide; sphere-radius would over-shrink)
 *
 * The tee is then rotated so its long axis aligns with world +Y (Three is Y-up;
 * source files vary). Upper/lower half-radius distribution detects upside-down
 * (wide base on top → flip 180°).
 *
 * `ballOffsetOnTee` is computed from the *original* (pre-normalize) world
 * centroids of the two meshes, then scaled by the tee's normalize factor —
 * giving the on-tee resting position in TEE-LOCAL units. Consumers
 * (FlythroughScene) build a Group with the tee at origin and the ball at
 * `ballOffsetOnTee`. Final per-frame visual scale is applied to the Group.
 */

const DEFAULT_URL = '/models/GolfAndTee.glb';
const BALL_TEE_GAP = 0.005; // tiny visual seating between ball-bottom and tee-top.

export interface TeeMetrics {
  topY: number;
  bottomY: number;
  height: number;
}

export interface LoadGolfAndTeeResult {
  ballGeom: THREE.BufferGeometry;
  teeGeom: THREE.BufferGeometry;
  /** Ball offset (relative to tee root, with tee normalized). y component
   *  ensures the ball's BOTTOM rests on the tee's TOP minus BALL_TEE_GAP. */
  ballOffsetOnTee: THREE.Vector3;
  teeMetrics: TeeMetrics;
}

let _cache: LoadGolfAndTeeResult | null = null;
let _promise: Promise<LoadGolfAndTeeResult> | null = null;

interface MeshEntry {
  name: string;
  geom: THREE.BufferGeometry;
  vertCount: number;
  cubeLikeness: number;
  worldCenter: THREE.Vector3;
  bbSize: THREE.Vector3;
}

function bakeAndAnalyze(o: THREE.Mesh): MeshEntry {
  const g = o.geometry.clone();
  o.updateWorldMatrix(true, false);
  g.applyMatrix4(o.matrixWorld);
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const sx = bb.max.x - bb.min.x;
  const sy = bb.max.y - bb.min.y;
  const sz = bb.max.z - bb.min.z;
  const minA = Math.max(1e-6, Math.min(sx, sy, sz));
  const maxA = Math.max(sx, sy, sz);
  const center = new THREE.Vector3(
    (bb.max.x + bb.min.x) * 0.5,
    (bb.max.y + bb.min.y) * 0.5,
    (bb.max.z + bb.min.z) * 0.5
  );
  return {
    name: o.name ?? '',
    geom: g,
    vertCount: g.attributes.position?.count ?? 0,
    cubeLikeness: minA / maxA,
    worldCenter: center,
    bbSize: new THREE.Vector3(sx, sy, sz),
  };
}

/**
 * Pick the BALL: prefer a mesh whose name includes "GeoSphere", else the most
 * cube-like mesh (cubeLikeness >= 0.9 with the highest vertex count).
 */
function pickBall(entries: MeshEntry[]): MeshEntry {
  const named = entries.find((e) => /GeoSphere/i.test(e.name));
  if (named) return named;
  const cubeLike = entries.filter((e) => e.cubeLikeness >= 0.9 && e.vertCount > 1000);
  if (cubeLike.length > 0) {
    return cubeLike.reduce((a, b) => (a.vertCount > b.vertCount ? a : b));
  }
  // Fall back to the entry with the highest vertex count — golf-ball mesh has
  // the most polygons by far in any sane export.
  return entries.reduce((a, b) => (a.vertCount > b.vertCount ? a : b));
}

/**
 * Pick the TEE: prefer a mesh whose name includes "Line" (matches the source
 * `Line001` mesh), else the entry with low cubeLikeness AND tallness ratio.
 */
function pickTee(entries: MeshEntry[], ball: MeshEntry): MeshEntry {
  const named = entries.find((e) => /Line/i.test(e.name) && e !== ball);
  if (named) return named;
  // Tall + narrow — height / max(width, depth) > 1.5
  const tall = entries.filter((e) => {
    if (e === ball) return false;
    const w = Math.max(e.bbSize.x, e.bbSize.z);
    return e.bbSize.y / Math.max(w, 1e-6) > 1.5 && e.cubeLikeness < 0.5;
  });
  if (tall.length > 0) return tall[0];
  // Last resort: any non-ball mesh.
  const nonBall = entries.filter((e) => e !== ball);
  if (nonBall.length > 0) return nonBall[0];
  // Should not happen in practice — return the ball-as-tee fallback so callers
  // don't crash. The visual will be wrong but the app keeps booting.
  return ball;
}

/**
 * Center geometry on origin and uniformly scale so its bounding-sphere radius
 * is exactly 0.5 (matches the existing BALL_RADIUS contract for stencil + physics).
 */
function normalizeBallGeom(geom: THREE.BufferGeometry): {
  geom: THREE.BufferGeometry;
  origCenter: THREE.Vector3;
  scale: number;
} {
  geom.computeBoundingSphere();
  const bs = geom.boundingSphere;
  if (!bs) throw new Error('golfAndTee: failed to compute ball bounding sphere');
  const origCenter = bs.center.clone();
  geom.translate(-bs.center.x, -bs.center.y, -bs.center.z);
  const scale = 0.5 / bs.radius;
  geom.scale(scale, scale, scale);
  geom.computeBoundingSphere();
  geom.computeBoundingBox();
  if (!geom.attributes.normal) geom.computeVertexNormals();
  return { geom, origCenter, scale };
}

/**
 * Center, scale (using `proportionalScale` so the tee retains its original
 * size relative to the BALL), and rotate the tee geometry so the tip points
 * up. The ball is normalized first; passing in the ball's normalize factor
 * here keeps ball/tee at their authored relative proportions.
 */
function normalizeTeeGeom(
  geom: THREE.BufferGeometry,
  proportionalScale: number
): {
  geom: THREE.BufferGeometry;
  origCenter: THREE.Vector3;
  scale: number;
  metrics: TeeMetrics;
} {
  geom.computeBoundingBox();
  const bb0 = geom.boundingBox!;
  const origCenter = new THREE.Vector3(
    (bb0.max.x + bb0.min.x) * 0.5,
    (bb0.max.y + bb0.min.y) * 0.5,
    (bb0.max.z + bb0.min.z) * 0.5
  );
  // Center on origin.
  geom.translate(-origCenter.x, -origCenter.y, -origCenter.z);
  geom.computeBoundingBox();
  const bb1 = geom.boundingBox!;
  const sx = bb1.max.x - bb1.min.x;
  const sy = bb1.max.y - bb1.min.y;
  const sz = bb1.max.z - bb1.min.z;

  // Find longest axis; rotate so it becomes Y.
  let longest: 'x' | 'y' | 'z' = 'y';
  if (sx >= sy && sx >= sz) longest = 'x';
  else if (sz >= sx && sz >= sy) longest = 'z';
  else longest = 'y';
  if (longest === 'z') geom.rotateX(-Math.PI / 2);
  else if (longest === 'x') geom.rotateZ(Math.PI / 2);

  // Apply the BALL's normalize factor so the tee keeps its original size
  // relative to the ball. With ball normalized to radius 0.5 and the
  // proportional scale applied here, ball/tee retain authored proportions.
  const scale = proportionalScale;
  geom.scale(scale, scale, scale);
  geom.computeBoundingBox();
  geom.computeBoundingSphere();

  // Orient so the WIDE FLAT TOP (where the ball sits) is at +Y and the narrow
  // tapered POINT (sticks into the turf) is at -Y.
  //
  // A real golf tee has its wide flat surface ON TOP (cradles the ball) and a
  // narrow point on the bottom that's pushed into the turf. The shipped
  // GolfAndTee.glb authors the tee with its wide end at +Y already (verified
  // by per-half radius distribution: upper half avg radius ≈ 0.47 vs lower
  // half ≈ 0.30 in source units — wider-on-top is the authored convention).
  //
  // Previous logic flipped 180° whenever upper-half radius exceeded lower-half
  // — that was based on the wrong real-world model (a "spike on top" tee). We
  // now flip ONLY if the GLB ever ships with a narrow-on-top author error
  // (avgUp << avgLo). Keep the heuristic but reverse the comparison for safety.
  const pos = geom.attributes.position;
  let upperR = 0;
  let lowerR = 0;
  let countUp = 0;
  let countLo = 0;
  const bb3 = geom.boundingBox!;
  const yMid = (bb3.max.y + bb3.min.y) * 0.5;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const r = Math.sqrt(x * x + z * z);
    if (y > yMid) {
      upperR += r;
      countUp++;
    } else {
      lowerR += r;
      countLo++;
    }
  }
  const avgUp = countUp > 0 ? upperR / countUp : 0;
  const avgLo = countLo > 0 ? lowerR / countLo : 0;
  // Only flip if the WIDE end is at the BOTTOM (avgLo significantly > avgUp).
  // This handles a hypothetical re-export with the opposite convention without
  // mis-flipping the current GolfAndTee.glb (which is already wide-top).
  if (avgLo > avgUp * 1.05) {
    geom.rotateX(Math.PI);
    geom.computeBoundingBox();
  }

  if (!geom.attributes.normal) geom.computeVertexNormals();
  geom.computeBoundingSphere();

  const finalBB = geom.boundingBox!;
  const metrics: TeeMetrics = {
    topY: finalBB.max.y,
    bottomY: finalBB.min.y,
    height: finalBB.max.y - finalBB.min.y,
  };
  return { geom, origCenter, scale, metrics };
}

/**
 * Load and cache the combined GolfAndTee GLB; extract + normalize ball + tee.
 */
export async function loadGolfAndTee(url: string = DEFAULT_URL): Promise<LoadGolfAndTeeResult> {
  if (_cache) return _cache;
  if (_promise) return _promise;

  const loader = new GLTFLoader();
  _promise = (async (): Promise<LoadGolfAndTeeResult> => {
    const gltf = await loader.loadAsync(url);

    const entries: MeshEntry[] = [];
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) {
        entries.push(bakeAndAnalyze(m));
      }
    });
    if (entries.length === 0) {
      throw new Error('golfAndTee: no mesh found in GLB');
    }

    const ballEntry = pickBall(entries);
    const teeEntry = pickTee(entries, ballEntry);

    // Capture original world centroids BEFORE normalize for the offset calc.
    const ballOrigCenter = ballEntry.worldCenter.clone();
    const teeOrigCenter = teeEntry.worldCenter.clone();

    const ballNorm = normalizeBallGeom(ballEntry.geom);
    // Apply the ball's normalize factor to the tee so they retain their
    // authored size proportions.
    const teeNorm = normalizeTeeGeom(teeEntry.geom, ballNorm.scale);

    // Compute the ball offset on the (normalized) tee. We don't actually need
    // the original-space delta — the simplest correct seating is "ball bottom
    // sits on tee top minus tiny gap". X/Z = 0 (tee axis is Y; ball sits on
    // the axis).
    const BALL_RADIUS = 0.5;
    const ballOffsetOnTee = new THREE.Vector3(
      0,
      teeNorm.metrics.topY + BALL_RADIUS - BALL_TEE_GAP,
      0
    );
    // Reference origCenter / origScale to keep them live for future tuning.
    void ballOrigCenter;
    void teeOrigCenter;
    void ballNorm.origCenter;
    void teeNorm.origCenter;

    const result: LoadGolfAndTeeResult = {
      ballGeom: ballNorm.geom,
      teeGeom: teeNorm.geom,
      ballOffsetOnTee,
      teeMetrics: teeNorm.metrics,
    };
    _cache = result;
    _promise = null;
    return result;
  })();

  return _promise;
}

export function getCachedGolfAndTee(): LoadGolfAndTeeResult | null {
  return _cache;
}

export function disposeGolfAndTee(): void {
  if (_cache) {
    _cache.ballGeom.dispose();
    _cache.teeGeom.dispose();
    _cache = null;
  }
}

// ---------------------------------------------------------------------------
// "Just the ball" builder (HeroScene + ContactScene). Returns a Group with
// the dimpled ball + an inner fill-sphere (mirrors the GLB-only behavior in
// the legacy golfBall.ts builder).
// ---------------------------------------------------------------------------

export interface BuildBallMeshResult {
  /** A THREE.Group cast as Mesh for backwards compat with consumers that
   *  only read .position / .scale / .rotation. */
  mesh: THREE.Mesh;
  /** Outer dimpled-shell material (caller drives stencil + uOpacity). */
  material: THREE.ShaderMaterial;
  /** Inner fill-sphere material (caller mirrors stencil + uOpacity). */
  fillMaterial: THREE.ShaderMaterial;
  /** The cached BALL geometry (referenced — do NOT dispose). */
  geometry: THREE.BufferGeometry;
}

export async function buildBallMesh(
  matcap: THREE.Texture,
  options?: GolfBallMaterialOptions
): Promise<BuildBallMeshResult> {
  const { ballGeom } = await loadGolfAndTee();
  const useDimpleMap = options?.useDimpleMap ?? false;
  const material = buildGolfBallMaterial(matcap, null, { ...options, useDimpleMap });
  const dimpledMesh = new THREE.Mesh(ballGeom, material);
  dimpledMesh.frustumCulled = false;

  // Inner fill sphere (closes FrontSide-culled dimple cavities).
  const fillGeom = new THREE.SphereGeometry(0.5 * 0.965, 64, 48);
  const fillMaterial = buildGolfBallMaterial(matcap, null, {
    ...options,
    useDimpleMap: false,
    matcapSoftness: 1.0,
    rimStrength: 0.0,
    transparent: options?.transparent ?? false,
  });
  const fillMesh = new THREE.Mesh(fillGeom, fillMaterial);
  fillMesh.frustumCulled = false;
  fillMesh.renderOrder = -1;

  const group = new THREE.Group();
  group.add(fillMesh);
  group.add(dimpledMesh);

  return {
    mesh: group as unknown as THREE.Mesh,
    material,
    fillMaterial,
    geometry: ballGeom,
  };
}

// ---------------------------------------------------------------------------
// "Ball-on-tee combined Group" — for FlythroughScene's resting state.
// ---------------------------------------------------------------------------

export interface BuildBallAndTeeGroupResult {
  /** Group with both ball (with its inner fill-sphere) and tee. */
  group: THREE.Group;
  /** The ball Group (cast as Mesh) — this is the parent of the dimpled mesh
   *  + the inner fill-sphere. Consumers can re-parent THIS to the scene root
   *  to "detach" the ball at hit-launch (preserving its world matrix). */
  ballMesh: THREE.Mesh;
  /** The tee mesh — stays parented to `group`. */
  teeMesh: THREE.Mesh;
  /** Ball outer material (mirrors `buildBallMesh.material`). */
  ballMaterial: THREE.ShaderMaterial;
  /** Ball inner fill material. */
  ballFillMaterial: THREE.ShaderMaterial;
  /** Tee material (a Lambert; flythrough uses warm wood color). */
  teeMaterial: THREE.MeshLambertMaterial;
  /** The ball's local offset within the group (= ballOffsetOnTee). */
  ballOffset: THREE.Vector3;
  /** Cached ball geometry — held as a reference so callers can identify it
   *  during disposal walks (e.g., to skip disposing the shared cache). */
  geometry: THREE.BufferGeometry;
  /** Cached tee geometry — same disposal-skip role. */
  teeGeometry: THREE.BufferGeometry;
}

export async function buildBallAndTeeGroup(
  matcap: THREE.Texture,
  options?: GolfBallMaterialOptions
): Promise<BuildBallAndTeeGroupResult> {
  const { teeGeom, ballOffsetOnTee } = await loadGolfAndTee();

  // Ball — full shaded ball with inner fill sphere.
  const ballBuilt = await buildBallMesh(matcap, options);
  // The cached ballGeom is shared; ballBuilt.mesh is a NEW Group instance.
  const ballGroup = ballBuilt.mesh;
  ballGroup.position.copy(ballOffsetOnTee);

  // Tee — Lambert material so it picks up the same ambient + key light Hero
  // already injects.
  const teeMaterial = new THREE.MeshLambertMaterial({
    color: 0xb88a55, // warm wood brown
    emissive: 0x000000,
  });
  const teeMesh = new THREE.Mesh(teeGeom, teeMaterial);
  teeMesh.frustumCulled = false;

  const group = new THREE.Group();
  group.add(teeMesh);
  group.add(ballGroup);

  return {
    group,
    ballMesh: ballGroup,
    teeMesh,
    ballMaterial: ballBuilt.material,
    ballFillMaterial: ballBuilt.fillMaterial,
    teeMaterial,
    ballOffset: ballOffsetOnTee.clone(),
    geometry: ballBuilt.geometry,
    teeGeometry: teeGeom,
  };
}

/**
 * Detach the ball from the combined group while preserving its world position.
 * The tee stays parented to `group`. Re-parents the ball to `scene` so its
 * world matrix is preserved (THREE.Object3D.attach handles the math).
 */
export function detachBallForLaunch(
  _group: THREE.Group,
  ballMesh: THREE.Mesh,
  scene: THREE.Scene
): void {
  if (ballMesh.parent === scene) return; // already detached
  scene.attach(ballMesh);
}
