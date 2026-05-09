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

## Step 02 — Hero  `[ ]`

3D golf ball + procedural dimple normal map + matcap + Rapier physics + mouse-as-club + stencil-clipped + live TrackMan stats binding + mobile static fallback.

**Acceptance criteria** (from `3DS/02-hero.md`): see playbook. Tracked at dispatch time.

---

## Step 03 — Pursuits  `[ ]`

4 frame mini-scenes (automation arm / protocols nodes / ai_research bbox scan / saas card flip) + shared vertex-shader morph on scroll.

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

---

## Deviations / notes

- **Canvas at z-index 1** (not 0 as playbook spec'd). The existing inline `.scene` div at z-index 0 paints an opaque gradient that would obscure a z-index-0 canvas. Canvas at z-index 1 sits above the gradient backdrop but below `<main id="content">` (z-index 1, later in DOM). Result matches the spec's intent ("canvas behind HTML content overlay") while preserving the existing gradient.
- **`@types/node` added** to devDependencies (not in playbook deps list) — required because `vite.config.ts` imports `node:url`. Standard Vite pattern.
- **`tweaks-panel.jsx` build warning**: Vite warns it can't bundle `<script src="tweaks-panel.jsx">` in production (no `type="module"`). Dev server works fine. Production deploy from `dist/` would 404 on the panel's `.jsx` file. Per constraints, the panel was left untouched. Resolution deferred to step 08 (Polish) — likely move to `public/` so Vite copies it verbatim, or convert to ESM.
- **`@dimforge/rapier3d-compat` 2.6MB inline WASM** bloats current build to 930KB gzipped. Acceptable for skeleton; addressed in step 08 perf budget.

