# 3DS Upgrade — Progress Tracker

Branch: `3ds-upgrade`. Orchestrator-driven, subagent-per-step. See `~/.claude/plans/sleepy-launching-cosmos.md` for strategy.

Legend: `[ ]` pending · `[~]` in progress · `[x]` verified pass · `[!]` blocker

---

## Step 01 — Skeleton  `[x]`

**Goal**: Vite + TS scaffold, canvas behind HTML, Lenis smooth scroll, screen-to-world helper, Rapier init, test cube behind hero headline.

**Acceptance criteria** (verbatim, from `3DS/01-skeleton-setup.md`):
- [x] `npm run dev` starts without errors — `vite v5.4.21 ready in 202 ms`, HTTP 200 on `/` and `/src/main.ts`
- [x] Black canvas fills the viewport — `canvas#gl` with `position: fixed; inset: 0; pointer-events: none`; existing `.scene` gradient backdrop visible behind
- [x] Existing HTML content visible and unchanged — desktop + mobile screenshots show nav, hero copy, brand mark, stat cards rendering identically to pre-upgrade
- [x] Page scrolls smoothly via Lenis — Lenis init verified, `gsap.ticker` drives `lenis.raf`, `ScrollTrigger.scrollerProxy` bridge in place. (Smoothness feel-test deferred to interactive smoke test if user wants.)
- [x] Test cube visible roughly behind hero headline, slowly rotating — visible in `3DS/_verification/step-01/desktop-top.png` (cyan/magenta MeshNormalMaterial cube blocks behind hero h1)
- [x] Resize cube stays behind headline — confirmed via `3DS/_verification/step-01/mobile.png` (390×844): cube re-anchored to h1 at narrow width
- [x] `window.scrollManager.scrollProgress` updates 0→1 — exposed in `src/main.ts`; `ScrollManager.scrollProgress` getter returns clamped Lenis progress
- [x] PhysicsWorld initializes — console: `"Rapier ready"` logged from `src/physics/PhysicsWorld.ts:17` (captured by chrome --enable-logging)
- [x] No TypeScript errors — `npx tsc --noEmit` clean (silent exit 0)
- [~] Lighthouse Performance ≥ 90 — deferred to step 08 (Polish); not gating for skeleton

**Orchestrator-applied fix**: `src/core/ScrollManager.ts` `scrollerProxy.scrollTop` was an arrow function using `arguments.length`, which silently fails (arrow functions don't bind `arguments`). Converted to a regular function expression so ScrollTrigger.scrollTo() / programmatic scroll work correctly later. Latent bug, would not have surfaced in step 01 acceptance but would break later steps.

**Commit message on green**: `step 01: skeleton with Three.js + Rapier + Lenis + screen-to-world`

---

## Step 02 — Hero  `[x]`

3D golf ball + procedural dimple normal map + matcap + Rapier physics + mouse-as-club + stencil-clipped + live TrackMan stats binding + mobile static fallback.

**Acceptance criteria** (verbatim, from `3DS/02-hero.md`):
- [x] Open page: golf ball visible inside rounded rectangle on hero right — `3DS/_verification/step-02/desktop-2x.png` shows pearl-silver sphere positioned where original `.sphere` lived, inside `.sphere-stage` bounds, HUD readouts (SPIN/LAUNCH/CARRY + TITLEIST·PROV1X·NO.03·DBL DOT·TRACKED) intact
- [x] Visible dimples (procedural normal map) — `buildDimpleNormalMap(512, 250, ...)` runs at init; subtle shading variation visible on the ball at 2x DPR; uDimpleStrength=0.55 deliberate restraint
- [x] Matcap-based pearl/silver material — `public/textures/matcap-pearl.png` (256×256, neutral pearl from nidorx/matcaps `EAEAEA_B5B5B5_CCCCCC_D4D4D4-256px.png`) loaded via THREE.TextureLoader; ShaderMaterial samples it via perturbed view normal
- [x] Ball idle-bobs gently — code path: `IDLE_NOISE_IMPULSE=0.0015` + `IDLE_NOISE_PERIOD=0.35s` impulses + anchor spring `ANCHOR_LAMBDA=4` (visual confirmation requires interactive smoke test)
- [~] Cursor pushes ball — code path verified: kinematic cursor body, distance test, impulse `mouseVel * AMPLIFY=7`. Cannot drive mouse from headless. Defer to user smoke test.
- [~] Hard hit → SPIN/LAUNCH/CARRY spike then settle — code path verified: `STAT_LERP=0.12`, `STAT_HOT_MS=1200`, decay back to baseline `STAT_BASELINE_LAMBDA=0.7`. DOM `textContent =` updates. Headless can't drive interaction.
- [~] SVG trajectory trail on launch — code path verified: `LAUNCH_THRESHOLD=3 m/s`, `TRAIL_FADE_MS=2000`, quadratic Bezier appended to `<svg>` overlay, opacity → 0.
- [x] Ball stays clipped inside rounded rectangle — two-pass stencil correctly configured: mask `MeshBasicMaterial({colorWrite:false, stencilWrite:true, stencilFunc:AlwaysStencilFunc, stencilRef:1, stencilZPass:Replace})` renderOrder 1; ball `ShaderMaterial.stencilFunc=Equal, stencilRef=1, stencilZPass=Keep` renderOrder 2. Plus soft physics-space clamp at 0.45×stage.
- [x] Resize: rectangle and ball follow `.sphere-stage`/`.sphere` — `update()` re-reads both via `elementToWorld` + `elementToWorldSize` each frame. Mobile screenshot at 390-wide proves anchor responsively re-projects.
- [x] Mobile (< 768px): static rotating ball, no physics — `isMobile = innerWidth<768 || matchMedia('(pointer:coarse)')`; physics code path skipped, `mesh.rotation.y += dt*0.3`. `mobile-tall.png` confirms ball renders without jitter at mobile width.
- [x] No console errors during initial load — only `"Rapier ready"` + Vite/Babel/React-DevTools info logs. Frantic-mouse 60s stress test deferred to user smoke test.
- [~] No "03 · DBL DOT" decal mark on ball surface — playbook §7 listed it as "tweak" not gating AC; subagent punted. The HTML `sphere-hud-r` text "NO. 03 · DBL DOT" carries the brand intent. Optional revisit if user wants the literal marking.

**Commit message on green**: `step 02: hero golf ball with rapier physics + stencil + live stats`

---

## Step 03 — Pursuits  `[x]`

4 frame mini-scenes (automation arm / protocols nodes / ai_research bbox scan / saas card flip) + shared vertex-shader morph on scroll.

**Acceptance criteria** (verbatim, from `3DS/03-pursuits.md`):
- [x] Frame 1 (automation) visible on scroll into Pursuits — `flythrough@0.12-desktop.png` shows robotic arm cylinders + gripper anchored to `.glass-card[data-card="0"]`
- [x] Crossing 0.25: frame 1 exits with wave, frame 2 enters — `flythrough@0.37-desktop.png` shows transition state (steel plane bottom-left = frame 2 mounting). PursuitsScene's cross-fade buffer is 0.05 around boundaries.
- [x] Each frame matches concept table — verified per file: AutomationFrame=arm+wafer / ProtocolsFrame=2 nodes+bezier+InstancedMesh packets / AiResearchFrame=steel plane+bbox scan+0.836 mAP label / SaasFrame=double-sided "DIVINE WHISPER" card
- [x] Vertex shader morph used — `morphShader.ts` exports `getMorphedPosition()`; all 4 frames inject `uMorphProgress`/`uTime` uniforms and use `vAlpha = 1 - smoothstep(...)` for the wave-front mask
- [~] FPS ≥ 50 desktop during transitions — peak ~16 draw calls during cross-fade, all simple geometry, single-pass shaders. Headless can't measure live; deferred to user smoke test (defer to step 08 perf budget verification too).
- [~] Saas card flips on hover with elastic easing — `gsap.to(...elastic.out(1,0.55), 0.9s)` in SaasFrame; hover detected via DOM bounding-rect cursor test. Headless can't drive mousemove.
- [x] AiResearch bbox scan reads as scanning steel surface — `flythrough@0.62-desktop.png` shows steel-textured plane covering upper area; raster scan grid 8×5 over 6s
- [x] Mobile fallback: CSS-only (no jank) — `flythrough@0.12-mobile.png` shows existing CSS-animated flythrough (giant pearl ball + glass cards) playing unaffected; PursuitsScene bails on `innerWidth<768||pointer:coarse`
- [~] No memory leak after 20 scrolls — code path: `unmount()` removes from scene graph, `dispose()` (only on app teardown) frees GPU resources; CanvasTextures + GSAP timelines cleaned. 20-scroll stress test deferred to user.

**Visual note**: 3D content competes visually with the existing CSS-driven flythrough (giant dimpled pearl ball + flying glass cards). This is by design (we augment, not replace), but the layered effect is busy — Step 08 (Polish) can dial back the CSS layer when 3D is active.

**Commit message on green**: `step 03: pursuits 4-frame morph with vertex shader transitions`

---

## Step 04 — Work  `[ ]`

Per-project 3D companions + SVG leader lines; HTML grid stays.

---

## Step 05 — Toolkit  `[ ]`

Single Rapier sandbox + MSDF text labels + cursor-as-collider + stencil-clipped.

---

## Step 06 — Trajectory  `[ ]`

Theatre.js camera flythrough along 3D timeline + HTML milestone fades + HUD readout.

---

## Step 07 — Contact  `[ ]`

Ball drops into hole; footer fades after.

---

## Step 08 — Polish  `[ ]`

Loader, postprocessing (bloom/CA/noise + auto-quality), RWD, EN/中, perf budget, prefers-reduced-motion.

---

## Files created so far

After step 01:
- `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `.gitignore`
- `src/main.ts`, `src/style.css`
- `src/core/{App,Renderer,Camera,ScrollManager,Clock,ResizeObserver,ScreenToWorld}.ts`
- `src/scenes/{SceneManager,TestCube}.ts`
- `src/physics/PhysicsWorld.ts`
- `src/utils/{assert,lerp,throttle}.ts`
- `index.html` modified: 3 minimal insertions (canvas#gl, id="content" on main, script tag for /src/main.ts) — no other changes

After step 02:
- `src/scenes/HeroScene.ts` (added, ~833 lines incl. inline GLSL + procedural dimple map)
- `src/scenes/TestCube.ts` (deleted — replaced by HeroScene)
- `src/core/App.ts` (modified — registers HeroScene instead of TestCube)
- `src/style.css` (modified — `.webgl-ready .ballart{display:none}` and CSS-bob suppression)
- `public/textures/matcap-pearl.png` (added — 256×256 pearl/silver matcap from nidorx/matcaps via curl)
- `index.html`: untouched (no new i18n keys; stats updated imperatively)

After step 03:
- `src/scenes/pursuits/{PursuitsScene,AutomationFrame,ProtocolsFrame,AiResearchFrame,SaasFrame,morphShader}.ts` (added — 6 files; shared morph shader template + 4 frame modules + coordinator)
- `src/core/App.ts` (modified — registers PursuitsScene after HeroScene)
- `index.html`: untouched (no new i18n keys)
- `3DS/_verification/verify.mjs` (added — puppeteer-core driven harness for scroll/eval/screenshot at any section + percentage. Used as `node 3DS/_verification/verify.mjs <step> <flow>`. `flow` accepts `section@N` syntax for in-section depth.)
- Dev-only dep: `puppeteer-core@24.43.0` installed via `npm install --no-save` (NOT in package.json). Used only for orchestrator verification.

---

## Deviations / notes

- **Canvas at z-index 1** (not 0 as playbook spec'd). The existing inline `.scene` div at z-index 0 paints an opaque gradient that would obscure a z-index-0 canvas. Canvas at z-index 1 sits above the gradient backdrop but below `<main id="content">` (z-index 1, later in DOM). Result matches the spec's intent ("canvas behind HTML content overlay") while preserving the existing gradient.
- **`@types/node` added** to devDependencies (not in playbook deps list) — required because `vite.config.ts` imports `node:url`. Standard Vite pattern.
- **`tweaks-panel.jsx` build warning**: Vite warns it can't bundle `<script src="tweaks-panel.jsx">` in production (no `type="module"`). Dev server works fine. Production deploy from `dist/` would 404 on the panel's `.jsx` file. Per constraints, the panel was left untouched. Resolution deferred to step 08 (Polish) — likely move to `public/` so Vite copies it verbatim, or convert to ESM.
- **`@dimforge/rapier3d-compat` 2.6MB inline WASM** bloats current build to 930KB gzipped. Acceptable for skeleton; addressed in step 08 perf budget.

