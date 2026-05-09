import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { SceneModule } from '../SceneManager';
import type { PhysicsWorld } from '@physics/PhysicsWorld';
import { elementToWorld, elementToWorldSize } from '@core/ScreenToWorld';
import { clamp } from '@utils/lerp';
import { SkillObject, type SkillDescriptor, type SkillGeometry } from './SkillObject';
import { SandboxBoundary } from './SandboxBoundary';
import { SandboxWindow } from './SandboxWindow';

/**
 * ToolkitScene — Rapier physics sandbox anchoring `section#bag`.
 *
 * Behavior layers (per playbook §4):
 *   1. Anchor: read `.bag-list` bbox each frame → world-space center + size.
 *   2. Resize boundary walls + stencil window to match.
 *   3. Per-skill forces:
 *        - Attractive spring toward home position (k_attract = 0.3).
 *        - Inverse-square repulsion vs every other skill (k_repel, capped).
 *        - Torque toward "upright = angle around X".
 *        - Strong repulsive impulse from cursor when within proximity.
 *   4. Cursor: kinematic ball, follows mouse via EMA-smoothed unprojection.
 *      Parked off-screen when section out of viewport or pointer-coarse mobile.
 *   5. Idle activity: after 5s without mousemove, apply small impulse to
 *      a random skill every 2.5s.
 *
 * Mobile (window.innerWidth < 768 OR pointer:coarse):
 *   - Skip physics entirely; lay objects out in fixed 4x2 grid; rotate slowly.
 *
 * Stencil:
 *   - SandboxWindow writes ref=2 (different from HeroScene's ref=1).
 *   - Skill meshes use stencilFunc=EQUAL, ref=2 → only paint inside window.
 *   - Labels are stencilWrite=false → ALWAYS show, even if hanging out.
 */

const TOOLKIT_DEPTH = 5;

// ----- physics tuning constants (exposed for documentation) -----
const K_ATTRACT = 0.45; // spring toward home — slightly stronger than playbook's 0.3
const K_REPEL = 1.6; // pairwise inverse-square coefficient
const REPEL_FORCE_CAP = 8; // max pairwise repel force (newtons)
const REPEL_MIN_R2 = 0.05; // softening floor in inverse-square
const TORQUE_K = 0.06; // upright-torque magnitude
const CURSOR_RADIUS = 0.5;
const CURSOR_PROX_R = 1.2; // start pushing when ball center within this distance
const CURSOR_PUSH = 4.0; // peak repulsive impulse magnitude per frame
const MOUSE_SMOOTH = 0.25; // EMA factor for cursor position
const IDLE_THRESHOLD_MS = 5000;
const IDLE_REPEAT_MIN_MS = 2200;
const IDLE_REPEAT_MAX_MS = 3200;
const IDLE_IMPULSE = 0.6;

const isMobile =
  typeof window !== 'undefined' &&
  (window.innerWidth < 768 ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches));

/**
 * Map a skill index → geometry name. Order MUST match the DOM order of
 * `.bag-list .club` (Python, C#/.NET, C/C++, AI, Embedded, Protocols, DB, DevOps).
 * Sourced from playbook §2.
 */
const GEOMETRY_BY_INDEX: SkillGeometry[] = [
  'octahedron',     // python
  'rounded_cube',   // csharp
  'tetrahedron',    // cpp
  'icosahedron',    // ai_ml
  'rounded_cube',   // embedded
  'torus',          // protocols
  'cylinder',       // database
  'octahedron',     // devops
];

/** Hardcoded fallback if DOM is empty / pre-hydration. */
const FALLBACK_SKILLS: Array<Pick<SkillDescriptor, 'id' | 'label' | 'angle' | 'hasAngle'>> = [
  { id: 'python',    label: 'PYTHON',       angle: 9,   hasAngle: true },
  { id: 'csharp',    label: 'C# / .NET',    angle: 15,  hasAngle: true },
  { id: 'cpp',       label: 'C / C++',      angle: 18,  hasAngle: true },
  { id: 'ai_ml',     label: 'AI · ML · DL', angle: 0,   hasAngle: false },
  { id: 'embedded',  label: 'EMBEDDED',     angle: 46,  hasAngle: true },
  { id: 'protocols', label: 'PROTOCOLS',    angle: 52,  hasAngle: true },
  { id: 'database',  label: 'DATABASE',     angle: 56,  hasAngle: true },
  { id: 'devops',    label: 'DEVOPS',       angle: 3.5, hasAngle: true },
];

/**
 * Read skills from DOM (`.bag-list .club`). We read the ANGLE only — the
 * label always comes from FALLBACK_SKILLS (EN strings). Reason: troika's
 * default font is Roboto Latin → no CJK glyphs. Per playbook §171, the
 * spec is "use EN labels only on first iteration; CJK is a future polish
 * pass". When the site is in zh-mode the DOM shows Chinese text, but the
 * 3D label always reads in English regardless.
 *
 * If DOM is missing, fall back entirely to FALLBACK_SKILLS.
 */
function readSkillsFromDOM(): Array<Pick<SkillDescriptor, 'id' | 'label' | 'angle' | 'hasAngle'>> {
  const clubs = document.querySelectorAll<HTMLElement>('section#bag .bag-list .club');
  if (clubs.length === 0) return [];
  const out: Array<Pick<SkillDescriptor, 'id' | 'label' | 'angle' | 'hasAngle'>> = [];
  clubs.forEach((el, idx) => {
    const fb = FALLBACK_SKILLS[idx];
    const loftEl = el.querySelector<HTMLElement>('.club-loft');
    const loftText = (loftEl?.textContent ?? '').trim();
    // "9°" → 9; "—" → NaN
    const m = /([\d.]+)/.exec(loftText);
    const parsed = m ? parseFloat(m[1]) : NaN;
    // Prefer DOM-parsed angle (source of truth on the live site); fall back
    // to the hardcoded value if DOM has no number (e.g. the "—" placeholder).
    const angle = Number.isFinite(parsed) ? parsed : (fb?.angle ?? 0);
    const hasAngle = Number.isFinite(parsed) ? true : (fb?.hasAngle ?? false);
    out.push({
      id: fb?.id ?? `s${idx}`,
      label: fb?.label ?? `SKILL_${idx}`, // ALWAYS EN
      angle,
      hasAngle,
    });
  });
  return out;
}

export class ToolkitScene implements SceneModule {
  readonly name = 'toolkit';

  private readonly camera: THREE.PerspectiveCamera;
  private readonly physics: PhysicsWorld;
  private scene!: THREE.Scene;

  // DOM anchors
  private sectionEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;

  private skills: SkillObject[] = [];
  private boundary?: SandboxBoundary;
  private window?: SandboxWindow;

  // Cursor state
  private cursorBody?: RAPIER.RigidBody;
  private mouseScreen = { x: -1e6, y: -1e6 };
  private mouseSmoothed = { x: -1e6, y: -1e6 };
  private lastMouseT = 0;
  private mouseInsideSection = false;

  // Sandbox geometry (recomputed each frame)
  private sandCenter = new THREE.Vector3();
  private halfW = 3.5;
  private halfH = 1.8;
  private halfD = 1.4;

  // Reusable scratch
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private tmpA = new THREE.Quaternion();
  private tmpB = new THREE.Quaternion();
  private tmpC = new THREE.Quaternion();

  // Lights (lazy, only when section visible)
  private ambient?: THREE.AmbientLight;
  private directional?: THREE.DirectionalLight;
  private lightsMounted = false;

  // Idle timing
  private nextIdleImpulseT = 0;

  // Bound listeners
  private onMouseMove = (e: MouseEvent): void => {
    this.mouseScreen.x = e.clientX;
    this.mouseScreen.y = e.clientY;
    this.lastMouseT = performance.now();
  };

  constructor(camera: THREE.PerspectiveCamera, physics: PhysicsWorld) {
    this.camera = camera;
    this.physics = physics;
  }

  init(scene: THREE.Scene): void {
    this.scene = scene;
    this.sectionEl = document.querySelector<HTMLElement>('section#bag');
    this.listEl = document.querySelector<HTMLElement>('section#bag .bag-list');
    if (!this.sectionEl || !this.listEl) {
      // eslint-disable-next-line no-console
      console.warn('ToolkitScene: section#bag / .bag-list not found — module disabled');
      return;
    }

    // Read skills (DOM first, fallback to hardcoded list).
    const parsed = readSkillsFromDOM();
    const source = parsed.length > 0 ? parsed : FALLBACK_SKILLS;

    // Build SkillObjects.
    for (let i = 0; i < source.length; i++) {
      const desc: SkillDescriptor = {
        ...source[i],
        geometry: GEOMETRY_BY_INDEX[i] ?? 'octahedron',
        index: i,
      };
      const skill = new SkillObject(desc);
      scene.add(skill.mesh);
      scene.add(skill.label);
      this.skills.push(skill);
    }

    // Lights — toolkit needs its own (Lambert needs a directional source).
    this.ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.directional = new THREE.DirectionalLight(0xffffff, 1.0);
    this.directional.position.set(2, 4, 5);

    // Sandbox window mask.
    this.window = new SandboxWindow();
    scene.add(this.window.mesh);

    // Physics — desktop only.
    if (!isMobile && this.physics.ready) {
      this.boundary = new SandboxBoundary(this.physics);
      this.boundary.build(this.halfW, this.halfH, this.halfD);

      // Compute initial home positions and create bodies.
      this.layoutHomes(this.skills);
      for (const s of this.skills) {
        s.initPhysics(this.physics, s.home);
      }

      // Cursor body — kinematic ball that follows the mouse.
      const cursorDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        -1e4,
        -1e4,
        -1e4,
      );
      this.cursorBody = this.physics.addRigidBody(cursorDesc);
      const cursorColDesc = RAPIER.ColliderDesc.ball(CURSOR_RADIUS).setRestitution(0.2);
      this.physics.addCollider(cursorColDesc, this.cursorBody);

      window.addEventListener('mousemove', this.onMouseMove, { passive: true });
    } else {
      // Mobile: lay out statically.
      this.layoutHomes(this.skills);
      for (const s of this.skills) s.setStaticPose(s.home);
    }

    this.nextIdleImpulseT = performance.now() + IDLE_THRESHOLD_MS;
  }

  /**
   * Compute home positions inside the sandbox. 4 columns × 2 rows centered
   * on (0,0,0) — ToolkitScene later translates everything to sandCenter.
   */
  private layoutHomes(skills: SkillObject[]): void {
    const cols = 4;
    const rows = Math.ceil(skills.length / cols);
    const colSpacing = (this.halfW * 1.6) / cols;
    const rowSpacing = (this.halfH * 1.4) / Math.max(rows, 1);
    for (let i = 0; i < skills.length; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const x = (c - (cols - 1) / 2) * colSpacing;
      const y = ((rows - 1) / 2 - r) * rowSpacing;
      // Slight z stagger so the cluster has depth.
      const z = ((i % 3) - 1) * 0.25;
      skills[i].home.set(x, y, z);
    }
  }

  private mountLights(): void {
    if (this.lightsMounted || !this.ambient || !this.directional) return;
    this.scene.add(this.ambient);
    this.scene.add(this.directional);
    this.lightsMounted = true;
  }

  private unmountLights(): void {
    if (!this.lightsMounted || !this.ambient || !this.directional) return;
    this.scene.remove(this.ambient);
    this.scene.remove(this.directional);
    this.lightsMounted = false;
  }

  update(dt: number): void {
    if (!this.sectionEl || !this.listEl || this.skills.length === 0) return;

    // 1. Anchor sandbox to .bag-list bounding rect.
    elementToWorld(this.listEl, this.camera, TOOLKIT_DEPTH, this.sandCenter);
    const sz = elementToWorldSize(this.listEl, this.camera, TOOLKIT_DEPTH);
    // Half-extents in world. Add 0.4 ws padding on each axis so objects can
    // wander a bit into the gutter without immediately hitting walls.
    this.halfW = Math.max(2.0, sz.width * 0.5 + 0.2);
    this.halfH = Math.max(1.5, sz.height * 0.5 + 0.2);
    this.halfD = 1.4;

    // Visibility window: only render mask + run physics when section is on
    // (or near) screen. Cheap test against viewport.
    const sectionRect = this.sectionEl.getBoundingClientRect();
    const vh = window.innerHeight;
    const onScreen = sectionRect.top < vh + 0.5 * vh && sectionRect.bottom > -0.5 * vh;

    if (!onScreen) {
      // Hide mask, hide labels (cheap optimization), park cursor.
      if (this.window) this.window.hide();
      for (const s of this.skills) {
        s.mesh.visible = false;
        s.label.visible = false;
      }
      this.unmountLights();
      if (this.cursorBody) {
        this.cursorBody.setNextKinematicTranslation({ x: -1e4, y: -1e4, z: -1e4 });
      }
      return;
    }

    // Make objects visible.
    this.mountLights();
    for (const s of this.skills) {
      s.mesh.visible = true;
      s.label.visible = true;
    }

    // 2. Reposition stencil mask + boundary walls.
    if (this.window) {
      this.window.setBox(this.sandCenter, this.halfW * 2, this.halfH * 2);
    }
    if (this.boundary) {
      this.boundary.setBox(this.sandCenter, this.halfW, this.halfH, this.halfD);
    }

    // 3. Recompute home positions in case the sandbox resized.
    this.layoutHomes(this.skills);
    for (const s of this.skills) {
      s.home.add(this.sandCenter); // home = local + sandbox center
    }

    // 4. Mobile path — fixed cluster, slow rotation, no physics.
    if (isMobile || !this.physics.ready) {
      const t = performance.now() * 0.001;
      for (const s of this.skills) {
        s.mesh.position.copy(s.home);
        // Slow rotation around Y, with the per-skill X tilt baked in.
        const xTilt = s.desc.hasAngle ? (s.desc.angle * Math.PI) / 180 : 0;
        s.mesh.rotation.set(xTilt, t * 0.4 + s.desc.index * 0.7, 0);
        s.syncStaticLabel(this.camera);
      }
      return;
    }

    // 5. Mouse → world cursor position (only when mouse is inside section
    //    AND section is on screen). EMA-smooth mouse position to avoid
    //    jittery cursor body moves.
    this.mouseInsideSection =
      this.mouseScreen.x >= sectionRect.left &&
      this.mouseScreen.x <= sectionRect.right &&
      this.mouseScreen.y >= sectionRect.top &&
      this.mouseScreen.y <= sectionRect.bottom;

    if (this.mouseInsideSection) {
      // EMA smoothing.
      if (this.mouseSmoothed.x < -1e3) {
        this.mouseSmoothed.x = this.mouseScreen.x;
        this.mouseSmoothed.y = this.mouseScreen.y;
      } else {
        this.mouseSmoothed.x +=
          (this.mouseScreen.x - this.mouseSmoothed.x) * MOUSE_SMOOTH;
        this.mouseSmoothed.y +=
          (this.mouseScreen.y - this.mouseSmoothed.y) * MOUSE_SMOOTH;
      }
      // Unproject smoothed mouse → world at TOOLKIT_DEPTH.
      const ndcX = (this.mouseSmoothed.x / window.innerWidth) * 2 - 1;
      const ndcY = -((this.mouseSmoothed.y / window.innerHeight) * 2 - 1);
      this.tmp.set(ndcX, ndcY, 0.5).unproject(this.camera);
      this.tmp.sub(this.camera.position).normalize();
      this.tmp2.copy(this.camera.position).addScaledVector(this.tmp, TOOLKIT_DEPTH);
      if (this.cursorBody) {
        this.cursorBody.setNextKinematicTranslation({
          x: this.tmp2.x,
          y: this.tmp2.y,
          z: this.tmp2.z,
        });
      }
    } else {
      // Park cursor far away.
      this.mouseSmoothed.x = -1e6;
      this.mouseSmoothed.y = -1e6;
      if (this.cursorBody) {
        this.cursorBody.setNextKinematicTranslation({ x: -1e4, y: -1e4, z: -1e4 });
      }
    }

    // 6. Apply forces / torques to each skill body.
    const cursorPos = this.cursorBody ? this.cursorBody.translation() : null;
    for (let i = 0; i < this.skills.length; i++) {
      const a = this.skills[i];
      if (!a.body) continue;
      const ap = a.body.translation();

      // 6a. Attractive spring toward home. Net force = K_ATTRACT * (home - pos).
      const fx = (a.home.x - ap.x) * K_ATTRACT;
      const fy = (a.home.y - ap.y) * K_ATTRACT;
      const fz = (a.home.z - ap.z) * K_ATTRACT;

      // 6b. Pairwise repulsion vs every other skill.
      let rx = 0;
      let ry = 0;
      let rz = 0;
      for (let j = 0; j < this.skills.length; j++) {
        if (j === i) continue;
        const b = this.skills[j].body;
        if (!b) continue;
        const bp = b.translation();
        const dx = ap.x - bp.x;
        const dy = ap.y - bp.y;
        const dz = ap.z - bp.z;
        const d2 = Math.max(dx * dx + dy * dy + dz * dz, REPEL_MIN_R2);
        const d = Math.sqrt(d2);
        const mag = Math.min(K_REPEL / d2, REPEL_FORCE_CAP);
        rx += (dx / d) * mag;
        ry += (dy / d) * mag;
        rz += (dz / d) * mag;
      }

      // Combine — addForce accumulates (cleared at end of step).
      a.body.addForce({ x: fx + rx, y: fy + ry, z: fz + rz }, true);

      // 6c. Cursor repulsion — strong impulse if within proximity.
      if (cursorPos && this.mouseInsideSection) {
        const cdx = ap.x - cursorPos.x;
        const cdy = ap.y - cursorPos.y;
        const cdz = ap.z - cursorPos.z;
        const cd2 = cdx * cdx + cdy * cdy + cdz * cdz;
        const prox2 = CURSOR_PROX_R * CURSOR_PROX_R;
        if (cd2 < prox2 && cd2 > 1e-4) {
          const cd = Math.sqrt(cd2);
          // Falloff: linear from 1 at cd=0 to 0 at cd=CURSOR_PROX_R.
          const t = 1 - cd / CURSOR_PROX_R;
          const impulse = CURSOR_PUSH * t * dt; // scale by dt so feel is FPS-stable
          a.body.applyImpulse(
            {
              x: (cdx / cd) * impulse,
              y: (cdy / cd) * impulse,
              z: (cdz / cd) * impulse,
            },
            true,
          );
        }
      }

      // 6d. Torque toward upright (= angle around X).
      a.desiredQuat(this.tmpA);
      a.currentQuat(this.tmpB);
      // Delta quat = desired * inv(current).
      this.tmpC.copy(this.tmpB).invert();
      this.tmpA.multiply(this.tmpC);
      // Convert tiny-angle quat to axis-angle torque axis*angle.
      // For small θ: q.xyz ≈ (axis * sin(θ/2)), so axis*θ ≈ 2 * q.xyz when w>0.
      let qx = this.tmpA.x;
      let qy = this.tmpA.y;
      let qz = this.tmpA.z;
      if (this.tmpA.w < 0) {
        qx = -qx;
        qy = -qy;
        qz = -qz;
      }
      a.body.applyTorqueImpulse(
        { x: qx * TORQUE_K, y: qy * TORQUE_K, z: qz * TORQUE_K },
        true,
      );
    }

    // 7. Idle activity: when no mouse for IDLE_THRESHOLD_MS, periodically
    //    bump a random skill so the sandbox feels alive.
    const now = performance.now();
    const sinceMouse = now - this.lastMouseT;
    if (sinceMouse > IDLE_THRESHOLD_MS && now > this.nextIdleImpulseT) {
      const target = this.skills[Math.floor(Math.random() * this.skills.length)];
      if (target.body) {
        const angle = Math.random() * Math.PI * 2;
        target.body.applyImpulse(
          {
            x: Math.cos(angle) * IDLE_IMPULSE,
            y: Math.sin(angle) * IDLE_IMPULSE * 0.6, // less vertical drift
            z: (Math.random() - 0.5) * IDLE_IMPULSE * 0.4,
          },
          true,
        );
      }
      this.nextIdleImpulseT =
        now + IDLE_REPEAT_MIN_MS + Math.random() * (IDLE_REPEAT_MAX_MS - IDLE_REPEAT_MIN_MS);
    } else if (sinceMouse <= IDLE_THRESHOLD_MS) {
      // Reset the idle scheduler so we don't fire immediately when user goes idle.
      this.nextIdleImpulseT = now + IDLE_THRESHOLD_MS;
    }

    // 8. Soft clamp: if any object escaped (numerical drift / huge impulse),
    //    yank it back inside. Belt-and-suspenders for the boundary walls.
    for (const s of this.skills) {
      if (!s.body) continue;
      const t = s.body.translation();
      const cx = clamp(t.x, this.sandCenter.x - this.halfW, this.sandCenter.x + this.halfW);
      const cy = clamp(t.y, this.sandCenter.y - this.halfH, this.sandCenter.y + this.halfH);
      const cz = clamp(t.z, this.sandCenter.z - this.halfD, this.sandCenter.z + this.halfD);
      if (cx !== t.x || cy !== t.y || cz !== t.z) {
        s.body.setTranslation({ x: cx, y: cy, z: cz }, true);
        const lv = s.body.linvel();
        s.body.setLinvel({ x: lv.x * -0.4, y: lv.y * -0.4, z: lv.z * -0.4 }, true);
      }
    }

    // 9. Sync mesh + label transforms from physics bodies.
    for (const s of this.skills) {
      s.syncFromBody(this.camera);
    }

  }

  dispose(scene: THREE.Scene): void {
    window.removeEventListener('mousemove', this.onMouseMove);

    for (const s of this.skills) {
      s.dispose(scene, this.physics);
    }
    this.skills.length = 0;

    if (this.boundary) {
      this.boundary.dispose();
      this.boundary = undefined;
    }
    if (this.window) {
      scene.remove(this.window.mesh);
      this.window.dispose();
      this.window = undefined;
    }
    if (this.cursorBody && this.physics.ready) {
      try {
        this.physics.world.removeRigidBody(this.cursorBody);
      } catch {
        // ignore
      }
      this.cursorBody = undefined;
    }
    this.unmountLights();
    this.ambient = undefined;
    this.directional = undefined;
  }
}
