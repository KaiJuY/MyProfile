# 01 — Skeleton Setup

**目標**：建立整站的技術骨架。**不做任何視覺**，只把舞台搭起來。

完成後你會看到：一張黑色的 canvas、HTML 內容浮在上面、可以平滑捲動。看起來像沒做什麼，但所有後續 section 都站在這個基礎上。

---

## 貼給 AI 的 prompt

```
We are now executing file 01: Skeleton Setup. Read the master context I pasted earlier
if you haven't. Goal of this step: build the technical foundation, no visuals yet.

DELIVERABLE: A working Vite project with the architecture described below. After you're
done, the page should show a fullscreen black canvas with the existing HTML content
overlaid on top, scrollable smoothly via Lenis, and a single test cube visible behind
the HTML to prove the canvas is alive.

# 1. PROJECT STRUCTURE

Create / migrate to this structure:

  src/
    main.ts                  # entry point
    style.css                # only resets and HTML overlay positioning
    core/
      App.ts                 # main app class, owns renderer + scroll + scene manager
      Renderer.ts            # WebGL renderer wrapper, handles resize and DPR
      Camera.ts              # main camera, with helper to update projection on resize
      ScrollManager.ts       # wraps Lenis, exposes scroll progress (0..1) globally
      Clock.ts               # central delta-time clock
      ResizeObserver.ts      # window resize broadcaster
      ScreenToWorld.ts       # **KEY** — converts an HTML element's bounding rect
                             # to a world-space Vector3 at a given camera distance
    scenes/
      SceneManager.ts        # registers and routes update() calls to active scenes
      TestCube.ts            # temporary, will be deleted in step 02
    physics/
      PhysicsWorld.ts        # Rapier wrapper, fixed 60Hz timestep
    utils/
      assert.ts
      lerp.ts
      throttle.ts
  index.html                 # the existing HTML stays — we only add a <canvas id="gl">
  vite.config.ts
  tsconfig.json
  package.json

# 2. DEPENDENCIES

Install:
  three @types/three
  @dimforge/rapier3d-compat
  lenis
  gsap
  postprocessing

Dev deps:
  vite typescript

# 3. HTML / CSS RULES

- Add <canvas id="gl"> as the FIRST element inside <body>, fixed position, z-index: 0,
  full viewport, pointer-events: none by default (we'll selectively enable later)
- All existing HTML content gets wrapped in <main id="content"> with z-index: 1 and
  position: relative
- Body background: transparent (so canvas shows through)
- HTML element styling: leave the existing site's typography 100% alone

# 4. KEY ARCHITECTURE: SCREEN-TO-WORLD MAPPING

This is the Lusion technique #1. Implement `ScreenToWorld.ts`:

  // Given an HTMLElement, return a THREE.Vector3 in world space such that
  // a 3D object placed there will visually align with the element's center
  // when projected through the main camera at a fixed Z distance.
  function elementToWorld(
    element: HTMLElement,
    camera: THREE.PerspectiveCamera,
    distance: number  // how far in front of camera, e.g. 5 units
  ): THREE.Vector3

The math: get element's getBoundingClientRect, convert to NDC (-1..1), un-project
through camera to a ray, advance ray by `distance` to get world point.

Also expose:
  function elementToWorldSize(element, camera, distance): { width, height }
  // so we can scale 3D objects to match the element's pixel size

# 5. SCROLL MANAGER

Lenis-based. Expose:
  - scrollProgress: number (0 at top, 1 at bottom)
  - sectionProgress(elementId: string): number (0 when section enters viewport, 1 when leaves)
  - onUpdate(callback): subscribe to scroll updates

Important: Lenis owns scroll. Hook GSAP ScrollTrigger to use Lenis's scrollerProxy
so they don't fight. Reference:
https://github.com/darkroomengineering/lenis#with-gsap-scrolltrigger

# 6. RENDERER

- WebGL2, antialias true, alpha true (so HTML shows through transparent areas)
- Set DPR to Math.min(window.devicePixelRatio, 2) — never go above 2 for perf
- ToneMapping: ACESFilmic
- OutputColorSpace: SRGBColorSpace
- Resize on window resize (debounced 100ms)

# 7. PHYSICS

PhysicsWorld.ts:
- Init Rapier WASM (it's async — handle the loading state)
- Fixed timestep 1/60, accumulator-based step in update loop
- Expose: addRigidBody, addCollider, raycast, step(deltaTime)

Don't add any bodies yet — just verify the world initializes.

# 8. TEST CUBE (temporary)

Place a 1x1x1 BoxGeometry with MeshNormalMaterial at the world position corresponding
to the hero section's headline element. Rotate it slowly. Delete in step 02.

# ACCEPTANCE CRITERIA

Before moving on, ALL must be true:

[ ] `npm run dev` starts without errors
[ ] Black canvas fills the viewport
[ ] Existing HTML content is visible and unchanged in styling
[ ] Page scrolls smoothly (no jitter, no jumps) via Lenis
[ ] Test cube is visible roughly behind the hero headline, slowly rotating
[ ] Resize the window — cube stays roughly behind the headline (responsive)
[ ] Console.log(scrollManager.scrollProgress) updates 0→1 as you scroll
[ ] PhysicsWorld successfully initializes (console: "Rapier ready")
[ ] No TypeScript errors (`npm run build` succeeds)
[ ] Lighthouse Performance score ≥ 90 (still light at this stage)

# REPORTING BACK

After implementing, tell me:
1. What files you created/modified (just the list)
2. Any architectural decisions where you chose between options (briefly explain why)
3. Any place where you couldn't find a clean solution and used a workaround
4. Confirm each acceptance criterion (or say what's failing)
```

---

## 踩雷預警

### Lenis + ScrollTrigger 整合很常出錯
症狀是：捲動了、但 ScrollTrigger 的 onUpdate 沒觸發。原因是兩個都在搶 scroll listener。AI 第一版常常漏設 `ScrollTrigger.scrollerProxy`，看到症狀就直接問 AI：「ScrollTrigger 沒觸發，你有做 scrollerProxy 嗎？」

### Rapier 是 WASM，要 await
`await RAPIER.init()` 沒跑完就 new World，會炸。AI 第一版可能會忘記 await。

### Canvas 蓋不住 HTML 或反過來
正確順序：`<canvas>` z-index 0，`<main>` z-index 1，body 背景 transparent。AI 有時會把 canvas pointer-events 設成 auto，整站變不能點。

### DPR 設 `window.devicePixelRatio` 沒上限
高解析度螢幕（Mac Retina、4K 螢幕）會讓 DPR = 2 或 3，render 量直接 4 倍 9 倍。一定要 `Math.min(devicePixelRatio, 2)`。

---

## 驗收完成後

```bash
git add -A
git commit -m "step 01: skeleton with Three.js + Rapier + Lenis + screen-to-world"
```

下一個檔案：[`02-hero.md`](./02-hero.md)
