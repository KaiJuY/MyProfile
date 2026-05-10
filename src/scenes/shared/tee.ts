import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Shared golf-tee builder.
 *
 * The tee model is loaded from `/models/golf_tee.glb`. We use the same
 * spatial-cluster mesh-pick + bounding-sphere normalisation pattern as the
 * ball loader (some artist exports include LOD copies / arrays of tees), so
 * the resulting geometry is centered on the origin and uniformly scaled to a
 * known reference size that callers can scale into world units.
 *
 * Reference size: bounding-sphere radius = 0.5. Callers (FlythroughScene)
 * apply their own per-frame scale based on the CSS tee div's
 * getBoundingClientRect.
 *
 * Currently consumed only by FlythroughScene. If a future scene reuses the
 * tee, the cache below already covers it.
 */

let _teeGeomCache: THREE.BufferGeometry | null = null;
let _teeGeomPromise: Promise<THREE.BufferGeometry> | null = null;

/**
 * Tee orientation metrics (computed once after the geometry is normalized).
 * - `topY`: world-Y of the tee's tip (ball-resting point) in geometry-local
 *   space, in the same units as the bounding-sphere radius (≈ 0.5).
 * Consumers multiply by their per-frame mesh.scale to convert to world units.
 */
export interface TeeMetrics {
  topY: number;
  bottomY: number;
  height: number;
}
let _teeMetrics: TeeMetrics | null = null;
export function getTeeMetrics(): TeeMetrics | null {
  return _teeMetrics;
}

export async function loadGolfTeeGeometry(
  url: string = '/models/golf_tee.glb'
): Promise<THREE.BufferGeometry> {
  if (_teeGeomCache) return _teeGeomCache;
  if (_teeGeomPromise) return _teeGeomPromise;

  const loader = new GLTFLoader();
  _teeGeomPromise = (async () => {
    const gltf = await loader.loadAsync(url);

    interface MeshEntry {
      geom: THREE.BufferGeometry;
      vertCount: number;
      cx: number;
      cy: number;
      cz: number;
    }
    const entries: MeshEntry[] = [];
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) {
        const g = m.geometry.clone();
        m.updateWorldMatrix(true, false);
        g.applyMatrix4(m.matrixWorld);
        g.computeBoundingSphere();
        const bs = g.boundingSphere!;
        entries.push({
          geom: g,
          vertCount: g.attributes.position?.count ?? 0,
          cx: bs.center.x,
          cy: bs.center.y,
          cz: bs.center.z,
        });
      }
    });

    if (entries.length === 0) {
      throw new Error('tee: no mesh found in GLB');
    }

    const primary = entries.reduce((a, b) => (a.vertCount > b.vertCount ? a : b));
    const primaryR = (primary.geom.boundingSphere?.radius ?? 1) * 0.5;
    interface Cluster {
      meshes: MeshEntry[];
      totalVerts: number;
      cx: number;
      cy: number;
      cz: number;
    }
    const clusters: Cluster[] = [];
    for (const e of entries) {
      const found = clusters.find(
        (c) => Math.hypot(c.cx - e.cx, c.cy - e.cy, c.cz - e.cz) < primaryR
      );
      if (found) {
        found.meshes.push(e);
        found.totalVerts += e.vertCount;
      } else {
        clusters.push({
          meshes: [e],
          totalVerts: e.vertCount,
          cx: e.cx,
          cy: e.cy,
          cz: e.cz,
        });
      }
    }
    const winner = clusters.reduce((a, b) => (a.totalVerts > b.totalVerts ? a : b));

    let geom: THREE.BufferGeometry;
    if (winner.meshes.length === 1) {
      geom = winner.meshes[0].geom;
    } else {
      const allowedAttrs = ['position', 'normal', 'uv'];
      const winnerGeoms = winner.meshes.map((m) => m.geom);
      for (const g of winnerGeoms) {
        for (const name of Object.keys(g.attributes)) {
          if (!allowedAttrs.includes(name)) g.deleteAttribute(name);
        }
      }
      const merged = mergeGeometries(winnerGeoms, false);
      if (!merged) {
        const largest = winner.meshes.reduce((a, b) =>
          a.vertCount > b.vertCount ? a : b
        );
        geom = largest.geom;
      } else {
        geom = merged;
      }
    }

    // Center on origin and normalize to bounding-sphere radius 0.5.
    geom.computeBoundingSphere();
    const bs = geom.boundingSphere;
    if (!bs) throw new Error('tee: failed to compute bounding sphere');
    geom.translate(-bs.center.x, -bs.center.y, -bs.center.z);
    const scale = 0.5 / bs.radius;
    geom.scale(scale, scale, scale);
    geom.computeBoundingSphere();
    geom.computeBoundingBox();

    if (!geom.attributes.normal) geom.computeVertexNormals();

    // ── Canonical orientation: tee point UP, base DOWN ───────────────────
    // The source GLB is authored in Blender's Z-up convention (its long
    // axis runs along +Z). Three.js is Y-up, so without a fixup the tee
    // appears lying on its side / upside-down (issue #2 from user
    // feedback: "Tee 現在是倒的他應該垂直於畫面才對").
    //
    // Strategy: pick the tee's primary (longest) axis from its OBB; rotate
    // so that axis aligns with world +Y; then flip if the wider-base end
    // is on top. This is robust against any future tee model regardless of
    // its source authoring convention.
    geom.computeBoundingBox();
    const bb = geom.boundingBox!;
    const sx = bb.max.x - bb.min.x;
    const sy = bb.max.y - bb.min.y;
    const sz = bb.max.z - bb.min.z;
    // Find which axis is the longest — that's the "vertical" axis of the tee.
    let longest: 'x' | 'y' | 'z' = 'y';
    if (sx >= sy && sx >= sz) longest = 'x';
    else if (sz >= sx && sz >= sy) longest = 'z';
    else longest = 'y';
    if (longest === 'z') {
      // Z-up source (Blender default) → Y-up.
      geom.rotateX(-Math.PI / 2);
    } else if (longest === 'x') {
      geom.rotateZ(Math.PI / 2);
    }
    // Recompute after rotation to test "which end is the wider base".
    geom.computeBoundingBox();
    const bb2 = geom.boundingBox!;
    // Sample point distribution along Y to find where the geometry is widest.
    // The base of a tee is wider than the tip; if the wide end is currently
    // pointing UP (+Y), flip 180° so the wide BASE sits at -Y and the tip
    // points UP.
    const pos = geom.attributes.position;
    let halfRadiusUpper = 0;
    let halfRadiusLower = 0;
    let countUpper = 0;
    let countLower = 0;
    const yMid = (bb2.max.y + bb2.min.y) * 0.5;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const r = Math.sqrt(x * x + z * z);
      if (y > yMid) {
        halfRadiusUpper += r;
        countUpper++;
      } else {
        halfRadiusLower += r;
        countLower++;
      }
    }
    const avgUpper = countUpper > 0 ? halfRadiusUpper / countUpper : 0;
    const avgLower = countLower > 0 ? halfRadiusLower / countLower : 0;
    // Heuristic: a real tee has cup/tip on top (smaller avg radius) and
    // base on bottom (slightly larger avg radius near the foot peg). If
    // upper average is LARGER than lower, the tee is upside-down — flip.
    if (avgUpper > avgLower * 1.05) {
      geom.rotateX(Math.PI);
      geom.computeBoundingBox();
    }
    geom.computeBoundingSphere();

    // Cache orientation metrics for the consuming scene (FlythroughScene
    // uses topY to seat the ball on the tip like a rigid body — issue #2b).
    const finalBB = geom.boundingBox!;
    _teeMetrics = {
      topY: finalBB.max.y,
      bottomY: finalBB.min.y,
      height: finalBB.max.y - finalBB.min.y,
    };

    _teeGeomCache = geom;
    _teeGeomPromise = null;
    return geom;
  })();

  return _teeGeomPromise;
}

/** Free the cached GLB tee geometry. Called only on full app teardown. */
export function disposeSharedTeeAssets(): void {
  if (_teeGeomCache) {
    _teeGeomCache.dispose();
    _teeGeomCache = null;
  }
}
