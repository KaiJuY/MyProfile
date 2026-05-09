import * as THREE from 'three';
import {
  getMorphVertexCommon,
  getMorphFragmentCommon,
  createMorphUniforms,
  type MorphUniforms,
} from './morphShader';
import type { PursuitsFrame, FrameUpdateContext } from './PursuitsScene';

/**
 * Frame 03 — `// ai_research`. Procedural-noise steel plane (no external image)
 * with a wireframe BoundingBox raster-scanning the surface left→right top→bottom.
 * Three pre-defined "defect" hotspots; when the bbox lands on one, the box
 * pulses, pauses for ~800ms, and a "0.836 mAP" sprite label appears.
 *
 * Reads as: "DCSA-YOLO scanning a steel plate".
 */

// Steel plane vertex shader — uses morph for entrance.
const PLANE_VERT = /* glsl */ `
  uniform float uMorphProgress;
  uniform float uTime;
  uniform float uMorphDirection;
  uniform float uMorphBand;
  uniform float uMorphDisplace;
  uniform vec3  uMorphAxisRange;

  ${getMorphVertexCommon()}

  varying vec2 vUv;

  void main() {
    vUv = uv;
    vec3 morphed = getMorphedPosition(position, vec3(0.0, 0.0, 1.0));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(morphed, 1.0);
  }
`;

// Procedural noise: hash-based value noise smoothed with smoothstep. Cheap and
// produces a brushed-steel feel when overlaid with horizontal stripes.
const PLANE_FRAG = /* glsl */ `
  precision highp float;

  ${getMorphFragmentCommon()}

  uniform float uTime;
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  void main() {
    // Brushed-steel: anisotropic noise (high freq in x, low in y) + horizontal grain.
    float n = valueNoise(vUv * vec2(120.0, 6.0));
    float grain = 0.5 + 0.5 * sin(vUv.y * 600.0 + n * 8.0);
    float steel = 0.32 + n * 0.08 + grain * 0.04;

    // Vignette toward edges so the plate has a frame-y feel.
    float v = smoothstep(0.0, 0.4, vUv.x) * smoothstep(1.0, 0.6, vUv.x) *
              smoothstep(0.0, 0.4, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
    steel *= 0.6 + 0.4 * v;

    // A faint scanline that follows uTime, evoking "scanner active".
    float scan = smoothstep(0.02, 0.0, abs(fract(vUv.y - uTime * 0.05) - 0.5));
    steel += scan * 0.05;

    vec3 col = vec3(steel * 0.85, steel * 0.9, steel * 1.0); // cool gray
    if (vAlpha < 0.01) discard;
    gl_FragColor = vec4(col, vAlpha);
  }
`;

// Defect hotspot positions in plane-local UV (0..1).
const DEFECTS: { u: number; v: number }[] = [
  { u: 0.28, v: 0.62 },
  { u: 0.72, v: 0.38 },
  { u: 0.55, v: 0.78 },
];

const PLANE_W = 1.2;
const PLANE_H = 0.7;
const SCAN_COLS = 8;
const SCAN_ROWS = 5;
const SCAN_PERIOD = 6.0; // seconds for a full raster sweep
const DEFECT_PAUSE_MS = 800;

export class AiResearchFrame implements PursuitsFrame {
  readonly name = 'ai_research';
  readonly cardIndex = 2;

  private group!: THREE.Group;
  private plane!: THREE.Mesh;
  private bbox!: THREE.LineSegments;
  private bboxMaterial!: THREE.LineBasicMaterial;
  private label!: THREE.Sprite;
  private labelTexture!: THREE.CanvasTexture;

  private materials: THREE.ShaderMaterial[] = [];
  private morphUniforms: MorphUniforms;
  private mounted = false;

  // Scanner state.
  private scanT = 0;
  private pauseUntilMs = 0;
  private currentDefectIdx = -1;
  private labelOpacity = 0;

  constructor() {
    this.morphUniforms = createMorphUniforms({
      direction: 1,
      band: 0.4,
      displace: 0.3,
      axisMin: -PLANE_H / 2,
      axisMax: PLANE_H / 2,
    });
  }

  init(_scene: THREE.Scene): void {
    this.group = new THREE.Group();
    this.group.name = 'AiResearchFrame';

    // Steel plane.
    const planeMat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.morphUniforms,
      },
      vertexShader: PLANE_VERT,
      fragmentShader: PLANE_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.materials.push(planeMat);
    this.plane = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_W, PLANE_H, 32, 16), planeMat);
    this.group.add(this.plane);

    // Wireframe bbox — small box at z slightly in front of the plane.
    const bboxGeom = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.18, 0.12, 0.001));
    this.bboxMaterial = new THREE.LineBasicMaterial({
      color: 0x9ec3d6,
      transparent: true,
      opacity: 0.9,
    });
    this.bbox = new THREE.LineSegments(bboxGeom, this.bboxMaterial);
    this.bbox.position.z = 0.01;
    this.group.add(this.bbox);

    // Label sprite (CanvasTexture). Step 05 will upgrade to MSDF; here we just
    // need a readable label that tracks the bbox center.
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = 'rgba(15, 18, 22, 0.85)';
      ctx.fillRect(0, 0, 256, 64);
      ctx.strokeStyle = '#9ec3d6';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, 254, 62);
      ctx.fillStyle = '#e7eef5';
      ctx.font = 'bold 22px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('0.836 mAP', 128, 32);
    }
    this.labelTexture = new THREE.CanvasTexture(canvas);
    this.labelTexture.colorSpace = THREE.SRGBColorSpace;
    this.labelTexture.anisotropy = 4;
    const labelMat = new THREE.SpriteMaterial({
      map: this.labelTexture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.label = new THREE.Sprite(labelMat);
    this.label.scale.set(0.22, 0.055, 1);
    this.label.position.z = 0.02;
    this.group.add(this.label);
  }

  mount(scene: THREE.Scene): void {
    if (this.mounted) return;
    scene.add(this.group);
    this.mounted = true;
    this.scanT = 0;
    this.pauseUntilMs = 0;
    this.currentDefectIdx = -1;
    this.labelOpacity = 0;
  }

  unmount(scene: THREE.Scene): void {
    if (!this.mounted) return;
    scene.remove(this.group);
    this.mounted = false;
  }

  isMounted(): boolean {
    return this.mounted;
  }

  setMorphProgress(t: number): void {
    this.morphUniforms.uMorphProgress.value = t;
  }

  update(dt: number, _ctx: FrameUpdateContext, time: number): void {
    this.morphUniforms.uTime.value = time;
    if (!this.mounted) return;

    const now = performance.now();

    // Advance the raster scan unless paused on a defect.
    if (now < this.pauseUntilMs) {
      // Pulse bbox during pause.
      const pulse = 0.6 + 0.4 * Math.sin(time * 8);
      this.bboxMaterial.opacity = pulse;
      this.labelOpacity = Math.min(1, this.labelOpacity + dt * 4);
    } else {
      this.bboxMaterial.opacity = 0.9;
      this.labelOpacity = Math.max(0, this.labelOpacity - dt * 3);
      this.scanT += dt / SCAN_PERIOD;
      if (this.scanT > 1) this.scanT -= 1;
    }

    // Convert scanT [0..1] to a raster grid position (col, row).
    const totalCells = SCAN_COLS * SCAN_ROWS;
    const cell = Math.floor(this.scanT * totalCells);
    const row = Math.floor(cell / SCAN_COLS);
    const col = cell % SCAN_COLS;
    // Cell-local U/V positions: cells centered.
    const u = (col + 0.5) / SCAN_COLS;
    const v = 1 - (row + 0.5) / SCAN_ROWS; // flip so row 0 is top

    // Convert U/V (0..1) to plane-local x/y.
    const x = (u - 0.5) * PLANE_W;
    const y = (v - 0.5) * PLANE_H;
    this.bbox.position.x = x;
    this.bbox.position.y = y;
    this.label.position.x = x + 0.13;
    this.label.position.y = y + 0.09;
    (this.label.material as THREE.SpriteMaterial).opacity = this.labelOpacity;

    // Defect detection: if not currently paused and bbox is close to any defect,
    // start a pause and remember which defect.
    if (now >= this.pauseUntilMs) {
      for (let i = 0; i < DEFECTS.length; i++) {
        if (i === this.currentDefectIdx) continue;
        const d = DEFECTS[i];
        const du = u - d.u;
        const dv = v - d.v;
        if (du * du + dv * dv < 0.02 * 0.02) {
          this.pauseUntilMs = now + DEFECT_PAUSE_MS;
          this.currentDefectIdx = i;
          break;
        }
      }
      // Reset memory after we move past the cell.
      if (this.currentDefectIdx !== -1 && now >= this.pauseUntilMs) {
        const d = DEFECTS[this.currentDefectIdx];
        const du = u - d.u;
        const dv = v - d.v;
        if (du * du + dv * dv > 0.04 * 0.04) {
          this.currentDefectIdx = -1;
        }
      }
    }
  }

  setTransform(position: THREE.Vector3, scale: number): void {
    this.group.position.copy(position);
    this.group.scale.setScalar(scale);
  }

  dispose(scene: THREE.Scene): void {
    this.unmount(scene);
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
        obj.geometry.dispose();
      }
    });
    this.bboxMaterial.dispose();
    (this.label.material as THREE.SpriteMaterial).dispose();
    this.labelTexture.dispose();
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
  }
}
