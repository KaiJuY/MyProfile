import * as THREE from 'three';
import {
  getMorphVertexCommon,
  getMorphFragmentCommon,
  createMorphUniforms,
  type MorphUniforms,
} from './morphShader';
import type { PursuitsFrame, FrameUpdateContext } from './PursuitsScene';

/**
 * Frame 02 — `// protocols`. Two emissive icospheres (host + tool nodes) with a
 * QuadraticBezierCurve3 between them; ~12 packets travel along the curve as a
 * single InstancedMesh of small spheres at staggered phase offsets.
 *
 * The single draw call for all packets keeps GPU cost flat regardless of count.
 */

const NODE_VERT = /* glsl */ `
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

const NODE_FRAG = /* glsl */ `
  precision highp float;

  ${getMorphFragmentCommon()}

  uniform vec3 uColor;
  uniform float uTime;
  varying vec3 vNormal;

  void main() {
    float pulse = 0.7 + 0.3 * sin(uTime * 2.0);
    float rim = pow(1.0 - abs(vNormal.z), 2.0);
    vec3 col = uColor * (0.6 + 0.4 * pulse) + uColor * rim * 0.5;
    if (vAlpha < 0.01) discard;
    gl_FragColor = vec4(col, vAlpha);
  }
`;

// Curve material — additive line. Uses morph for entrance fade.
const CURVE_VERT = /* glsl */ `
  uniform float uMorphProgress;
  uniform float uTime;
  uniform float uMorphDirection;
  uniform float uMorphBand;
  uniform float uMorphDisplace;
  uniform vec3  uMorphAxisRange;

  ${getMorphVertexCommon()}

  void main() {
    vec3 morphed = getMorphedPosition(position, vec3(0.0, 1.0, 0.0));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(morphed, 1.0);
  }
`;

const CURVE_FRAG = /* glsl */ `
  precision highp float;
  ${getMorphFragmentCommon()}
  uniform vec3 uColor;

  void main() {
    gl_FragColor = vec4(uColor, 0.45 * vAlpha);
  }
`;

// Packet (instanced) — vertex shader uses instanceMatrix and morphs the WORLD-y
// of the instance to fade in/out. We don't morph individual vertices of the
// small packet sphere; instead packets just appear-as-a-whole with the wave.
const PACKET_VERT = /* glsl */ `
  uniform float uMorphProgress;
  uniform float uTime;
  uniform float uMorphDirection;
  uniform float uMorphBand;
  uniform float uMorphDisplace;
  uniform vec3  uMorphAxisRange;

  attribute float aPhase; // 0..1 phase offset along the curve

  varying float vAlpha;
  varying float vGlow;

  // We don't run getMorphedPosition for packets — they're tiny, the morph is
  // expressed via the GROUP-level alpha multiplied here. This simpler version
  // computes vAlpha from uMorphProgress directly.
  void main() {
    vec4 mvPos = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPos;
    // Glow with a sinusoid across the journey for a "packet pulse" feel.
    vGlow = 0.5 + 0.5 * sin(uTime * 3.0 + aPhase * 6.2831853);
    vAlpha = smoothstep(0.0, 0.4, uMorphProgress);
  }
`;

const PACKET_FRAG = /* glsl */ `
  precision highp float;
  varying float vAlpha;
  varying float vGlow;
  uniform vec3 uColor;

  void main() {
    vec3 col = uColor * (0.6 + 0.6 * vGlow);
    gl_FragColor = vec4(col, vAlpha * (0.4 + 0.6 * vGlow));
  }
`;

const PACKET_COUNT = 12;

export class ProtocolsFrame implements PursuitsFrame {
  readonly name = 'protocols';
  readonly cardIndex = 1;

  private group!: THREE.Group;
  private nodeA!: THREE.Mesh;
  private nodeB!: THREE.Mesh;
  private curve!: THREE.QuadraticBezierCurve3;
  private curveLine!: THREE.Line;
  private packets!: THREE.InstancedMesh;

  private materials: THREE.ShaderMaterial[] = [];
  private morphUniforms: MorphUniforms;
  private mounted = false;

  // Reusable scratches.
  private tmpMatrix = new THREE.Matrix4();
  private tmpQuat = new THREE.Quaternion();
  private tmpScale = new THREE.Vector3(1, 1, 1);
  private tmpPos = new THREE.Vector3();

  // Per-packet phase offsets (immutable after init).
  private phases: number[] = [];

  constructor() {
    this.morphUniforms = createMorphUniforms({
      direction: 1,
      band: 0.4,
      displace: 0.3,
      axisMin: -0.4,
      axisMax: 0.4,
    });
  }

  init(_scene: THREE.Scene): void {
    this.group = new THREE.Group();
    this.group.name = 'ProtocolsFrame';

    const mkNode = (color: number): THREE.Mesh => {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          ...this.morphUniforms,
          uColor: { value: new THREE.Color(color) },
          uTime: this.morphUniforms.uTime,
        },
        vertexShader: NODE_VERT,
        fragmentShader: NODE_FRAG,
        transparent: true,
        depthWrite: false,
      });
      this.materials.push(mat);
      return new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 1), mat);
    };

    this.nodeA = mkNode(0xc0d8e8);
    this.nodeA.position.set(-0.5, 0, 0);
    this.group.add(this.nodeA);

    this.nodeB = mkNode(0xc0d8e8);
    this.nodeB.position.set(0.5, 0, 0);
    this.group.add(this.nodeB);

    // Bezier with arched mid-control point so packets curve up and over.
    this.curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(-0.5, 0, 0),
      new THREE.Vector3(0, 0.35, 0),
      new THREE.Vector3(0.5, 0, 0)
    );

    // Curve as a line (sampled).
    const curveGeom = new THREE.BufferGeometry().setFromPoints(this.curve.getPoints(48));
    const curveMat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.morphUniforms,
        uColor: { value: new THREE.Color(0x9ec3d6) },
      },
      vertexShader: CURVE_VERT,
      fragmentShader: CURVE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.materials.push(curveMat);
    this.curveLine = new THREE.Line(curveGeom, curveMat);
    this.group.add(this.curveLine);

    // Instanced packet spheres. One geometry, one material, N instances.
    const packetGeom = new THREE.SphereGeometry(0.025, 8, 8);
    // aPhase attribute (one per instance).
    const phaseArr = new Float32Array(PACKET_COUNT);
    for (let i = 0; i < PACKET_COUNT; i++) {
      this.phases.push(i / PACKET_COUNT);
      phaseArr[i] = i / PACKET_COUNT;
    }
    packetGeom.setAttribute(
      'aPhase',
      new THREE.InstancedBufferAttribute(phaseArr, 1)
    );

    const packetMat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.morphUniforms,
        uColor: { value: new THREE.Color(0xd9e8f2) },
      },
      vertexShader: PACKET_VERT,
      fragmentShader: PACKET_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.materials.push(packetMat);

    this.packets = new THREE.InstancedMesh(packetGeom, packetMat, PACKET_COUNT);
    this.packets.frustumCulled = false;
    // Initialize matrices at curve start so we don't render at origin pre-update.
    for (let i = 0; i < PACKET_COUNT; i++) {
      this.tmpMatrix.compose(this.tmpPos.set(0, 0, 0), this.tmpQuat, this.tmpScale);
      this.packets.setMatrixAt(i, this.tmpMatrix);
    }
    this.packets.instanceMatrix.needsUpdate = true;
    this.group.add(this.packets);
  }

  mount(scene: THREE.Scene): void {
    if (this.mounted) return;
    scene.add(this.group);
    this.mounted = true;
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

  update(_dt: number, _ctx: FrameUpdateContext, time: number): void {
    this.morphUniforms.uTime.value = time;
    if (!this.mounted) return;

    // Walk each packet along the curve at ~0.4 cycles/sec.
    const speed = 0.18;
    for (let i = 0; i < PACKET_COUNT; i++) {
      const t = (this.phases[i] + time * speed) % 1;
      this.curve.getPoint(t, this.tmpPos);
      this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
      this.packets.setMatrixAt(i, this.tmpMatrix);
    }
    this.packets.instanceMatrix.needsUpdate = true;
  }

  setTransform(position: THREE.Vector3, scale: number): void {
    this.group.position.copy(position);
    this.group.scale.setScalar(scale);
  }

  dispose(scene: THREE.Scene): void {
    this.unmount(scene);
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        obj.geometry.dispose();
      }
      if (obj instanceof THREE.InstancedMesh) {
        obj.geometry.dispose();
      }
    });
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
  }
}
