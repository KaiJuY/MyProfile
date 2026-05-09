import * as THREE from 'three';

/**
 * Screen-to-world projection helpers. Lusion's pattern: every animated 3D object
 * is anchored to a DOM element, and we read the element's bounding rect each
 * frame to derive the world-space target. This decouples 3D layout from 3D code —
 * the HTML layout drives where things render.
 *
 * All helpers below are pure: they read DOM + camera state, return Vector3 / size.
 * The caller is responsible for invoking them at the right cadence (typically
 * once per frame inside the RAF loop).
 */

const _ndc = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _direction = new THREE.Vector3();

/**
 * Convert an HTMLElement's center point to a world-space Vector3 sitting `distance`
 * units in front of the camera (along the camera-forward axis through the element
 * center).
 *
 * Algorithm:
 *  1. Get element's bounding rect, compute screen center
 *  2. Convert to NDC (-1..1 in both axes; y is flipped because screen-y grows down)
 *  3. Unproject NDC point at z = -1 (near-plane in NDC) to get a world-space ray origin
 *  4. Build ray direction (camera position → unprojected point)
 *  5. Walk along the ray by `distance` (in world units, NOT NDC units)
 *
 * The result is a world point that, when an object is placed there, visually
 * overlays the HTML element from the camera's POV.
 */
export function elementToWorld(
  element: HTMLElement,
  camera: THREE.PerspectiveCamera,
  distance: number,
  out: THREE.Vector3 = new THREE.Vector3()
): THREE.Vector3 {
  const rect = element.getBoundingClientRect();
  const screenX = rect.left + rect.width / 2;
  const screenY = rect.top + rect.height / 2;

  // Convert screen pixels to Normalized Device Coordinates
  // (origin at viewport center, x right-positive, y up-positive, both in [-1, 1])
  _ndc.set(
    (screenX / window.innerWidth) * 2 - 1,
    -((screenY / window.innerHeight) * 2 - 1),
    0.5 // arbitrary depth for unproject; we recompute the actual world position below
  );

  // Unproject: NDC + camera projection/view matrices → world space
  _ndc.unproject(camera);

  // Ray from camera origin through the unprojected point, normalized
  _origin.copy(camera.position);
  _direction.copy(_ndc).sub(_origin).normalize();

  // Walk along the ray for `distance` world-units. This places the result on a
  // sphere of radius `distance` around the camera, in the direction of the element.
  out.copy(_origin).addScaledVector(_direction, distance);
  return out;
}

/**
 * Compute the world-space size of an HTMLElement when rendered at `distance`
 * units from the camera. Useful for sizing 3D meshes to "fit" their HTML proxy.
 *
 * Math: at distance d from a perspective camera with vertical FOV f, the visible
 * world height is `h = 2 * d * tan(f/2)`. Width follows from aspect ratio.
 * Element world size = element pixel size / viewport pixel size * world size.
 */
export function elementToWorldSize(
  element: HTMLElement,
  camera: THREE.PerspectiveCamera,
  distance: number
): { width: number; height: number } {
  const rect = element.getBoundingClientRect();
  const fovRad = (camera.fov * Math.PI) / 180;
  const worldHeight = 2 * distance * Math.tan(fovRad / 2);
  const worldWidth = worldHeight * camera.aspect;
  return {
    width: (rect.width / window.innerWidth) * worldWidth,
    height: (rect.height / window.innerHeight) * worldHeight,
  };
}
