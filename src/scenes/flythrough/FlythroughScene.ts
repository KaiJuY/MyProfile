import * as THREE from 'three';
import type { SceneModule } from '../SceneManager';
import type { ScrollManager } from '@core/ScrollManager';
import { elementToWorld, elementToWorldSize } from '@core/ScreenToWorld';
import { getUserPrefs } from '@core/UserPrefs';
import { loadGolfBallGeometry, buildGolfBallMaterial } from '../shared/golfBall';
import { loadGolfTeeGeometry } from '../shared/tee';

/**
 * FlythroughScene — WebGL ball + tee that track the existing CSS-driven
 * flythrough choreography.
 *
 * The inline JS in `index.html` (search for `Sticky flythrough scroll-driven
 * choreography`) animates the `.fly-ball-wrap#flyBall` and `.tee#tee` DOM
 * elements via `transform`. We treat those DOM elements as invisible anchors:
 * each frame we read their `getBoundingClientRect()`, project the rect to a
 * world-space position via `elementToWorld`, and place the matching GLB mesh
 * there. Visual size is derived from the DOM rect so the WebGL meshes scale in
 * lock-step with the CSS keyframes (rest → big mid-flight → exit shrink).
 *
 * The CSS divs themselves are visually hidden via `src/style.css` rules keyed
 * off `.webgl-ready` (set by HeroScene). We keep the DOM boxes in layout (the
 * `.fly-ball-wrap` is `position:absolute; will-change: transform` and only the
 * inner `.fly-ball` div carries the `ball.svg` background) so
 * `getBoundingClientRect` still returns the animated positions.
 *
 * Mobile / reduced-motion path: render nothing — the existing CSS animation
 * handles those cases unchanged.
 */

/** World-units in front of the camera for the flythrough plane. Matches Hero. */
const FLY_DEPTH = 5;

/** Ratio of the GLB tee's normalized bounding-sphere radius (0.5) — tee
 * geometry is taller than wide, so visually the on-screen "ball-like" radius
 * isn't 0.5 world units. Empirical compensation when scaling from DOM size. */
const TEE_VISUAL_GAIN = 1.6;

/** Idle ball spin (rad/s) when the section is in view — visual life only. */
const BALL_IDLE_SPIN = 0.6;

function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.innerWidth < 768) return true;
  if (typeof window.matchMedia === 'function') {
    if (window.matchMedia('(pointer: coarse)').matches) return true;
  }
  return false;
}

export class FlythroughScene implements SceneModule {
  readonly name = 'flythrough';

  private readonly camera: THREE.PerspectiveCamera;
  private readonly scrollManager: ScrollManager;

  private ballMesh: THREE.Mesh | null = null;
  private ballMaterial: THREE.ShaderMaterial | null = null;
  private matcapTex: THREE.Texture | null = null;

  private teeMesh: THREE.Mesh | null = null;
  private teeMaterial: THREE.MeshLambertMaterial | null = null;

  // Lights for the tee's Lambert material. Ball uses an unlit matcap shader so
  // it doesn't need these — but we still add them to the scene because Three
  // shares lights across all materials in the scene graph.
  private teeLight: THREE.DirectionalLight | null = null;
  private teeAmbient: THREE.AmbientLight | null = null;

  // DOM anchors (resolved in init). Null-tolerant — soft-fail if the section
  // markup is missing (we just stop ticking).
  private flythroughEl: HTMLElement | null = null;
  private flyBallEl: HTMLElement | null = null;
  private teeEl: HTMLElement | null = null;

  private bailed = false;
  private timeSec = 0;
  private tmpVec3 = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, scrollManager: ScrollManager) {
    this.camera = camera;
    this.scrollManager = scrollManager;
  }

  async init(scene: THREE.Scene): Promise<void> {
    // Resolve DOM anchors first. If the section isn't present (shouldn't
    // happen in production, but keeps this scene robust during tear-down),
    // bail without loading meshes.
    this.flythroughEl = document.getElementById('flythrough');
    this.flyBallEl = document.getElementById('flyBall');
    this.teeEl = document.getElementById('tee');
    if (!this.flythroughEl || !this.flyBallEl || !this.teeEl) {
      // eslint-disable-next-line no-console
      console.warn(
        'FlythroughScene: #flythrough / #flyBall / #tee not found — module disabled'
      );
      this.bailed = true;
      return;
    }

    // Skip GPU work entirely on mobile + reduced-motion. The CSS animation
    // continues to play (it's all GPU-cheap transforms on the pre-existing
    // DOM elements) and the CSS sphere/tee remain visible because we only
    // hide them under `.webgl-ready` AND when this scene is active.
    if (isMobileViewport() || getUserPrefs().reducedMotion) {
      this.bailed = true;
      return;
    }

    // Matcap for the ball — same texture other scenes already preload via the
    // App.preloadMatcap path, so this is a cache hit at runtime.
    const loader = new THREE.TextureLoader();
    this.matcapTex = loader.load('/textures/matcap-pearl.png');
    this.matcapTex.colorSpace = THREE.SRGBColorSpace;
    this.matcapTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.matcapTex.magFilter = THREE.LinearFilter;
    this.matcapTex.generateMipmaps = true;

    // Ball — share the cached GLB geometry with Hero + Contact. The geometry
    // is normalized to bounding-sphere radius 0.5; per-frame visual scale
    // comes from the CSS rect size.
    const ballGeom = await loadGolfBallGeometry();
    this.ballMaterial = buildGolfBallMaterial(this.matcapTex, null, {
      rimStrength: 0.35,
      rimColor: new THREE.Color(0x9ec3d6),
      // Real dimples are baked into the GLB — let the matcap follow the actual
      // mesh normals (matches Hero + Contact).
      useDimpleMap: false,
    });
    this.ballMesh = new THREE.Mesh(ballGeom, this.ballMaterial);
    this.ballMesh.frustumCulled = false;
    this.ballMesh.visible = false; // mounted hidden; update() reveals when in view
    scene.add(this.ballMesh);

    // Tee — load GLB; apply a warm wood-toned Lambert material. We keep this
    // material monochrome / restrained per the brand rules: warm brown, no
    // emissive glow, no neon. The accent rim stays on the ball alone.
    const teeGeom = await loadGolfTeeGeometry();
    this.teeMaterial = new THREE.MeshLambertMaterial({
      color: 0xb88a55,           // warm wood brown
      emissive: 0x000000,
    });
    this.teeMesh = new THREE.Mesh(teeGeom, this.teeMaterial);
    this.teeMesh.frustumCulled = false;
    this.teeMesh.visible = false;
    scene.add(this.teeMesh);

    // Lights for the tee. Ambient + a single key light from the upper-left so
    // the wood-grain shading reads as 3D rather than flat. Ball is unlit so
    // these don't affect it.
    this.teeAmbient = new THREE.AmbientLight(0xffffff, 0.55);
    this.teeLight = new THREE.DirectionalLight(0xfff1d6, 0.85);
    this.teeLight.position.set(-3, 5, 4);
    scene.add(this.teeAmbient);
    scene.add(this.teeLight);

    // Tell CSS to hide the .fly-ball SVG and .tee SVG visuals (we keep their
    // layout boxes for getBoundingClientRect anchoring). Gate is `.flythrough-3d`
    // on <html> rather than the existing `.webgl-ready` so mobile + reduced-
    // motion fallbacks (which bail before this point) keep their CSS visuals.
    document.documentElement.classList.add('flythrough-3d');
  }

  update(dt: number): void {
    if (this.bailed) return;
    if (!this.ballMesh || !this.teeMesh || !this.flyBallEl || !this.teeEl) return;

    this.timeSec += dt;

    // Perf gate (matches WorkScene / former PursuitsScene): bail when the
    // section is far off-screen. Hides both meshes so they don't burn GPU.
    const secProgress = this.scrollManager.sectionProgress('flythrough');
    if (secProgress < -0.15 || secProgress > 1.15) {
      this.ballMesh.visible = false;
      this.teeMesh.visible = false;
      return;
    }

    // Ball anchor: read the wrapper's rect (CSS animation has already applied
    // its translate + scale). Position the mesh at the rect's world center,
    // and scale it so the on-screen radius matches the rect's half-width.
    const ballRect = this.flyBallEl.getBoundingClientRect();
    if (ballRect.width <= 0 || ballRect.height <= 0) {
      this.ballMesh.visible = false;
    } else {
      elementToWorld(this.flyBallEl, this.camera, FLY_DEPTH, this.tmpVec3);
      this.ballMesh.position.copy(this.tmpVec3);

      // Convert the rect's half-width (in pixels) to world-units at FLY_DEPTH.
      // The cached GLB has bounding-sphere radius 0.5, so a target world
      // radius R means mesh.scale = R / 0.5 = R * 2.
      const ballSize = elementToWorldSize(this.flyBallEl, this.camera, FLY_DEPTH);
      const worldRadius = ballSize.width * 0.5;
      const meshScale = worldRadius * 2;
      this.ballMesh.scale.setScalar(meshScale);

      // Idle spin around Y for visual life. The CSS animation already spins
      // the inner div via background rotation, but that's hidden now — drive
      // a real 3D rotation here. Slow at rest, faster when scale is high
      // (mid-flight).
      const flightHeat = Math.max(0, meshScale - 0.4); // grows when mid-flight
      this.ballMesh.rotation.y += dt * (BALL_IDLE_SPIN + flightHeat * 4);
      this.ballMesh.rotation.x += dt * (BALL_IDLE_SPIN * 0.4 + flightHeat * 1.5);
      this.ballMesh.visible = true;
    }

    // Tee anchor. The CSS rotates the tee post-impact; we mirror that on the
    // mesh by reading the computed transform. Cheap path: re-derive
    // approximate rotation from the section progress (same threshold the
    // inline JS uses: PRE = 0.06, post-PRE flight = (sp - PRE)/(1 - PRE)).
    const teeRect = this.teeEl.getBoundingClientRect();
    if (teeRect.width <= 0 || teeRect.height <= 0) {
      this.teeMesh.visible = false;
    } else {
      elementToWorld(this.teeEl, this.camera, FLY_DEPTH, this.tmpVec3);
      this.teeMesh.position.copy(this.tmpVec3);

      const teeSize = elementToWorldSize(this.teeEl, this.camera, FLY_DEPTH);
      // The CSS tee div is taller than wide (48×144 px); scale so mesh
      // height matches the world-height of the rect. GLB bounding-sphere
      // is normalized to 0.5, so a height H → scale = (H / (2 * 0.5)) =
      // H — but the mesh needs a slight gain so the visual silhouette
      // reads like the original SVG tee.
      const meshScale = teeSize.height * TEE_VISUAL_GAIN;
      this.teeMesh.scale.setScalar(meshScale);

      // Tilt the tee like the CSS does post-impact. PRE = 0.06 in the inline
      // JS; flightP > 0 produces rotate(min(45, flightP * 80)deg).
      const PRE = 0.06;
      const flightP = Math.max(0, Math.min(1, (secProgress - PRE) / (1 - PRE)));
      const inFlight = secProgress > PRE;
      const tiltDeg = inFlight ? Math.min(45, flightP * 80) : 0;
      // The CSS rotation is around the bottom-center of the div (clockwise
      // in screen space). World rotation around z is +CCW; clockwise on
      // screen = -z. Apply on the local Z axis.
      this.teeMesh.rotation.set(0, 0, -(tiltDeg * Math.PI) / 180);
      // Fade the tee post-impact like CSS (max(0, 1 - flightP*4)); we toggle
      // visibility under a small threshold so we don't pay for an invisible
      // mesh.
      const teeOpacity = inFlight ? Math.max(0, 1 - flightP * 4) : 1;
      if (this.teeMaterial) {
        // Lambert without transparent set up-front would just be a flicker
        // toggle; we leave material opaque and just hide the mesh once it's
        // fully invisible.
        if (teeOpacity < 0.01) {
          this.teeMesh.visible = false;
        } else {
          this.teeMesh.visible = true;
          // Soft fade by tinting toward background; cheap and works without
          // making the material transparent.
          const c = this.teeMaterial.color;
          c.setRGB(0.722 * teeOpacity, 0.541 * teeOpacity, 0.333 * teeOpacity);
        }
      }
    }
  }

  dispose(scene: THREE.Scene): void {
    if (this.ballMesh) {
      scene.remove(this.ballMesh);
      // NOTE: ball geometry is the SHARED GLB cache (loadGolfBallGeometry).
      // Hero + Contact also reference it — do NOT dispose here. Full teardown
      // is handled by `disposeSharedGolfBallAssets` at app dispose.
      this.ballMesh = null;
    }
    if (this.ballMaterial) {
      this.ballMaterial.dispose();
      this.ballMaterial = null;
    }
    if (this.teeMesh) {
      scene.remove(this.teeMesh);
      // Tee geometry is also a shared cache — let the app-level
      // `disposeSharedTeeAssets` free it (no other consumer today, but the
      // pattern matches Hero/Contact for consistency and future-proofing).
      this.teeMesh = null;
    }
    if (this.teeMaterial) {
      this.teeMaterial.dispose();
      this.teeMaterial = null;
    }
    if (this.teeLight) {
      scene.remove(this.teeLight);
      this.teeLight = null;
    }
    if (this.teeAmbient) {
      scene.remove(this.teeAmbient);
      this.teeAmbient = null;
    }
    if (this.matcapTex) {
      this.matcapTex.dispose();
      this.matcapTex = null;
    }
    document.documentElement.classList.remove('flythrough-3d');
  }
}
