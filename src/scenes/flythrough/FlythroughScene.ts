import * as THREE from 'three';
import type { SceneModule } from '../SceneManager';
import type { ScrollManager } from '@core/ScrollManager';
import { elementToWorld, elementToWorldSize } from '@core/ScreenToWorld';
import { getUserPrefs } from '@core/UserPrefs';
import { loadGolfBallGeometry, buildGolfBallMaterial } from '../shared/golfBall';
import { loadGolfTeeGeometry, getTeeMetrics } from '../shared/tee';

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

/** Same PRE constant the inline JS uses (search index.html for `const PRE`). */
const PRE_IMPACT_SP = 0.06;

/** Shockwave + particle config — desktop only. */
const SHOCKWAVE_DURATION_S = 0.6;     // 600ms ring expand
const SHOCKWAVE_MAX_RADIUS = 1.5;     // world units
const PARTICLE_COUNT = 40;
const PARTICLE_DURATION_S = 0.85;     // 850ms particle life
const PARTICLE_MAX_SPEED = 2.6;       // world units/s

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
  /** Inner fill sphere — fills culled-cavity gaps (issue #1). */
  private ballFillMesh: THREE.Mesh | null = null;
  private ballFillMaterial: THREE.ShaderMaterial | null = null;
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

  // ── Shockwave + particle FX (desktop only — issue #2c) ──────────────────
  /** Expanding ring at the impact point. */
  private shockwaveMesh: THREE.Mesh | null = null;
  private shockwaveMaterial: THREE.ShaderMaterial | null = null;
  /** Particles emitted radially from the impact point. */
  private particleMesh: THREE.Points | null = null;
  private particleMaterial: THREE.ShaderMaterial | null = null;
  // (Per-particle direction + speed are baked into the BufferGeometry's
  // aDir + aSpeed attributes at init — no per-frame CPU read needed.)
  /** Time elapsed since the most recent impact trigger. -1 = inactive. */
  private impactElapsed = -1;
  /** True while sectionProgress is in the impact band; latches to false after
   *  the first trigger so we don't retrigger every frame inside the band. */
  private impactArmed = true;

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
      rimStrength: 0.45,
      rimColor: new THREE.Color(0x9ec3d6),
      // Real dimples are baked into the GLB — let the matcap follow the actual
      // mesh normals (matches Hero + Contact).
      useDimpleMap: false,
      // Soften matcap toward camera so dimple cavities don't read as black pits.
      matcapSoftness: 0.55,
    });
    // Wrap the dimpled GLB mesh + an inner fill sphere into a Group. The
    // inner sphere closes the small gaps left by FrontSide-culled dimple
    // cavities so the ball reads as a uniform white pearl (issue #1).
    const dimpledMesh = new THREE.Mesh(ballGeom, this.ballMaterial);
    dimpledMesh.frustumCulled = false;
    const fillGeom = new THREE.SphereGeometry(0.5 * 0.965, 64, 48);
    this.ballFillMaterial = buildGolfBallMaterial(this.matcapTex, null, {
      useDimpleMap: false,
      matcapSoftness: 1.0,
      rimStrength: 0.0,
    });
    this.ballFillMesh = new THREE.Mesh(fillGeom, this.ballFillMaterial);
    this.ballFillMesh.frustumCulled = false;
    this.ballFillMesh.renderOrder = -1;
    const ballGroup = new THREE.Group();
    ballGroup.add(this.ballFillMesh);
    ballGroup.add(dimpledMesh);
    // Cast group as Mesh so the rest of the class (which reads .position /
    // .scale / .visible / .rotation) works unchanged.
    this.ballMesh = ballGroup as unknown as THREE.Mesh;
    (this.ballMesh as unknown as THREE.Object3D).visible = false;
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

    // ── Shockwave ring (issue #2c) ──────────────────────────────────────
    // Expanding ring centered on the impact point. Custom shader animates
    // radius via uProgress so we don't need to rebuild geometry. Disc fades
    // from a thin 1.0-opacity ring at p=0 to a fat 0.0-opacity ring at p=1.
    {
      const ringGeom = new THREE.PlaneGeometry(2, 2, 1, 1);
      const ringMat = new THREE.ShaderMaterial({
        uniforms: {
          uProgress: { value: 0.0 },
          uColor: { value: new THREE.Color(0xff6a00) }, // accent orange
        },
        vertexShader: /* glsl */`
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */`
          precision highp float;
          uniform float uProgress;
          uniform vec3 uColor;
          varying vec2 vUv;
          void main() {
            // distance from center [0..1]
            vec2 c = vUv - 0.5;
            float r = length(c) * 2.0;
            // Ring radius grows with progress. Thickness shrinks slightly as
            // it expands so the wave reads as "energy dissipating outward".
            float ringR = uProgress;
            float thickness = mix(0.18, 0.06, uProgress);
            float band = 1.0 - smoothstep(thickness, thickness + 0.04, abs(r - ringR));
            // Fade out over time + clip when r > 1 (outside disc).
            float life = 1.0 - uProgress;
            float alpha = band * life * step(r, 1.0);
            // Soft inner glow blends into the band.
            vec3 col = uColor + vec3(0.4) * pow(life, 2.0);
            gl_FragColor = vec4(col, alpha);
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.shockwaveMesh = new THREE.Mesh(ringGeom, ringMat);
      this.shockwaveMesh.frustumCulled = false;
      this.shockwaveMesh.visible = false;
      this.shockwaveMaterial = ringMat;
      scene.add(this.shockwaveMesh);
    }

    // ── Particle burst (issue #2c) ──────────────────────────────────────
    // 40 additive points emitted radially from the impact point. Uses a
    // ShaderMaterial with per-frame `uTime` driving each particle's offset
    // along its baked direction. Cheap, no per-frame attribute updates.
    {
      const positions = new Float32Array(PARTICLE_COUNT * 3); // base = origin
      const dirs = new Float32Array(PARTICLE_COUNT * 3);
      const speeds = new Float32Array(PARTICLE_COUNT);
      const sizes = new Float32Array(PARTICLE_COUNT);
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const ang = (i / PARTICLE_COUNT) * Math.PI * 2 + Math.random() * 0.4;
        // Bias direction slightly toward upper hemisphere (the "splatter"
        // pattern of a ball hit reads better when most particles fly up).
        const yBias = Math.random() * 0.6 + 0.1; // [0.1, 0.7]
        dirs[i * 3 + 0] = Math.cos(ang);
        dirs[i * 3 + 1] = yBias;
        dirs[i * 3 + 2] = Math.sin(ang) * 0.3;
        // Normalize.
        const len = Math.hypot(dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2]);
        dirs[i * 3] /= len;
        dirs[i * 3 + 1] /= len;
        dirs[i * 3 + 2] /= len;
        speeds[i] = (0.5 + Math.random() * 0.5) * PARTICLE_MAX_SPEED;
        sizes[i] = 16 + Math.random() * 24; // px size at DPR=1
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geom.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
      geom.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
      geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0.0 },     // seconds since impact
          uDuration: { value: PARTICLE_DURATION_S },
          uColor: { value: new THREE.Color(0xff8a3a) },
        },
        vertexShader: /* glsl */`
          attribute vec3 aDir;
          attribute float aSpeed;
          attribute float aSize;
          uniform float uTime;
          uniform float uDuration;
          varying float vLife; // 1=just born, 0=expired
          void main() {
            float t = clamp(uTime / uDuration, 0.0, 1.0);
            // Ease-out distance: fast initial spread, slows down. Drag.
            float d = aSpeed * (1.0 - exp(-3.5 * t));
            // Gravity bias in -Y over time so rising particles arc back.
            vec3 offset = aDir * d + vec3(0.0, -0.9 * t * t, 0.0);
            vec3 worldPos = position + offset;
            vec4 mv = modelViewMatrix * vec4(worldPos, 1.0);
            gl_Position = projectionMatrix * mv;
            // Perspective-corrected size so particles shrink with distance.
            gl_PointSize = aSize * (300.0 / max(0.1, -mv.z));
            vLife = 1.0 - t;
          }
        `,
        fragmentShader: /* glsl */`
          precision highp float;
          uniform vec3 uColor;
          varying float vLife;
          void main() {
            vec2 c = gl_PointCoord - 0.5;
            float r = length(c);
            // Soft radial alpha — bright core, fading edge.
            float a = smoothstep(0.5, 0.0, r) * vLife;
            vec3 col = mix(vec3(1.0, 0.85, 0.5), uColor, 1.0 - vLife);
            gl_FragColor = vec4(col, a);
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.particleMaterial = mat;
      this.particleMesh = new THREE.Points(geom, mat);
      this.particleMesh.frustumCulled = false;
      this.particleMesh.visible = false;
      scene.add(this.particleMesh);
    }

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
      if (this.shockwaveMesh) this.shockwaveMesh.visible = false;
      if (this.particleMesh) this.particleMesh.visible = false;
      // Re-arm impact trigger so re-entering the section plays the FX again.
      this.impactArmed = true;
      this.impactElapsed = -1;
      return;
    }

    // Compute flightP / inFlight up-front — both ball and tee use these and
    // the impact-FX trigger reads them too.
    const flightP = Math.max(
      0,
      Math.min(1, (secProgress - PRE_IMPACT_SP) / (1 - PRE_IMPACT_SP))
    );
    const inFlight = secProgress > PRE_IMPACT_SP;

    // ─── Tee anchor (compute first so we can seat the ball on top of it) ───
    let teeWorldTopY: number | null = null;
    let teeWorldRadius = 0;
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

      // Tilt the tee like the CSS does post-impact (issue #2a fix lives in
      // tee.ts loader — base-down/tip-up canonical orientation). The
      // post-impact rotation is layered on top of that canonical pose.
      const tiltDeg = inFlight ? Math.min(45, flightP * 80) : 0;
      this.teeMesh.rotation.set(0, 0, -(tiltDeg * Math.PI) / 180);
      // Fade the tee post-impact like CSS (max(0, 1 - flightP*4)); we toggle
      // visibility under a small threshold so we don't pay for an invisible
      // mesh.
      const teeOpacity = inFlight ? Math.max(0, 1 - flightP * 4) : 1;
      if (this.teeMaterial) {
        if (teeOpacity < 0.01) {
          this.teeMesh.visible = false;
        } else {
          this.teeMesh.visible = true;
          const c = this.teeMaterial.color;
          c.setRGB(0.722 * teeOpacity, 0.541 * teeOpacity, 0.333 * teeOpacity);
        }
      }

      // World top of the tee — base for the ball-on-tee constraint and the
      // impact-FX origin. Use the geometry metrics computed in tee.ts (topY
      // is in geometry-local units of bounding-sphere=0.5). When tilted, the
      // top travels in the negative-X direction (rotation is around z).
      const metrics = getTeeMetrics();
      if (metrics) {
        const localTopY = metrics.topY * meshScale;
        // Apply z-rotation to the local top vector (0, localTopY, 0).
        const ang = -(tiltDeg * Math.PI) / 180;
        const tipDx = -Math.sin(ang) * localTopY;
        const tipDy = Math.cos(ang) * localTopY;
        teeWorldTopY = this.teeMesh.position.y + tipDy;
        // Approx tee top radius as half the bounding-box width's tip portion.
        // (Used as a sanity for the shockwave ring size — small constant fine.)
        teeWorldRadius = meshScale * 0.05;
        // Stash the impact-x for the FX origin.
        // We use the rotated tip's WORLD position; tipDx offsets relative to
        // the tee's center.
        (this as unknown as { _impactX?: number })._impactX =
          this.teeMesh.position.x + tipDx;
        (this as unknown as { _impactZ?: number })._impactZ = this.teeMesh.position.z;
        void teeWorldRadius; // currently unused but kept for future tuning
      }
    }

    // ─── Ball anchor ───────────────────────────────────────────────────────
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

      // ── Ball-on-tee constraint (issue #2b) ──────────────────────────────
      // While we're pre-impact (sectionProgress < PRE), override the ball's
      // Y so it physically rests on the tee's tip — like a rigid body. The
      // CSS authored these positions independently and they drift. We use
      // teeWorldTopY (computed above) plus the ball's actual radius so the
      // ball's BOTTOM equals the tee's TOP.
      if (!inFlight && teeWorldTopY !== null) {
        // Slight downward "settle" so the ball visually sinks into the tip
        // a hair (1 px in world units) — reads as solid contact.
        const settle = worldRadius * 0.05;
        this.ballMesh.position.y = teeWorldTopY + worldRadius - settle;
        // Mirror the ball's X to the tee tip too — they often disagree by a
        // few pixels because the CSS .fly-ball wrapper has its own layout
        // anchor unrelated to the .tee element.
        const impactX = (this as unknown as { _impactX?: number })._impactX;
        if (impactX !== undefined) this.ballMesh.position.x = impactX;
      }

      // Idle spin around Y for visual life. The CSS animation already spins
      // the inner div via background rotation, but that's hidden now — drive
      // a real 3D rotation here. Slow at rest, faster when scale is high
      // (mid-flight).
      const flightHeat = Math.max(0, meshScale - 0.4); // grows when mid-flight
      this.ballMesh.rotation.y += dt * (BALL_IDLE_SPIN + flightHeat * 4);
      this.ballMesh.rotation.x += dt * (BALL_IDLE_SPIN * 0.4 + flightHeat * 1.5);
      this.ballMesh.visible = true;
    }

    // ─── Impact FX trigger + animation (issue #2c) ─────────────────────────
    // Fire shockwave + particle burst the moment we cross from pre-impact
    // into flight. impactArmed latches false after firing so we don't
    // retrigger every frame (it gets re-armed when the section leaves view).
    if (this.impactArmed && inFlight && secProgress < PRE_IMPACT_SP + 0.15) {
      this.impactArmed = false;
      this.impactElapsed = 0;
      // Pin shockwave + particles to the (now-known) impact point in world space.
      const impactX = (this as unknown as { _impactX?: number })._impactX ?? 0;
      const impactZ = (this as unknown as { _impactZ?: number })._impactZ ?? 0;
      const impactY = teeWorldTopY ?? 0;
      if (this.shockwaveMesh) {
        this.shockwaveMesh.position.set(impactX, impactY, impactZ);
        // Shockwave plane should face the camera (XY plane works because the
        // camera looks down -Z). Scale will be driven by the shader's
        // uProgress; we set base mesh scale to the max radius * 2.
        this.shockwaveMesh.scale.setScalar(SHOCKWAVE_MAX_RADIUS * 2);
        this.shockwaveMesh.visible = true;
      }
      if (this.particleMesh) {
        this.particleMesh.position.set(impactX, impactY, impactZ);
        this.particleMesh.visible = true;
      }
    }

    if (this.impactElapsed >= 0) {
      this.impactElapsed += dt;
      const swP = Math.min(1, this.impactElapsed / SHOCKWAVE_DURATION_S);
      const ptP = Math.min(1, this.impactElapsed / PARTICLE_DURATION_S);
      if (this.shockwaveMaterial) {
        this.shockwaveMaterial.uniforms.uProgress.value = swP;
      }
      if (this.particleMaterial) {
        this.particleMaterial.uniforms.uTime.value = this.impactElapsed;
      }
      // Hide once both are done.
      if (swP >= 1) {
        if (this.shockwaveMesh) this.shockwaveMesh.visible = false;
      }
      if (ptP >= 1) {
        if (this.particleMesh) this.particleMesh.visible = false;
      }
      if (swP >= 1 && ptP >= 1) {
        this.impactElapsed = -1;
      }
    }

    // Re-arm if we scroll back BEFORE impact (so the FX play again on next
    // forward scroll past the impact point).
    if (!inFlight && !this.impactArmed) {
      this.impactArmed = true;
      this.impactElapsed = -1;
      if (this.shockwaveMesh) this.shockwaveMesh.visible = false;
      if (this.particleMesh) this.particleMesh.visible = false;
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
    if (this.ballFillMesh) {
      // The fill sphere has its own SphereGeometry (not the shared GLB cache).
      this.ballFillMesh.geometry.dispose();
      this.ballFillMesh = null;
    }
    if (this.ballFillMaterial) {
      this.ballFillMaterial.dispose();
      this.ballFillMaterial = null;
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
    if (this.shockwaveMesh) {
      scene.remove(this.shockwaveMesh);
      this.shockwaveMesh.geometry.dispose();
      this.shockwaveMesh = null;
    }
    if (this.shockwaveMaterial) {
      this.shockwaveMaterial.dispose();
      this.shockwaveMaterial = null;
    }
    if (this.particleMesh) {
      scene.remove(this.particleMesh);
      this.particleMesh.geometry.dispose();
      this.particleMesh = null;
    }
    if (this.particleMaterial) {
      this.particleMaterial.dispose();
      this.particleMaterial = null;
    }
    document.documentElement.classList.remove('flythrough-3d');
  }
}
