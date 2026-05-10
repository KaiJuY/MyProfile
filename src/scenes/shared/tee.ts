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
