# 02 — Hero: 3D Golf Ball + Physics + TrackMan Stats

**目標**：把 hero 區的 `ball.svg` 換成真的 3D 高爾夫球，可被滑鼠擊打，TrackMan 數據（SPIN / LAUNCH / CARRY）即時更新。

這是整站最重要的一個 section — 第一印象就在這。值得花 3–5 天慢慢打磨。

---

## 你需要先準備的素材（AI 沒辦法生）

1. **高爾夫球 .glb 模型**（有 dimples 的 normal map）
   - 來源 A：Sketchfab 搜「golf ball」，找 CC 授權的下載 .glb
   - 來源 B：Blender 自己做（一顆 sphere + dimple normal map 即可，30 分鐘可成）
   - 來源 C：直接用 `THREE.SphereGeometry` + 程式化生成 normal map（最簡單，AI 可以做）
   - **建議路徑 C**：跟 AI 說「用 SphereGeometry + procedural dimple normal map，不要載外部模型」
   
2. **Matcap 紋理**（讓球有 Lusion 那種半透/玉感）
   - 從 https://github.com/nidorx/matcaps 下載，找一顆「白色 + 微藍冷光」的
   - 放到 `public/textures/matcap-pearl.png`

---

## 貼給 AI 的 prompt

```
We are now executing file 02: Hero Section. Skeleton from step 01 is in place.
Goal: Replace the static ball.svg in the hero with an interactive 3D golf ball
with physics, mouse interaction, live-updating TrackMan stats, and a stencil-clipped
viewing window.

# 1. DELETE THE TEST CUBE

Remove TestCube.ts and its references.

# 2. CREATE THE HERO SCENE

File: src/scenes/HeroScene.ts

This scene owns:
- One golf ball mesh (SphereGeometry, radius 0.5, 64 segments)
- Procedural dimple normal map (generated once at init, NOT loaded from file)
- Custom shader material based on ShaderMaterial that combines:
    * matcap texture (load from /public/textures/matcap-pearl.png)
    * the procedural dimple normal map
    * a slight rim light fresnel term
- One Rapier rigid body (dynamic, mass 0.5, restitution 0.6, linearDamping 0.4)
- One mouse-cursor collider (kinematic, radius 0.3, follows mouse smoothly with damp)

# 3. PROCEDURAL DIMPLE NORMAL MAP

Generate a 512x512 normal map at runtime:
- Place ~250 dimples in approximate hexagonal packing on a uv sphere mapping
- Each dimple is a small inverted bump (negative depression) — Z component points
  inward at the dimple center
- Use a CanvasTexture or DataTexture, generated in JS once on init
- This MUST be procedural (no external file) so we don't depend on assets we don't have

# 4. PHYSICS BEHAVIOR

Idle state:
- Ball floats in place at world position derived from the hero's right-side stat card element
- Apply tiny periodic noise impulse so it bobs like sitting on a tee in light wind
- Anchor force pulls it back to home position when no input

Mouse interaction:
- The kinematic collider follows mouse position (with screen-to-world conversion)
- When collider touches ball, ball gets impulse in the direction (mouse_velocity * AMPLIFY)
- AMPLIFY constant: tune to ~5–10× raw velocity. Small mouse movement should feel like a hit.
- After 800ms of no contact, anchor pulls ball back to home with critical damping

Launch detection:
- When ball velocity > threshold (e.g. 3 units/sec) in single frame, classify as "launched"
- During launch, draw a thin SVG trajectory trail (parabolic arc) from launch point to apex
- Fade out trail over 2 seconds
- Trail is SVG, NOT WebGL — render as overlay <svg> positioned absolutely

# 5. STENCIL-CLIPPED VIEWING WINDOW

The ball must visually appear inside a rounded-rectangle "window" that matches the
right-side stat card element. Outside that rectangle the ball should be invisible
(clipped).

Use stencil buffer:
1. First render pass: render an invisible rounded-rect mesh at the position/size of
   the stat card element, writing 1 to stencil buffer
2. Second pass: render the ball with stencilFunc = EQUAL and stencilRef = 1, so it
   only shows where stencil is 1
3. The rounded-rect mesh tracks the HTML element's position every frame (it's a 3D
   plane positioned via screen-to-world)

If stencil is too complex on first try, fall back to clipping planes
(material.clippingPlanes) — but stencil is correct for rounded corners.

# 6. STATS BINDING

The HTML stats (SPIN 2,840 rpm / LAUNCH 11.2° / CARRY 262 yds) must update from
physics state.

Mapping:
- SPIN: derive from ball.angularVelocity.length() * 200 (rough mapping to RPM)
- LAUNCH: derive from launch impulse vector's angle from horizontal (deg)
- CARRY: derive from launch velocity squared * coefficient (yds)

Update the DOM text content every frame using requestAnimationFrame, with a small
smoothing (lerp the displayed value toward target by 0.1 per frame) so numbers
don't jitter unreadably.

When idle (no recent hit), values lerp BACK toward the resting baseline values
shown in the original site (2840 / 11.2 / 262) over ~3 seconds.

# 7. IDENTITY-PRESERVING TWEAKS

- The "TITLEIST · PROV1X / NO. 03 · DBL DOT / ———— TRACKED" text stays in HTML, untouched
- The ball should have a subtle "03" + double dot mark on its surface (use a decal
  or a separate small textured plane attached to the ball)
- Color palette: keep monochrome — no rainbow particles, no neon. Lusion-style
  restraint applied to your aesthetic.

# 8. PERFORMANCE GUARDS

- Cap physics step at 60Hz regardless of render fps
- Skip physics on tabs that lost focus (visibilitychange listener)
- On mobile: detect via screen width < 768px and DISABLE physics, show a static 3D
  ball that just slowly rotates

# ACCEPTANCE CRITERIA

[ ] Open page: golf ball visible inside a rounded rectangle on the right of hero
[ ] Ball has visible dimples (procedural normal map working)
[ ] Ball has matcap-based pearl/jade material (translucent feel, not flat plastic)
[ ] Ball idle-bobs gently
[ ] Move cursor over the ball: ball gets pushed/hit, with visible impulse
[ ] After hitting hard, SPIN/LAUNCH/CARRY numbers spike then settle back toward 2840/11.2/262
[ ] SVG trajectory trail appears briefly when ball is launched, then fades
[ ] Ball stays clipped inside the rounded rectangle (no overflow even when hit hard)
[ ] Resize window: rectangle and ball follow the HTML stat card position
[ ] On mobile (< 768px): ball is static, just rotating, no physics, no jank
[ ] No console errors during 60 seconds of frantic mouse movement
[ ] Lighthouse Performance ≥ 80 (some drop expected with WebGL+physics)

# REPORTING BACK

Tell me:
1. The shader code for the ball material (I want to read it)
2. The constants you tuned (AMPLIFY, damping, mass, etc.) and what each controls
3. Anything you faked because the "right" approach was too expensive
```

---

## 踩雷預警

### Stencil buffer 在 Three.js 不直觀
Three.js 預設不開 stencil。Renderer 要 `new WebGLRenderer({ stencil: true })`。Material 要設 `stencilWrite`, `stencilFunc`, `stencilRef`, `stencilZPass`。AI 第一版 90% 會漏設一兩個 flag，畫面就壞掉。如果遇到問題，叫它把所有 stencil 相關設定列出來檢查。

### 物理 + 螢幕座標的耦合很容易亂
球的 home position 是 HTML 算出來的，HTML resize 時要更新。AI 可能會把 home position 寫成常數，window resize 後球就跑掉了。驗收第 9 條（resize）就是抓這個。

### Mouse velocity 抖動嚴重
原始 mousemove 給的 velocity 抖到不能用。要做 EMA（指數移動平均）或低通濾波。AI 第一版常常直接用 `event.movementX/Y`，球會抖瘋。

### Numbers update 太頻繁讓 DOM 卡頓
60fps 改 textContent 是可以的，但 AI 有時會 setState（如果意外用了 React），那就災難。確認用純 DOM `textContent =`，不是 React。

### iPhone Safari 的 WebGL stencil 行為跟桌面不同
測試一定要在實機（不是 Chrome DevTools 模擬）。如果 Safari 上 stencil 全壞，問 AI：「Safari iOS 的 stencil 行為，需要 `preserveDrawingBuffer` 或其他 renderer flag 嗎？」

---

## 驗收完成後

```bash
git add -A
git commit -m "step 02: hero golf ball with rapier physics + stencil + live stats"
```

這段做完通常會花你 3–5 天，**值得**。後面的 section 都是這段技術的變形應用。

下一個檔案：[`03-pursuits.md`](./03-pursuits.md)
