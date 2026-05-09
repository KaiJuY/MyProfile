import * as THREE from 'three';
import type { SceneModule } from '../SceneManager';
import type { ScrollManager } from '@core/ScrollManager';
import { saturate, damp } from '@utils/lerp';

import {
  buildPath,
  type BuiltPath,
  type Milestone,
  DEFAULT_CAMERA_POSITION,
  DEFAULT_CAMERA_LOOKAT,
} from './PathBuilder';
import { Marker } from './Marker';
import { GridFloor } from './GridFloor';
import { HUD } from './HUD';

/**
 * TrajectoryScene — camera flies along a 3D path through the career section.
 *
 * Ownership / responsibilities:
 *   - Owns the path (CatmullRomCurve3 via PathBuilder).
 *   - Owns the marker visuals + grid floor + HUD overlay.
 *   - Drives the SHARED main camera position+lookAt while inside the
 *     `#career` section, then RESTORES the camera to its default state
 *     ((0,0,5) looking at origin) when outside.
 *   - Drives the HTML `.tl-item` text fade-in by reading path-t each frame.
 *
 * Shared-camera contract (CRITICAL):
 *   The Hero/Pursuits/Work/Toolkit scenes all ASSUME the main camera is at
 *   (0,0,5) facing (0,0,0). Their per-frame element-to-world projection math
 *   uses camera.position, so they technically adapt to a moved camera, but
 *   visually they're scrolled off-screen by the time we move the camera. So
 *   we only modify the camera while the user is inside the career section
 *   (sectionProgress in (0,1)) and damp it back to default otherwise.
 *
 * Stencil: NOT used (full-viewport — no clip needed). Simpler.
 *
 * Mobile: same scene, just disable marker emissive glow (cheap shader-cost
 * saving). Path + camera move identically.
 */

const SECTION_ID = 'career';

// Convergence rates (lambda) for the dampers.
const CAMERA_DAMP_LAMBDA = 7; // higher = snappier camera move
const LOOKAT_DAMP_LAMBDA = 6; // slightly slower than position so curves don't whip

// Entry/exit transition bands (in section-progress space). Documented for
// future tuning — the damped position update achieves the visual entry/exit
// blend implicitly because cameraPos starts at default (0,0,5) on first frame
// of the section and the damper eases toward path-start; ditto on exit. If a
// future iteration wants to script GSAP-style explicit transitions these are
// the breakpoints.
// const ENTRY_BAND_END = 0.05;
// const EXIT_BAND_START = 0.95;

const isMobile =
  typeof window !== 'undefined' &&
  (window.innerWidth < 768 ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches));

export class TrajectoryScene implements SceneModule {
  readonly name = 'trajectory';

  private readonly camera: THREE.PerspectiveCamera;
  private readonly scrollManager: ScrollManager;

  private scene!: THREE.Scene;
  private path!: BuiltPath;
  private markers: Marker[] = [];
  private grid!: GridFloor;
  private hud!: HUD;

  // Mounted state — we add/remove from the THREE.Scene based on visibility
  // so other sections aren't paying the draw-call cost.
  private mounted = false;
  private group!: THREE.Group;

  // DOM .tl-item elements, ordered OLDEST-first (reversed from DOM order).
  // Index i corresponds to milestone i.
  private timelineItems: HTMLElement[] = [];
  // Per-item current opacity (so we can damp toward target instead of snapping).
  private itemOpacity: number[] = [];

  // Smoothed camera state — damped each frame toward path-derived targets
  // (when in section) or toward default (when outside).
  private cameraPos = new THREE.Vector3();
  private lookAtTarget = new THREE.Vector3();

  // Reusable scratch.
  private tmpPos = new THREE.Vector3();
  private tmpAhead = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, scrollManager: ScrollManager) {
    this.camera = camera;
    this.scrollManager = scrollManager;
  }

  init(scene: THREE.Scene): void {
    this.scene = scene;

    // Build path + supporting visuals.
    this.path = buildPath();
    this.group = new THREE.Group();
    // Make sure markers/grid are visible regardless of fog (fog in scene
    // would dim them). We don't add fog to the scene globally because
    // other sections rely on it not being there.

    // Build markers — one per milestone (NOT per control point).
    for (const m of this.path.milestones) {
      // Tangent at this t — used to orient the ring perpendicular to flight.
      const tangent = this.path.curve.getTangent(m.t).clone().normalize();
      const marker = new Marker({
        position: m.position.clone(),
        tangent,
        glowEnabled: !isMobile,
      });
      this.markers.push(marker);
      this.group.add(marker.group);
    }

    // Grid floor.
    this.grid = new GridFloor();
    this.group.add(this.grid.mesh);

    // HUD overlay (DOM, not WebGL).
    this.hud = new HUD(this.path.milestones);

    // Cache .tl-item nodes. Per the playbook brief, query in DOM order then
    // REVERSE so index 0 = oldest (NYCU) which corresponds to milestone[0].
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>('section#career .tl-item')
    );
    this.timelineItems = nodes.slice().reverse();
    this.itemOpacity = this.timelineItems.map(() => 0);

    // Initialize HTML items to invisible. We never re-show them via display
    // because the section's height comes from the document layout — they
    // need to occupy space whether or not they're visually faded in.
    for (const el of this.timelineItems) {
      el.style.opacity = '0';
      el.style.transform = 'translateY(18px)';
      el.style.transition = 'none'; // we drive via JS each frame
      el.style.willChange = 'opacity, transform';
    }

    // Initialize smoothed camera state to the current camera state — avoids a
    // frame-1 jump if the user starts mid-page.
    this.cameraPos.copy(this.camera.position);
    this.lookAtTarget.copy(DEFAULT_CAMERA_LOOKAT);
  }

  /** Mount marker group + grid into the scene. */
  private mount(): void {
    if (this.mounted) return;
    this.scene.add(this.group);
    this.mounted = true;
  }
  /** Remove marker group + grid from the scene (cheap when section off-screen). */
  private unmount(): void {
    if (!this.mounted) return;
    this.scene.remove(this.group);
    this.mounted = false;
  }

  update(dt: number): void {
    const sp = this.scrollManager.sectionProgress(SECTION_ID);
    const inSection = sp > 0.001 && sp < 0.999;

    // Visibility — when not in section, unmount and reset HTML fades.
    if (!inSection) {
      // Tween camera back to default position+lookAt smoothly. This is
      // important because if the user scrolls *past* career into contact, we
      // need to hand off back to the (0,0,5) default before the contact
      // section's content needs the camera again.
      this.cameraPos.x = damp(this.cameraPos.x, DEFAULT_CAMERA_POSITION.x, CAMERA_DAMP_LAMBDA, dt);
      this.cameraPos.y = damp(this.cameraPos.y, DEFAULT_CAMERA_POSITION.y, CAMERA_DAMP_LAMBDA, dt);
      this.cameraPos.z = damp(this.cameraPos.z, DEFAULT_CAMERA_POSITION.z, CAMERA_DAMP_LAMBDA, dt);
      this.lookAtTarget.x = damp(this.lookAtTarget.x, DEFAULT_CAMERA_LOOKAT.x, LOOKAT_DAMP_LAMBDA, dt);
      this.lookAtTarget.y = damp(this.lookAtTarget.y, DEFAULT_CAMERA_LOOKAT.y, LOOKAT_DAMP_LAMBDA, dt);
      this.lookAtTarget.z = damp(this.lookAtTarget.z, DEFAULT_CAMERA_LOOKAT.z, LOOKAT_DAMP_LAMBDA, dt);

      // Snap when close enough — avoids floating-point rounding error
      // accumulating across the rest of the page.
      if (this.cameraPos.distanceToSquared(DEFAULT_CAMERA_POSITION) < 1e-4) {
        this.cameraPos.copy(DEFAULT_CAMERA_POSITION);
        this.lookAtTarget.copy(DEFAULT_CAMERA_LOOKAT);
      }
      this.camera.position.copy(this.cameraPos);
      this.camera.lookAt(this.lookAtTarget);
      this.camera.updateMatrixWorld();

      // Hide markers + grid (cheap optimization — removes draw calls when
      // user is on Hero / Pursuits / Work / Toolkit / Contact).
      this.unmount();

      // Fade out all HTML items.
      for (let i = 0; i < this.timelineItems.length; i++) {
        this.itemOpacity[i] = damp(this.itemOpacity[i], 0, 4, dt);
        const el = this.timelineItems[i];
        const o = this.itemOpacity[i];
        el.style.opacity = `${o}`;
        el.style.transform = `translateY(${(1 - o) * 18}px)`;
      }

      // HUD updated to reflect "outside section" — opacity drives off
      // sectionProgress so it'll be 0 here.
      this.hud.update(0, sp, 0);
      return;
    }

    // Inside the section: mount visuals.
    this.mount();

    // Compute the target path point and look-ahead point.
    //
    // Entry transition: when sp ∈ [0, ENTRY_BAND_END), tween the camera from
    // its current position toward path-start over those frames. We do this
    // implicitly via the damper — the target IS the path point, but the
    // current is still near (0,0,5), so it eases in.
    //
    // Exit transition: when sp > EXIT_BAND_START, the path-t saturates at 1
    // (final marker reached) and we let the camera continue PAST by reading
    // the trailing 5th control point's neighbourhood through the same curve
    // (it extrapolates because t=1 is the end). We use lookAhead-only beyond
    // the final marker — fly past then fade the HUD out.
    const pathT = saturate(sp);

    this.path.curve.getPoint(pathT, this.tmpPos);
    // Look slightly ahead. We use a small forward step in t-space; clamp to
    // prevent reading past the curve end (which would extrapolate weirdly).
    const aheadT = Math.min(pathT + 0.05, 1);
    this.path.curve.getPoint(aheadT, this.tmpAhead);

    // Damp camera position toward target. Higher lambda during entry/exit
    // so the camera "drops in" / "fly out" feels deliberate without snapping.
    const lambda = CAMERA_DAMP_LAMBDA;
    this.cameraPos.x = damp(this.cameraPos.x, this.tmpPos.x, lambda, dt);
    this.cameraPos.y = damp(this.cameraPos.y, this.tmpPos.y, lambda, dt);
    this.cameraPos.z = damp(this.cameraPos.z, this.tmpPos.z, lambda, dt);

    // Damp lookAt toward "look ahead" point.
    this.lookAtTarget.x = damp(this.lookAtTarget.x, this.tmpAhead.x, LOOKAT_DAMP_LAMBDA, dt);
    this.lookAtTarget.y = damp(this.lookAtTarget.y, this.tmpAhead.y, LOOKAT_DAMP_LAMBDA, dt);
    this.lookAtTarget.z = damp(this.lookAtTarget.z, this.tmpAhead.z, LOOKAT_DAMP_LAMBDA, dt);

    // Apply to the shared camera.
    this.camera.position.copy(this.cameraPos);
    this.camera.lookAt(this.lookAtTarget);
    this.camera.updateMatrixWorld();

    // Move the grid's radial-fade center to follow the camera so the visible
    // floor circle stays around wherever we're looking.
    this.grid.setCenter(this.cameraPos);

    // Update markers — find the active one (closest in path-t to current
    // pathT) and pump up its scale/color. Per playbook footer §2 / §1.
    let activeIdx = -1;
    let activeDist = Infinity;
    for (let i = 0; i < this.markers.length; i++) {
      const d = Math.abs(pathT - this.path.milestones[i].t);
      if (d < activeDist) {
        activeDist = d;
        activeIdx = i;
      }
    }
    for (let i = 0; i < this.markers.length; i++) {
      const distT = Math.abs(pathT - this.path.milestones[i].t);
      // Nearness in [0,1]: 1 when within 0.04 of the marker, 0 when > 0.18.
      const nearness = saturate(1 - (distT - 0.04) / 0.14);
      this.markers[i].update(dt, nearness, i === activeIdx);
    }

    // Update HTML .tl-item fades from path t. centerT[i] = i / (N-1) →
    // 0.0, 0.333, 0.667, 1.0 for N=4. opacity = 1 - |t - centerT| / window.
    const window_ = 0.18; // soft reveal window
    for (let i = 0; i < this.timelineItems.length; i++) {
      const m: Milestone = this.path.milestones[i];
      const dist = Math.abs(pathT - m.t);
      const target = saturate(1 - dist / window_);
      // Damp toward target — avoids flicker when scrolling fast.
      this.itemOpacity[i] = damp(this.itemOpacity[i], target, 8, dt);
      const o = this.itemOpacity[i];
      const el = this.timelineItems[i];
      el.style.opacity = `${o}`;
      el.style.transform = `translateY(${(1 - o) * 18}px)`;
    }

    // Update HUD. Pass the actual smoothed camera Z so DEPTH reads stay in
    // lockstep with what's on screen.
    this.hud.update(pathT, sp, this.cameraPos.z);
  }

  dispose(scene: THREE.Scene): void {
    if (this.mounted) scene.remove(this.group);
    for (const m of this.markers) m.dispose();
    this.markers.length = 0;
    if (this.grid) this.grid.dispose();
    if (this.hud) this.hud.dispose();
    // Restore the camera to default — leaving the scene mid-trajectory would
    // strand the camera somewhere down the path, breaking other sections.
    this.camera.position.copy(DEFAULT_CAMERA_POSITION);
    this.camera.lookAt(DEFAULT_CAMERA_LOOKAT);
    this.camera.updateMatrixWorld();
    // Restore tl-item inline styles we set in init.
    for (const el of this.timelineItems) {
      el.style.opacity = '';
      el.style.transform = '';
      el.style.transition = '';
      el.style.willChange = '';
    }
  }
}
