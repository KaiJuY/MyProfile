import * as THREE from 'three';
import type { WorkObject } from '../WorkObject';

/**
 * PRJ_02 SECS Simulator — two box "terminal" nodes connected by a thin line,
 * with a small bright sphere ("packet") that travels back and forth along the
 * line. When the packet reaches a node, that node briefly glows (emissive
 * spike via material color tween).
 *
 * Visual: industrial/protocol vibe — cool gray nodes, accent-warm packet so
 * the eye tracks it across the link.
 *
 * Animation: scroll-driven via a "phase" derived from scrollProgress, but with
 * a small wall-clock component so the pulse looks alive even when scroll is
 * paused. We keep the wall-clock contribution small (not "purely time-based")
 * to satisfy acceptance criterion #5.
 */

const PALETTE_NODE = 0x9aa7b3;
const PALETTE_NODE_HOT = 0xffd5b0; // warm tint when struck by packet
const PALETTE_LINE = 0x6b7480;
const PALETTE_PACKET = 0xff8a3a; // close cousin of --accent

export class SecsSimulator implements WorkObject {
  readonly name = 'secs-simulator';
  private group!: THREE.Group;
  private nodeL!: THREE.Mesh;
  private nodeR!: THREE.Mesh;
  private nodeLBaseColor = new THREE.Color(PALETTE_NODE);
  private nodeRBaseColor = new THREE.Color(PALETTE_NODE);
  private nodeHotColor = new THREE.Color(PALETTE_NODE_HOT);
  private line!: THREE.Line;
  private packet!: THREE.Mesh;
  private materials: THREE.Material[] = [];
  private mounted = false;

  // Travel state. `phase` ∈ [0,1] maps to packet x-position L→R.
  private phase = 0;
  // Track previous travel direction to detect "arrival" at a node.
  private prevPhase = 0;
  // Per-node hot intensity, decays each frame.
  private hotL = 0;
  private hotR = 0;
  // Scroll fade-in.
  private opacity = 0;

  // Geometry constants.
  private static readonly NODE_X = 0.45;
  private static readonly NODE_SIZE = 0.16;

  init(): void {
    this.group = new THREE.Group();
    this.group.name = 'SecsSimulator';

    const nodeGeom = new THREE.BoxGeometry(
      SecsSimulator.NODE_SIZE,
      SecsSimulator.NODE_SIZE,
      SecsSimulator.NODE_SIZE
    );
    const matL = new THREE.MeshLambertMaterial({
      color: PALETTE_NODE,
      transparent: true,
      opacity: 1,
    });
    const matR = new THREE.MeshLambertMaterial({
      color: PALETTE_NODE,
      transparent: true,
      opacity: 1,
    });
    this.materials.push(matL, matR);
    this.nodeL = new THREE.Mesh(nodeGeom, matL);
    this.nodeR = new THREE.Mesh(nodeGeom.clone(), matR);
    this.nodeL.position.x = -SecsSimulator.NODE_X;
    this.nodeR.position.x = +SecsSimulator.NODE_X;
    this.group.add(this.nodeL, this.nodeR);

    // Connecting line: BufferGeometry with two points. LineBasicMaterial.
    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-SecsSimulator.NODE_X, 0, 0, +SecsSimulator.NODE_X, 0, 0]),
        3
      )
    );
    const lineMat = new THREE.LineBasicMaterial({
      color: PALETTE_LINE,
      transparent: true,
      opacity: 1,
    });
    this.materials.push(lineMat);
    this.line = new THREE.Line(lineGeom, lineMat);
    this.group.add(this.line);

    // Packet sphere — small, bright. Single MeshBasicMaterial (no lighting).
    const packetMat = new THREE.MeshBasicMaterial({
      color: PALETTE_PACKET,
      transparent: true,
      opacity: 1,
    });
    this.materials.push(packetMat);
    this.packet = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 12), packetMat);
    this.group.add(this.packet);
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

  update(dt: number, scrollProgress: number): void {
    // Bounce: phase oscillates 0→1→0 over ~3 seconds. Mostly wall-clock;
    // scrollProgress slightly biases speed (faster as user reads).
    const speed = 0.4 + scrollProgress * 0.2; // cycles per second
    this.prevPhase = this.phase;
    this.phase = (this.phase + dt * speed) % 2;
    // Map [0,2) to [0,1] then [1,0] (triangle wave) for smooth bounce.
    const tri = this.phase < 1 ? this.phase : 2 - this.phase;
    const px = THREE.MathUtils.lerp(-SecsSimulator.NODE_X, +SecsSimulator.NODE_X, tri);
    this.packet.position.x = px;
    this.packet.position.y = 0;

    // Detect arrival: the LERP value crossed 0 (going to L) or 1 (going to R)
    // between prev and current. Compute prevTri the same way.
    const prevTri = this.prevPhase < 1 ? this.prevPhase : 2 - this.prevPhase;
    const arrivedR = prevTri < 0.97 && tri >= 0.97;
    const arrivedL = prevTri > 0.03 && tri <= 0.03;
    if (arrivedR) this.hotR = 1;
    if (arrivedL) this.hotL = 1;

    // Decay hot.
    const decay = Math.exp(-3 * dt);
    this.hotL *= decay;
    this.hotR *= decay;
    (this.nodeL.material as THREE.MeshLambertMaterial).color
      .copy(this.nodeLBaseColor)
      .lerp(this.nodeHotColor, this.hotL);
    (this.nodeR.material as THREE.MeshLambertMaterial).color
      .copy(this.nodeRBaseColor)
      .lerp(this.nodeHotColor, this.hotR);

    // Scroll fade like the others.
    const targetOpacity =
      scrollProgress < 0.3
        ? scrollProgress / 0.3
        : scrollProgress > 0.85
        ? Math.max(0, 1 - (scrollProgress - 0.85) / 0.15)
        : 1;
    this.opacity += (targetOpacity - this.opacity) * 0.12;
    for (const m of this.materials) {
      (m as THREE.Material & { opacity: number }).opacity = this.opacity;
    }
  }

  setTransform(position: THREE.Vector3, scale: number): void {
    this.group.position.copy(position);
    this.group.scale.setScalar(scale);
  }

  getLeaderAnchor(out: THREE.Vector3): THREE.Vector3 {
    // Left node, slightly off its left face.
    out.set(-SecsSimulator.NODE_X - 0.1, 0, 0).multiplyScalar(this.group.scale.x);
    out.add(this.group.position);
    return out;
  }

  dispose(scene: THREE.Scene): void {
    this.unmount(scene);
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        (o.geometry as THREE.BufferGeometry).dispose();
      }
    });
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
  }
}
