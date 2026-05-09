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
 * Frame 01 — `// automation`. A simplified robotic arm (3 stacked cylinders +
 * box gripper) lifting a translucent wafer disc. Reads as "EFEM pickup loop"
 * without literal modeling.
 *
 * Visual budget: 4 cylinders + 1 gripper + 1 wafer = 6 meshes. Cheap.
 *
 * Animation: a single GSAP timeline with `repeat: -1` cycles arm joints +
 * wafer parent — wafer parents to the gripper during the lift so we don't
 * have to re-derive its world position each frame.
 */

const VERT = /* glsl */ `
  uniform float uMorphProgress;
  uniform float uTime;
  uniform float uMorphDirection;
  uniform float uMorphBand;
  uniform float uMorphDisplace;
  uniform vec3  uMorphAxisRange;

  ${getMorphVertexCommon()}

  varying vec3 vNormal;

  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec3 morphed = getMorphedPosition(position, normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(morphed, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;

  ${getMorphFragmentCommon()}

  uniform vec3  uColor;
  uniform float uEmissive;
  varying vec3 vNormal;

  void main() {
    // Cheap matcap-ish lighting: dot with a fixed eye-space direction.
    float ndl = max(dot(vNormal, normalize(vec3(0.4, 0.7, 1.0))), 0.0);
    vec3 col = uColor * (0.35 + 0.65 * ndl) + vec3(uEmissive);
    if (vAlpha < 0.01) discard;
    gl_FragColor = vec4(col, vAlpha);
  }
`;

const WAFER_VERT = /* glsl */ `
  uniform float uMorphProgress;
  uniform float uTime;
  uniform float uMorphDirection;
  uniform float uMorphBand;
  uniform float uMorphDisplace;
  uniform vec3  uMorphAxisRange;

  ${getMorphVertexCommon()}

  varying vec3 vWorldNormal;

  void main() {
    vWorldNormal = normalize(normalMatrix * normal);
    vec3 morphed = getMorphedPosition(position, normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(morphed, 1.0);
  }
`;

const WAFER_FRAG = /* glsl */ `
  precision highp float;

  ${getMorphFragmentCommon()}

  uniform vec3  uColor;
  uniform float uTime;
  varying vec3 vWorldNormal;

  void main() {
    float ring = abs(fract(uTime * 0.05 + vWorldNormal.x * 4.0) - 0.5);
    float glow = smoothstep(0.5, 0.0, ring) * 0.25;
    vec3 col = uColor + vec3(glow);
    gl_FragColor = vec4(col, 0.55 * vAlpha);
  }
`;

export class AutomationFrame implements PursuitsFrame {
  readonly name = 'automation';
  readonly cardIndex = 0;

  private group!: THREE.Group;
  private base!: THREE.Mesh;
  private seg1!: THREE.Group; // shoulder pivot
  private seg2!: THREE.Group; // elbow pivot
  private gripper!: THREE.Mesh;
  private wafer!: THREE.Mesh;
  private platform!: THREE.Mesh;

  private materials: THREE.ShaderMaterial[] = [];
  private morphUniforms: MorphUniforms;
  private timeline?: gsap.core.Timeline;
  private mounted = false;

  constructor() {
    this.morphUniforms = createMorphUniforms({
      direction: 1,
      band: 0.4,
      displace: 0.4,
      axisMin: -0.5,
      axisMax: 0.9,
    });
  }

  init(_scene: THREE.Scene): void {
    this.group = new THREE.Group();
    this.group.name = 'AutomationFrame';

    const mkMat = (color: number, emissive = 0): THREE.ShaderMaterial => {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          ...this.morphUniforms,
          uColor: { value: new THREE.Color(color) },
          uEmissive: { value: emissive },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
      });
      this.materials.push(mat);
      return mat;
    };

    const armColor = 0xc9d3dc;

    // Base plate.
    this.base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.18, 0.06, 24),
      mkMat(0x6b7480)
    );
    this.base.position.y = -0.45;
    this.group.add(this.base);

    // Pillar — segment 0 (vertical column).
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 0.6, 16),
      mkMat(armColor)
    );
    pillar.position.y = -0.12;
    this.group.add(pillar);

    // Shoulder joint pivot (seg1) — rotates around z.
    this.seg1 = new THREE.Group();
    this.seg1.position.set(0, 0.18, 0);
    this.group.add(this.seg1);

    const upperArm = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 0.5, 16),
      mkMat(armColor)
    );
    // Cylinder is centered; offset so its base is at the joint and it extends +y.
    upperArm.position.y = 0.25;
    this.seg1.add(upperArm);

    // Elbow joint pivot (seg2) — at the tip of the upper arm.
    this.seg2 = new THREE.Group();
    this.seg2.position.set(0, 0.5, 0);
    this.seg1.add(this.seg2);

    const forearm = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 0.4, 16),
      mkMat(armColor)
    );
    forearm.position.y = 0.2;
    this.seg2.add(forearm);

    // Gripper (small box) at the tip of the forearm.
    this.gripper = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.06, 0.08),
      mkMat(0x8a93a0, 0.05)
    );
    this.gripper.position.set(0, 0.4, 0);
    this.seg2.add(this.gripper);

    // Wafer disc — translucent, lives at the "pickup point" initially.
    const waferMat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.morphUniforms,
        uColor: { value: new THREE.Color(0xb8d4e3) },
        uTime: this.morphUniforms.uTime,
      },
      vertexShader: WAFER_VERT,
      fragmentShader: WAFER_FRAG,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.materials.push(waferMat);

    this.wafer = new THREE.Mesh(new THREE.CircleGeometry(0.18, 32), waferMat);
    this.wafer.rotation.x = -Math.PI / 2;
    this.wafer.position.set(0.55, -0.4, 0);
    this.group.add(this.wafer);

    // Drop platform.
    this.platform = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.02, 0.3),
      mkMat(0x4a525e)
    );
    this.platform.position.set(-0.55, -0.43, 0);
    this.group.add(this.platform);

    // Initial joint state.
    this.seg1.rotation.z = 0;
    this.seg2.rotation.z = 0;
  }

  private buildTimeline(): void {
    if (this.timeline) return;
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.2 });

    const seg1 = this.seg1.rotation;
    const seg2 = this.seg2.rotation;
    const wafer = this.wafer.position;

    tl.to(seg1, { z: -0.7, duration: 0.6, ease: 'power2.inOut' }, 0)
      .to(seg2, { z: -0.4, duration: 0.6, ease: 'power2.inOut' }, 0)
      // Pick up: wafer rises with gripper. We just animate its world-space y.
      .to(wafer, { y: -0.05, duration: 0.4, ease: 'power2.in' }, 0.6)
      .to(wafer, { x: -0.2, duration: 0.6, ease: 'power2.inOut' }, 1.0)
      .to(seg1, { z: 0.7, duration: 0.6, ease: 'power2.inOut' }, 1.0)
      .to(seg2, { z: 0.4, duration: 0.6, ease: 'power2.inOut' }, 1.0)
      .to(wafer, { x: -0.55, y: -0.41, duration: 0.4, ease: 'power2.out' }, 1.6)
      // Reset.
      .to(seg1, { z: 0, duration: 0.5, ease: 'power2.inOut' }, 2.2)
      .to(seg2, { z: 0, duration: 0.5, ease: 'power2.inOut' }, 2.2)
      .to(wafer, { x: 0.55, y: -0.4, duration: 0.01 }, 2.7);
    this.timeline = tl;
  }

  mount(scene: THREE.Scene): void {
    if (this.mounted) return;
    scene.add(this.group);
    this.mounted = true;
    this.buildTimeline();
    this.timeline?.play(0);
  }

  unmount(scene: THREE.Scene): void {
    if (!this.mounted) return;
    scene.remove(this.group);
    this.mounted = false;
    this.timeline?.pause();
  }

  isMounted(): boolean {
    return this.mounted;
  }

  setMorphProgress(t: number): void {
    this.morphUniforms.uMorphProgress.value = t;
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
    this.timeline?.kill();
    this.timeline = undefined;
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
      }
    });
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
  }
}
