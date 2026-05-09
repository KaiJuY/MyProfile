import * as THREE from 'three';
import { gsap } from 'gsap';
import {
  getMorphVertexCommon,
  getMorphFragmentCommon,
  createMorphUniforms,
  type MorphUniforms,
} from './morphShader';
import type { PursuitsFrame, FrameUpdateContext } from './PursuitsScene';

/**
 * Frame 04 — `// saas` (Divine Whisper). Double-sided plane: front shows
 * "DIVINE WHISPER" + a fortune-stick number, back is a darker color with a
 * subtle line pattern. Idle: gentle Y-axis rotation. On hover (cursor inside
 * the corresponding card's bounding rect): GSAP elastic flip to face the user.
 *
 * Uses a pair of CanvasTextures composed into one double-sided material via
 * the front/back-clipping trick: a single mesh with `side: DoubleSide` only
 * works if both faces share a texture. Instead we use TWO meshes back-to-back
 * (front mesh facing +z, back mesh facing -z, with `side: FrontSide` each).
 */

const CARD_VERT = /* glsl */ `
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

const CARD_FRAG = /* glsl */ `
  precision highp float;
  ${getMorphFragmentCommon()}

  uniform sampler2D uMap;
  varying vec2 vUv;

  void main() {
    vec4 tex = texture2D(uMap, vUv);
    if (vAlpha < 0.01) discard;
    gl_FragColor = vec4(tex.rgb, tex.a * vAlpha);
  }
`;

function buildFrontTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 720;
  const ctx = c.getContext('2d')!;
  // Background: very dark, slight gradient.
  const grd = ctx.createLinearGradient(0, 0, 0, 720);
  grd.addColorStop(0, '#0c0e12');
  grd.addColorStop(1, '#1b1f26');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 512, 720);

  // Border.
  ctx.strokeStyle = '#7d8895';
  ctx.lineWidth = 4;
  ctx.strokeRect(20, 20, 472, 680);
  ctx.strokeStyle = '#3a4252';
  ctx.lineWidth = 1;
  ctx.strokeRect(34, 34, 444, 652);

  // Title.
  ctx.fillStyle = '#e7eef5';
  ctx.font = 'bold 38px "Times New Roman", serif';
  ctx.textAlign = 'center';
  ctx.fillText('DIVINE', 256, 130);
  ctx.fillText('WHISPER', 256, 180);

  // Decorative divider.
  ctx.strokeStyle = '#9ec3d6';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(120, 220);
  ctx.lineTo(392, 220);
  ctx.stroke();

  // Fortune number — large.
  ctx.fillStyle = '#c9d3dc';
  ctx.font = '500 24px "JetBrains Mono", monospace';
  ctx.fillText('FORTUNE NO.', 256, 290);
  ctx.fillStyle = '#e7eef5';
  ctx.font = 'bold 120px "Times New Roman", serif';
  ctx.fillText('36', 256, 430);

  // Chinese subtitle.
  ctx.fillStyle = '#c9d3dc';
  ctx.font = '24px "Microsoft JhengHei", "PingFang TC", sans-serif';
  ctx.fillText('第三十六籤', 256, 490);

  // Bottom legend.
  ctx.fillStyle = '#7d8895';
  ctx.font = '14px "JetBrains Mono", monospace';
  ctx.fillText('// RAG · LLM · FASTAPI', 256, 620);
  ctx.fillText('2025', 256, 660);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function buildBackTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 720;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#0a0c0f';
  ctx.fillRect(0, 0, 512, 720);

  // Diagonal line pattern.
  ctx.strokeStyle = 'rgba(126, 136, 149, 0.18)';
  ctx.lineWidth = 1;
  for (let i = -720; i < 720; i += 14) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 720, 720);
    ctx.stroke();
  }

  // Border.
  ctx.strokeStyle = '#3a4252';
  ctx.lineWidth = 2;
  ctx.strokeRect(20, 20, 472, 680);

  // Centered seal.
  ctx.strokeStyle = '#7d8895';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(256, 360, 110, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#e7eef5';
  ctx.font = 'bold 36px "Microsoft JhengHei", "PingFang TC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('籤', 256, 360);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const CARD_W = 0.5;
const CARD_H = 0.7;

export class SaasFrame implements PursuitsFrame {
  readonly name = 'saas';
  readonly cardIndex = 3;

  private group!: THREE.Group;
  private cardPivot!: THREE.Group;
  private frontMesh!: THREE.Mesh;
  private backMesh!: THREE.Mesh;
  private frontTex!: THREE.CanvasTexture;
  private backTex!: THREE.CanvasTexture;

  private materials: THREE.ShaderMaterial[] = [];
  private morphUniforms: MorphUniforms;
  private mounted = false;

  // Hover state.
  private hovered = false;
  private flipTween?: gsap.core.Tween;
  private idleSpinTween?: gsap.core.Tween;

  constructor() {
    this.morphUniforms = createMorphUniforms({
      direction: 1,
      band: 0.45,
      displace: 0.35,
      axisMin: -CARD_H / 2,
      axisMax: CARD_H / 2,
    });
  }

  init(_scene: THREE.Scene): void {
    this.group = new THREE.Group();
    this.group.name = 'SaasFrame';

    this.cardPivot = new THREE.Group();
    this.group.add(this.cardPivot);

    this.frontTex = buildFrontTexture();
    this.backTex = buildBackTexture();

    const mkMat = (map: THREE.Texture): THREE.ShaderMaterial => {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          ...this.morphUniforms,
          uMap: { value: map },
        },
        vertexShader: CARD_VERT,
        fragmentShader: CARD_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.FrontSide,
      });
      this.materials.push(mat);
      return mat;
    };

    const planeGeom = new THREE.PlaneGeometry(CARD_W, CARD_H, 8, 12);

    this.frontMesh = new THREE.Mesh(planeGeom, mkMat(this.frontTex));
    this.frontMesh.position.z = 0.001;
    this.cardPivot.add(this.frontMesh);

    this.backMesh = new THREE.Mesh(planeGeom.clone(), mkMat(this.backTex));
    this.backMesh.rotation.y = Math.PI;
    this.backMesh.position.z = -0.001;
    this.cardPivot.add(this.backMesh);

    // Initial: face away (showing back).
    this.cardPivot.rotation.y = Math.PI;
  }

  mount(scene: THREE.Scene): void {
    if (this.mounted) return;
    scene.add(this.group);
    this.mounted = true;
    // Idle spin: gentle wobble around the current rotation. We use a yoyo tween
    // so we don't have to re-target each frame.
    this.startIdle();
  }

  unmount(scene: THREE.Scene): void {
    if (!this.mounted) return;
    scene.remove(this.group);
    this.mounted = false;
    this.idleSpinTween?.kill();
    this.idleSpinTween = undefined;
    this.flipTween?.kill();
    this.flipTween = undefined;
  }

  isMounted(): boolean {
    return this.mounted;
  }

  private startIdle(): void {
    if (this.idleSpinTween) return;
    // Continuous slow rotation drift on top of whatever the flip tween sets.
    this.idleSpinTween = gsap.to(this.cardPivot.rotation, {
      y: '+=' + Math.PI * 2,
      duration: 16,
      ease: 'none',
      repeat: -1,
    });
  }

  setMorphProgress(t: number): void {
    this.morphUniforms.uMorphProgress.value = t;
  }

  setHovered(hovered: boolean): void {
    if (hovered === this.hovered) return;
    this.hovered = hovered;
    // Snap to the nearest "front" or "back" face. Pause idle while flipping.
    this.idleSpinTween?.pause();
    this.flipTween?.kill();
    const current = this.cardPivot.rotation.y;
    const targetMod = hovered ? 0 : Math.PI;
    // Find nearest equivalent angle modulo 2π so we don't tween long ways.
    const TWO_PI = Math.PI * 2;
    let target = targetMod;
    while (target < current - Math.PI) target += TWO_PI;
    while (target > current + Math.PI) target -= TWO_PI;
    this.flipTween = gsap.to(this.cardPivot.rotation, {
      y: target,
      duration: 0.9,
      ease: 'elastic.out(1, 0.55)',
      onComplete: () => {
        this.idleSpinTween?.resume();
      },
    });
  }

  update(_dt: number, _ctx: FrameUpdateContext, time: number): void {
    this.morphUniforms.uTime.value = time;
  }

  setTransform(position: THREE.Vector3, scale: number): void {
    this.group.position.copy(position);
    this.group.scale.setScalar(scale);
  }

  dispose(scene: THREE.Scene): void {
    this.unmount(scene);
    this.idleSpinTween?.kill();
    this.flipTween?.kill();
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
      }
    });
    this.frontTex.dispose();
    this.backTex.dispose();
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
  }
}
