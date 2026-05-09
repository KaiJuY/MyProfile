import * as THREE from 'three';
import type { WorkObject } from '../WorkObject';

/**
 * PRJ_06 Divine Whisper — a flat "fortune-stick" card with the character 籤
 * drawn via CanvasTexture, slowly rotating on Y, surrounded by ~10 small
 * additive-blended sprites that orbit it like fireflies.
 *
 * Visual budget: 1 card mesh + 10 sprite-points = ~11 objects. The sprites
 * use a single shared Points geometry → 1 draw call for the whole swarm.
 *
 * Animation: scrollProgress → opacity / sprite reveal. Card rotation is
 * wall-clock (always-on slow spin), but only when mounted.
 */

const CARD_W = 0.40;
const CARD_H = 0.62;
const FIREFLY_COUNT = 10;
const FIREFLY_RADIUS_BASE = 0.45; // base orbital radius around the card center

/** Build a CanvasTexture with the 籤 character on a dark background. */
function buildCardTexture(): THREE.CanvasTexture {
  const SIZE = 256;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = Math.floor(SIZE * (CARD_H / CARD_W));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('DivineWhisper: failed to acquire 2D context');

  // Background: slight vertical gradient so the card has a gentle "ink wash" feel.
  const grd = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grd.addColorStop(0, '#1c1814');
  grd.addColorStop(1, '#2a2218');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Border line, traditional almanac feel.
  ctx.strokeStyle = '#c2a161';
  ctx.lineWidth = 4;
  ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);

  // 籤 character, large.
  ctx.fillStyle = '#e8d8a8';
  ctx.font = `bold ${Math.floor(canvas.width * 0.6)}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('籤', canvas.width / 2, canvas.height * 0.45);

  // Small subtitle below — a number, picks differ per session for charm but we
  // keep it deterministic so it doesn't strobe across re-mounts.
  ctx.fillStyle = '#c2a161';
  ctx.font = `${Math.floor(canvas.width * 0.10)}px serif`;
  ctx.fillText('第 七 十 二 籤', canvas.width / 2, canvas.height * 0.82);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Build a small radial-falloff sprite for the firefly Points. */
function buildFireflyTexture(): THREE.CanvasTexture {
  const SIZE = 64;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('DivineWhisper: failed to acquire 2D ctx for firefly');
  const cx = SIZE / 2;
  const grd = ctx.createRadialGradient(cx, cx, 0, cx, cx, SIZE / 2);
  grd.addColorStop(0, 'rgba(255, 220, 140, 1)');
  grd.addColorStop(0.4, 'rgba(255, 180, 80, 0.5)');
  grd.addColorStop(1, 'rgba(255, 180, 80, 0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, SIZE, SIZE);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class DivineWhisper implements WorkObject {
  readonly name = 'divine-whisper';
  private group!: THREE.Group;
  private card!: THREE.Mesh;
  private cardTex!: THREE.CanvasTexture;
  private cardMat!: THREE.MeshBasicMaterial;
  private fireflies!: THREE.Points;
  private fireflyMat!: THREE.PointsMaterial;
  private fireflyTex!: THREE.CanvasTexture;
  // Per-firefly orbital state (independent angle + radius + height).
  private fireflyState: {
    a: number;
    r: number;
    h: number;
    speed: number;
    phaseY: number;
  }[] = [];
  private mounted = false;
  private opacity = 0;
  private cardYaw = 0;

  init(): void {
    this.group = new THREE.Group();
    this.group.name = 'DivineWhisper';

    // Card (flat plane, slightly thickened by giving it z=0.005 via scale to
    // avoid z-fighting with the firefly sprites that may pass close behind).
    this.cardTex = buildCardTexture();
    this.cardMat = new THREE.MeshBasicMaterial({
      map: this.cardTex,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
    });
    this.card = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), this.cardMat);
    this.group.add(this.card);

    // Fireflies: Points with custom additive sprite. One draw call.
    this.fireflyTex = buildFireflyTexture();
    const positions = new Float32Array(FIREFLY_COUNT * 3);
    for (let i = 0; i < FIREFLY_COUNT; i++) {
      // Deterministic-ish initial state from index.
      const a = (i / FIREFLY_COUNT) * Math.PI * 2 + Math.sin(i * 1.3) * 0.4;
      const r = FIREFLY_RADIUS_BASE * (0.85 + (Math.sin(i * 3.7) * 0.5 + 0.5) * 0.4);
      const h = (Math.sin(i * 5.1) * 0.5 + 0.5) * 0.6 - 0.3;
      const speed = 0.4 + (Math.sin(i * 2.2) * 0.5 + 0.5) * 0.5;
      const phaseY = i * 0.7;
      this.fireflyState.push({ a, r, h, speed, phaseY });
      positions[i * 3 + 0] = Math.cos(a) * r;
      positions[i * 3 + 1] = h;
      positions[i * 3 + 2] = Math.sin(a) * r;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    this.fireflyMat = new THREE.PointsMaterial({
      size: 0.10,
      map: this.fireflyTex,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.fireflies = new THREE.Points(geom, this.fireflyMat);
    this.group.add(this.fireflies);
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
    // Card spin — slow, always-on while mounted. Yaw only (cheaper than full
    // 3-axis rotation to look at; reads as "card on display").
    this.cardYaw += dt * 0.25;
    this.card.rotation.y = this.cardYaw;

    // Fireflies: update orbital angles, write to position attribute. Use the
    // existing buffer attribute (no realloc) and flip needsUpdate.
    const posAttr = this.fireflies.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < FIREFLY_COUNT; i++) {
      const s = this.fireflyState[i];
      s.a += dt * s.speed;
      const x = Math.cos(s.a) * s.r;
      const z = Math.sin(s.a) * s.r;
      // Vertical bobbing on top of base height.
      const y = s.h + Math.sin(s.a * 1.3 + s.phaseY) * 0.06;
      posAttr.setXYZ(i, x, y, z);
    }
    posAttr.needsUpdate = true;

    // Scroll fade.
    const targetOpacity =
      scrollProgress < 0.20
        ? scrollProgress / 0.20
        : scrollProgress > 0.85
        ? Math.max(0, 1 - (scrollProgress - 0.85) / 0.15)
        : 1;
    this.opacity += (targetOpacity - this.opacity) * 0.12;
    this.cardMat.opacity = this.opacity;
    this.fireflyMat.opacity = this.opacity;
  }

  setTransform(position: THREE.Vector3, scale: number): void {
    this.group.position.copy(position);
    this.group.scale.setScalar(scale);
  }

  getLeaderAnchor(out: THREE.Vector3): THREE.Vector3 {
    // Left edge of the card.
    out.set(-CARD_W / 2 - 0.05, 0, 0).multiplyScalar(this.group.scale.x);
    out.add(this.group.position);
    return out;
  }

  dispose(scene: THREE.Scene): void {
    this.unmount(scene);
    this.card.geometry.dispose();
    this.cardMat.dispose();
    this.cardTex.dispose();
    this.fireflies.geometry.dispose();
    this.fireflyMat.dispose();
    this.fireflyTex.dispose();
  }
}
