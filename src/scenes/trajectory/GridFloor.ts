import * as THREE from 'three';

/**
 * GridFloor — engineering-drawing-style ground plane that gives the camera
 * a sense of motion as it flies along the path.
 *
 * Implementation choice: ShaderMaterial-on-PlaneGeometry rather than
 * THREE.GridHelper. Reasons:
 *   1. We need radial fade-out toward the horizon (playbook §6 + footer:
 *      "工程圖紙感是『淡』，不是『密』"). GridHelper has no built-in fade —
 *      we'd have to add Fog AND tune each-frame, vs. a single fragment
 *      shader doing it cleanly.
 *   2. We want major lines every 1 unit AND minor lines every 0.2 unit
 *      with different opacity. GridHelper supports two grid spacings via
 *      its `divisions`/`divisions2` args but they share a single material
 *      so opacity per-line-set requires two GridHelpers stacked. Shader
 *      handles it in one mesh.
 *   3. Single draw call, ~30 lines of GLSL, very cheap.
 *
 * The grid is a large quad (50×50 world units) placed at y = -3 so the
 * camera (which at the path start is roughly at y=0..4) is always above
 * it. The shader computes line proximity in world-space xz coordinates
 * — which means the lines stay aligned to the world axes regardless of
 * how the plane mesh itself is oriented.
 */

const PLANE_SIZE = 80; // world units; large enough to extend past path end (Z=-32)
const FLOOR_Y = -3; // below the path, which starts at y=0 and ascends to y=4

// Color: very subtle. Off-white lines on the dark site background so they
// read as "blueprint marks" rather than "neon grid".
const COLOR_LINE = new THREE.Color(0x9aa1a8);

const VERT = /* glsl */ `
  varying vec3 vWorldPos;

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;

  uniform vec3  uColor;
  uniform vec3  uCenter;       // world-xz of the visible center (camera projection)
  uniform float uMajorSpacing; // 1.0
  uniform float uMinorSpacing; // 0.2
  uniform float uMajorWidth;   // line half-width as fraction of spacing
  uniform float uMinorWidth;
  uniform float uFadeRadius;   // beyond this radius from uCenter, opacity = 0

  varying vec3 vWorldPos;

  // Standard "draw lines on a grid" trick: take the fractional part of the
  // world coordinate divided by spacing, and check distance from the nearest
  // integer boundary using the screen-space derivative for a constant-width
  // line regardless of camera distance.
  float gridLine(vec2 p, float spacing, float halfWidthFrac) {
    vec2 grid = abs(fract(p / spacing - 0.5) - 0.5) / fwidth(p / spacing);
    float line = min(grid.x, grid.y);
    // halfWidthFrac controls AA falloff: lower = thinner.
    return 1.0 - min(line / halfWidthFrac, 1.0);
  }

  void main() {
    vec2 worldXZ = vWorldPos.xz;

    float major = gridLine(worldXZ, uMajorSpacing, uMajorWidth);
    float minor = gridLine(worldXZ, uMinorSpacing, uMinorWidth);

    // Combine: major lines at full strength, minor lines at half. Major wins
    // where they coincide (every 5th minor line is also major).
    float intensity = max(major, minor * 0.45);

    // Radial fade toward horizon — distance from camera-projected center.
    float r = length(worldXZ - uCenter.xz);
    float fade = 1.0 - smoothstep(uFadeRadius * 0.4, uFadeRadius, r);

    float alpha = intensity * fade * 0.55; // overall opacity ceiling

    if (alpha < 0.005) discard; // helps the depth-buffer + perf for empty cells

    gl_FragColor = vec4(uColor, alpha);
  }
`;

export class GridFloor {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    const geom = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE, 1, 1);
    // Default plane is in XY; we want it on the XZ plane (ground), so rotate
    // -90° about X. After this, the plane's local +Z faces world +Y (up).
    geom.rotateX(-Math.PI / 2);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: COLOR_LINE.clone() },
        uCenter: { value: new THREE.Vector3() },
        uMajorSpacing: { value: 1.0 },
        uMinorSpacing: { value: 0.2 },
        uMajorWidth: { value: 0.6 },
        uMinorWidth: { value: 0.5 },
        uFadeRadius: { value: 22.0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.position.y = FLOOR_Y;
    // Center the grid roughly under the path's midpoint (avg of x's and z's).
    // Path control points: x ∈ [0..12], z ∈ [-32..0]. Midpoint ≈ (6, -16).
    this.mesh.position.x = 6;
    this.mesh.position.z = -16;
    this.mesh.frustumCulled = false; // huge plane; default frustum cull is fine
                                     // either way but disabling keeps it stable
                                     // when the camera is looking down.
    this.mesh.renderOrder = -1; // draw before markers so transparency stacks right
  }

  /**
   * Move the radial fade center to follow the camera projected onto the floor
   * plane — keeps the visible "circle of detail" around wherever the camera is
   * looking.
   */
  setCenter(cameraPos: THREE.Vector3): void {
    const c = this.material.uniforms.uCenter.value as THREE.Vector3;
    c.set(cameraPos.x, FLOOR_Y, cameraPos.z);
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  dispose(): void {
    (this.mesh.geometry as THREE.BufferGeometry).dispose();
    this.material.dispose();
  }
}
