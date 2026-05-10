import * as THREE from 'three';
import type { SceneModule } from '../SceneManager';
import type { ScrollManager } from '@core/ScrollManager';
import { saturate, damp } from '@utils/lerp';
import { getUserPrefs } from '@core/UserPrefs';

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
import { TrajectoryCard } from './TrajectoryCard';

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
  private card!: TrajectoryCard;
  private langObserver?: MutationObserver;

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

  /** Frame counter — used to throttle the HUD textContent writes. */
  private frame = 0;
  /** True after the post-section damper has fully snapped the camera back to
   *  default. Used to skip the dampers entirely on subsequent frames. */
  private cameraSettled = false;

  constructor(camera: THREE.PerspectiveCamera, scrollManager: ScrollManager) {
    this.camera = camera;
    this.scrollManager = scrollManager;
  }

  init(scene: THREE.Scene): void {
    this.scene = scene;

    // Wave 6: skip the entire trajectory build on mobile. The original
    // `.timeline` HTML stays untouched and forms the experience there.
    if (isMobile) {
      // Stub: build path so milestone metadata still exists for any external
      // consumer, but DON'T spawn marker meshes / HUD / card. The update()
      // loop bails out early on isMobile so none of these are read.
      this.path = buildPath();
      this.group = new THREE.Group();
      this.cameraPos.copy(this.camera.position);
      this.lookAtTarget.copy(DEFAULT_CAMERA_LOOKAT);
      // Construct a dummy disabled card (so dispose / refresh no-op).
      this.card = new TrajectoryCard({
        milestones: this.path.milestones,
        timelineItems: [],
        camera: this.camera,
        enabled: false,
        reducedMotion: getUserPrefs().reducedMotion,
      });
      // Construct a no-mount grid so this.grid exists for dispose; it's never
      // added to the scene on mobile.
      this.grid = new GridFloor();
      // HUD: don't render on mobile — typography was authored for desktop.
      // Provide a stub object that no-ops update/dispose.
      this.hud = new HUD(this.path.milestones);
      // Hide HUD root immediately by setting display:none through the only
      // path we have — calling update with sectionProgress=0 fades opacity to
      // 0 and after a couple frames sets display:none. Belt-and-suspenders:
      // also do it explicitly.
      this.hud.update(0, 0, 0);
      return;
    }

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

    // Wave 6: ONLY take over the .tl-item rendering on desktop. On mobile the
    // floating card is disabled (no projection math, no canvas-overlay card)
    // and the user should see the original scrolling `.timeline` HTML exactly
    // as the inline CSS authored it — no per-frame opacity writes from us.
    //
    // Desktop with WebGL: the `.timeline` block is hidden via CSS
    // (`.webgl-ready section#career .timeline { display: none }` in
    // src/style.css). TrajectoryCard reads year / title / org / paragraph /
    // tags out of the (now-hidden) `.tl-item` nodes — i18n flips work because
    // applyLang() still mutates them.
    if (!isMobile) {
      for (const el of this.timelineItems) {
        el.style.opacity = '0';
        el.style.transform = 'translateY(18px)';
        el.style.transition = 'none'; // we drive via JS each frame
        el.style.willChange = 'opacity, transform';
      }
    }

    // Floating per-milestone card (desktop-only). Reads content from the
    // `.tl-item` nodes above so we never duplicate copy and i18n flips
    // automatically through the existing `applyLang()`.
    //
    // Language sync: index.html's `applyLang()` mutates `[data-i18n]` element
    // innerHTML AND sets `<html data-lang="en|zh">`. We can't modify the inline
    // script to dispatch a custom event (CLAUDE.md hard rule), so we observe
    // the `data-lang` attribute on <html> and re-snapshot on change.
    this.card = new TrajectoryCard({
      milestones: this.path.milestones,
      timelineItems: this.timelineItems,
      camera: this.camera,
      enabled: !isMobile,
      reducedMotion: getUserPrefs().reducedMotion,
    });
    this.langObserver = new MutationObserver(() => this.card?.refreshContents());
    this.langObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-lang'],
    });
    // Refresh once on the next tick so any late i18n application lands.
    setTimeout(() => this.card?.refreshContents(), 0);

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
    this.frame++;
    const sp = this.scrollManager.sectionProgress(SECTION_ID);

    // Mobile: skip the entire trajectory takeover. The original `.timeline`
    // HTML is the experience; no camera move, no marker mount, no card. Snap
    // the camera back to default if we somehow wandered.
    if (isMobile) {
      this.unmount();
      if (!this.cameraSettled) {
        this.cameraPos.copy(DEFAULT_CAMERA_POSITION);
        this.lookAtTarget.copy(DEFAULT_CAMERA_LOOKAT);
        this.camera.position.copy(this.cameraPos);
        this.camera.lookAt(this.lookAtTarget);
        this.camera.updateMatrixWorld();
        this.cameraSettled = true;
      }
      // HUD off-screen on mobile (it was authored for desktop typography).
      if (this.frame % 8 === 0) this.hud.update(0, 0, 0);
      return;
    }

    // Treat the trajectory section as "out" the moment the user enters
    // #contact, even if `sp` is still inside (0.001, 0.999). Otherwise the
    // floating card lingers over the contact links because the career section
    // is tall (220vh) and its sectionProgress only crosses 0.97 well after
    // contact has scrolled into view.
    const contactSp = this.scrollManager.sectionProgress('contact');
    const contactActive = contactSp > 0.0001;
    const inSection = !contactActive && sp > 0.001 && sp < 0.999;

    // Perf gate: when we're far from the section AND the camera+HUD have
    // already settled to default, skip the entire update body. This avoids
    // running the dampers + HUD update + tl-item DOM writes every frame
    // forever after the user passes Trajectory.
    if (!inSection && this.cameraSettled && !this.mounted) {
      return;
    }

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
      // accumulating across the rest of the page. Once snapped, set the
      // settled flag so future frames can skip this whole branch.
      if (this.cameraPos.distanceToSquared(DEFAULT_CAMERA_POSITION) < 1e-4) {
        this.cameraPos.copy(DEFAULT_CAMERA_POSITION);
        this.lookAtTarget.copy(DEFAULT_CAMERA_LOOKAT);
        this.cameraSettled = true;
      }
      this.camera.position.copy(this.cameraPos);
      this.camera.lookAt(this.lookAtTarget);
      this.camera.updateMatrixWorld();

      // Hide markers + grid (cheap optimization — removes draw calls when
      // user is on Hero / Pursuits / Work / Toolkit / Contact).
      this.unmount();

      // Fade out all HTML items (desktop only — mobile keeps the original
      // .timeline HTML untouched per Wave 6 mobile fallback).
      if (!isMobile) {
        for (let i = 0; i < this.timelineItems.length; i++) {
          this.itemOpacity[i] = damp(this.itemOpacity[i], 0, 4, dt);
          const el = this.timelineItems[i];
          const o = this.itemOpacity[i];
          el.style.opacity = `${o}`;
          el.style.transform = `translateY(${(1 - o) * 18}px)`;
        }
      }

      // HUD updated to reflect "outside section" — opacity drives off
      // sectionProgress so it'll be 0 here. Throttle (only updates DOM
      // textContent + a width %; nothing visual at month resolution moves
      // faster than 15Hz needs).
      //
      // When `contactActive` is true the user has scrolled into #contact but
      // career.sectionProgress is still inside the HUD/card visibility band
      // (career section is taller than the viewport, so sp only hits the
      // outer fade-out beyond 0.97). Pass a synthetic sp that's outside
      // both bands so the HUD + card fade fully — otherwise they'd linger
      // on top of the contact links.
      const fadeOutSp = contactActive ? 1.0 : sp;
      if (this.frame % 4 === 0) this.hud.update(0, fadeOutSp, 0);
      // Card hides itself when sectionProgress is outside its band.
      this.card.update(-1, fadeOutSp);
      return;
    }

    // ── Issue #3: Career scene gating ───────────────────────────────────
    // The career section is min-height: 220vh; sectionProgress reaches ≈ 0.32
    // exactly when the section TOP hits the viewport top (i.e., section
    // fills the viewport). Prior to that, the user still sees ~90% Bag
    // section above with the career heading just appearing — playing the
    // ring/card animation here felt premature and disconnected from the
    // career content (user feedback verbatim: "我們一移動到 Career 的標題
    // 時這個區域的動畫就開始出現了，但是這時候 90% 的畫面都還是 Bag 的部分").
    //
    // Therefore: gate the ENTIRE scene presence (markers + card + path
    // animation) on sectionProgress >= SCENE_START_SP. Below this, the
    // group is unmounted and the card is hidden.
    const SCENE_START_SP = 0.32;
    const SCENE_END_SP = 0.98;
    const sceneActive = sp >= SCENE_START_SP - 0.02 && sp <= SCENE_END_SP;
    if (!sceneActive) {
      // Treat the section as "in" for camera-damp purposes (we're inside the
      // 220vh tall block) but DO NOT mount markers / drive the card. Tween
      // the camera back to default so other sections aren't visually
      // impacted by a stranded camera position.
      this.unmount();
      this.cameraPos.x = damp(this.cameraPos.x, DEFAULT_CAMERA_POSITION.x, CAMERA_DAMP_LAMBDA, dt);
      this.cameraPos.y = damp(this.cameraPos.y, DEFAULT_CAMERA_POSITION.y, CAMERA_DAMP_LAMBDA, dt);
      this.cameraPos.z = damp(this.cameraPos.z, DEFAULT_CAMERA_POSITION.z, CAMERA_DAMP_LAMBDA, dt);
      this.lookAtTarget.x = damp(this.lookAtTarget.x, DEFAULT_CAMERA_LOOKAT.x, LOOKAT_DAMP_LAMBDA, dt);
      this.lookAtTarget.y = damp(this.lookAtTarget.y, DEFAULT_CAMERA_LOOKAT.y, LOOKAT_DAMP_LAMBDA, dt);
      this.lookAtTarget.z = damp(this.lookAtTarget.z, DEFAULT_CAMERA_LOOKAT.z, LOOKAT_DAMP_LAMBDA, dt);
      this.camera.position.copy(this.cameraPos);
      this.camera.lookAt(this.lookAtTarget);
      this.camera.updateMatrixWorld();
      // Keep the .tl-item HTML hidden until the scene actually starts.
      if (!isMobile) {
        for (let i = 0; i < this.timelineItems.length; i++) {
          this.itemOpacity[i] = damp(this.itemOpacity[i], 0, 4, dt);
          const el = this.timelineItems[i];
          const o = this.itemOpacity[i];
          el.style.opacity = `${o}`;
          el.style.transform = `translateY(${(1 - o) * 18}px)`;
        }
      }
      // Hide HUD + card when scene isn't yet active — passing sp=0 keeps the
      // band check below the visibility threshold (HUD/card both gate on
      // sp band, see HUD.update + TrajectoryCard.update).
      if (this.frame % 4 === 0) this.hud.update(0, 0, 0);
      this.card.update(-1, 0);
      return;
    }

    // Scene active: mount visuals (re-arms the settled flag for the next
    // post-section pass).
    this.cameraSettled = false;
    this.mount();

    // Compute the target path point and look-ahead point.
    //
    // Issue #3 (user feedback "每個動畫的區間可以稍微拉長一點"): widen the
    // per-milestone band so each transition takes longer. Previously
    // [0.55, 0.95] = 0.40 sp width over 3 transitions ≈ 0.13 each. New band
    // [0.36, 0.92] = 0.56 sp width over 3 transitions ≈ 0.187 each — about
    // 40% longer per transition. With milestone t-values at {0, 0.333,
    // 0.667, 1.0} (4 milestones), midpoints land at sp ≈ {0.45, 0.64, 0.83}.
    //
    // Note: PATH_START_SP = SCENE_START_SP + small lead so the first
    // milestone (NYCU) appears with the ring already visible from the entry
    // fade-in — no hard pop.
    const PATH_START_SP = 0.36;
    const PATH_END_SP = 0.92;
    const pathT = saturate((sp - PATH_START_SP) / (PATH_END_SP - PATH_START_SP));

    this.path.curve.getPoint(pathT, this.tmpPos);
    // Look slightly ahead. We use a small forward step in t-space; clamp to
    // prevent reading past the curve end (which would extrapolate weirdly).
    const aheadT = Math.min(pathT + 0.05, 1);
    this.path.curve.getPoint(aheadT, this.tmpAhead);

    // Damp camera position toward target. Higher lambda during entry/exit
    // so the camera "drops in" / "fly out" feels deliberate without snapping.
    // Reduced motion: snap directly to target (no smoothing).
    const reducedMotion = getUserPrefs().reducedMotion;
    if (reducedMotion) {
      this.cameraPos.copy(this.tmpPos);
      this.lookAtTarget.copy(this.tmpAhead);
    } else {
      const lambda = CAMERA_DAMP_LAMBDA;
      this.cameraPos.x = damp(this.cameraPos.x, this.tmpPos.x, lambda, dt);
      this.cameraPos.y = damp(this.cameraPos.y, this.tmpPos.y, lambda, dt);
      this.cameraPos.z = damp(this.cameraPos.z, this.tmpPos.z, lambda, dt);
      this.lookAtTarget.x = damp(this.lookAtTarget.x, this.tmpAhead.x, LOOKAT_DAMP_LAMBDA, dt);
      this.lookAtTarget.y = damp(this.lookAtTarget.y, this.tmpAhead.y, LOOKAT_DAMP_LAMBDA, dt);
      this.lookAtTarget.z = damp(this.lookAtTarget.z, this.tmpAhead.z, LOOKAT_DAMP_LAMBDA, dt);
    }

    // Apply to the shared camera.
    this.camera.position.copy(this.cameraPos);
    this.camera.lookAt(this.lookAtTarget);
    this.camera.updateMatrixWorld();

    // Move the grid's radial-fade center to follow the camera so the visible
    // floor circle stays around wherever we're looking.
    this.grid.setCenter(this.cameraPos);

    // Update markers — find the active one (closest in path-t to current
    // pathT) and pump up its scale/color. Per playbook footer §2 / §1.
    //
    // Issue #2 (single-focus): the closest marker is ALWAYS the active one
    // (so the card always has content to display); the depth-pull effect is
    // achieved by the per-marker scale/opacity in Marker.update — adjacent
    // markers fade to scale=0 outside their nearness window, so visually
    // only ONE ring is in focus at any moment.
    let activeIdx = -1;
    let activeDist = Infinity;
    for (let i = 0; i < this.markers.length; i++) {
      const d = Math.abs(pathT - this.path.milestones[i].t);
      if (d < activeDist) {
        activeDist = d;
        activeIdx = i;
      }
    }
    // Track the rate-of-change of activeIdx for the card cross-fade trigger.
    // (No additional gating — TrajectoryCard's `transitionTo` runs on every
    // activeIdx change which is what drives the focus-pull animation.)
    // Issue #2 (single-focus): with milestone t-values now evenly spaced at
    // 0.20 increments, we narrow the nearness window so adjacent rings fade
    // out before the next one fades in. Window 0.10 centered on the marker
    // means a ring is fully visible only within ±0.05 of its t — at the
    // exact midpoint between two markers (e.g. t=0.30 between milestone 0
    // and 1) BOTH neighbors are at nearness=0 and the active ring's "depth
    // pull" gets the full focus.
    for (let i = 0; i < this.markers.length; i++) {
      const distT = Math.abs(pathT - this.path.milestones[i].t);
      // Nearness in [0,1]: 1 when within 0.02 of the marker, 0 when > 0.10.
      const nearness = saturate(1 - (distT - 0.02) / 0.08);
      this.markers[i].update(dt, nearness, i === activeIdx);
    }

    // Update HTML .tl-item fades from path t. centerT[i] = i / (N-1) →
    // 0.0, 0.333, 0.667, 1.0 for N=4. opacity = 1 - |t - centerT| / window.
    // Desktop only — on mobile the original `.timeline` is left alone
    // (no WebGL takeover).
    if (!isMobile) {
      const window_ = 0.18; // soft reveal window
      for (let i = 0; i < this.timelineItems.length; i++) {
        const m: Milestone = this.path.milestones[i];
        const dist = Math.abs(pathT - m.t);
        const target = saturate(1 - dist / window_);
        // Reduced motion: snap to target (no damp), and don't translate.
        if (reducedMotion) {
          this.itemOpacity[i] = target;
          const el = this.timelineItems[i];
          el.style.opacity = `${target}`;
          el.style.transform = 'translateY(0)';
        } else {
          this.itemOpacity[i] = damp(this.itemOpacity[i], target, 8, dt);
          const o = this.itemOpacity[i];
          const el = this.timelineItems[i];
          el.style.opacity = `${o}`;
          el.style.transform = `translateY(${(1 - o) * 18}px)`;
        }
      }
    }

    // Update HUD. Pass the actual smoothed camera Z so DEPTH reads stay in
    // lockstep with what's on screen. Throttle to 15Hz — DEPTH/STEP/POS
    // values only change at month resolution; the bar width has a CSS
    // 80ms transition so 4-frame quantization is invisible.
    if (this.frame % 4 === 0) this.hud.update(pathT, sp, this.cameraPos.z);

    // Drive the floating milestone card. It runs every frame because its
    // pixel position needs to track the projected marker as the camera moves;
    // skipping frames would feel laggy. Inner update is cheap (one project()
    // + a transform string write).
    this.card.update(activeIdx, sp);
  }

  dispose(scene: THREE.Scene): void {
    if (this.mounted) scene.remove(this.group);
    for (const m of this.markers) m.dispose();
    this.markers.length = 0;
    if (this.grid) this.grid.dispose();
    if (this.hud) this.hud.dispose();
    if (this.card) this.card.dispose();
    if (this.langObserver) {
      this.langObserver.disconnect();
      this.langObserver = undefined;
    }
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
