# 03 — Pursuits: 4 Frames + Vertex Shader Morph

**目標**：Pursuits 區的四張小卡（automation / protocols / ai_research / saas）變成四個獨立 3D 章節場景，捲到該 frame 時觸發對應的視覺。

每個 frame 一個簡單但有記憶點的 3D 物件，用 vertex shader 純數學動畫驅動 morph。

---

## 概念對應表

| Frame | Tag | 3D 物件 | 動畫概念 |
|---|---|---|---|
| 01 | automation | 機械臂（簡化幾何） | 拾取放下抽象晶圓的迴圈 |
| 02 | protocols | 兩顆發光節點 | 節點之間有 packet 沿曲線流動 |
| 03 | ai_research | 矩形鋼板 + bounding box | bbox scan 過鋼板，標記出「defect」 |
| 04 | saas | 翻面卡片 | 從卡背 morph 到正面（籤詩感） |

不要讓 AI 自己想像 — 直接給它這張表。

---

## 貼給 AI 的 prompt

```
We are now executing file 03: Pursuits Section. Steps 01-02 are done.
Goal: Convert the 4-frame Pursuits section into 4 small 3D chapter scenes that
swap based on which frame is currently visible (the existing FRAME 01 / 04 indicator
in the HTML).

# 1. STRUCTURE

Create:
  src/scenes/pursuits/
    PursuitsScene.ts          # owns all 4 sub-scenes, manages active state
    AutomationFrame.ts        # frame 1
    ProtocolsFrame.ts         # frame 2
    AiResearchFrame.ts        # frame 3
    SaasFrame.ts              # frame 4
    morphShader.ts            # shared vertex shader pattern for transitions

Each sub-frame exposes:
  - mount(): adds objects to scene
  - unmount(): removes them
  - update(deltaTime, frameProgress): frameProgress is 0..1 within the frame
  - setMorphProgress(t: number): 0 = entering, 1 = fully visible, used for transition

# 2. FRAME CONTENT (no fancy modeling — keep it geometric and abstract)

## AutomationFrame
- A simplified "robotic arm" made of 3 stacked CylinderGeometry segments + a small
  gripper at the tip (a thin BoxGeometry)
- Below the arm: a flat translucent disc representing a wafer (CircleGeometry,
  glass-like material with low alpha + slight refraction tint)
- Loop: arm reaches down, gripper closes, wafer follows arm up, arm swings, wafer
  drops onto another spot, loop. ~6 second cycle. Use GSAP timeline.

## ProtocolsFrame
- Two small icospheres at left/right of the frame, each glowing (emissive material)
- A bezier curve connects them
- Particles travel along the curve, left-to-right, at ~2 per second
- Particles are small additive-blended sprites
- Implement as GPU instanced sprites for performance (don't add 100 separate meshes)

## AiResearchFrame
- A flat plane textured to look like industrial steel surface
  (you can use procedural noise shader for the texture — no external image)
- A wireframe BoundingBox that animates: starts small, scans across the plane in a
  raster pattern (left-right, top-bottom rows)
- Occasionally bbox finds a "defect": stops, pulses, draws a label "0.836 mAP"
  (use Three.js Sprite or HTML overlay for the label — your call, pick whichever
  performs better)
- Reference: this is DCSA-YOLO from his thesis (steel surface defect detection)

## SaasFrame
- A flat card mesh, double-sided
- Front face: simple typography rendered to canvas (use CanvasTexture):
    "DIVINE WHISPER" + a fortune-stick number
- Back face: just a dark color with a subtle pattern
- Idle animation: gentle Y-axis rotation
- On hover (mouse near it): card flips to show front; on un-hover: flips back to
  back. Use GSAP rotation tween, with elastic easing.

# 3. SHARED MORPH SHADER (the Lusion technique #3)

When a frame becomes active (its corresponding HTML card scrolls into view),
play a vertex-shader-driven entrance animation:

  uniform float uMorphProgress;  // 0 = invisible, 1 = fully visible
  uniform float uTime;

  // Vertex shader pattern:
  // - Use the mesh's UV (or position) to define a "wave front" that sweeps across
  //   the geometry as uMorphProgress advances
  // - In front of the wave: vertex offset toward camera + scaled down + alpha 0
  // - Behind the wave: vertex at rest position + alpha 1
  // - At the wave: small displacement noise for "shattering" feel
  
  // Concretely:
  //   float waveY = mix(-2.0, 2.0, uMorphProgress);
  //   float distance = position.y - waveY;
  //   float mask = smoothstep(0.0, 0.3, distance);  // 0 ahead of wave, 1 behind
  //   vec3 displaced = position + normal * (1.0 - mask) * 0.5;
  //   vAlpha = mask;

This shader pattern is reused across all 4 frames (small variations OK, but the
core pattern is shared in morphShader.ts).

# 4. SCROLL ROUTING

Hook into the existing FRAME 01 / 04 navigation (the small dot indicators at the
side of the section). When a dot becomes "active":
  - Previously active frame: tween its uMorphProgress 1 → 0 (exits in opposite
    direction of incoming wave)
  - Newly active frame: tween its uMorphProgress 0 → 1 (entrance wave)
  - Both run concurrently for smooth crossfade-with-direction feel

Use the section's scroll progress to determine which frame is active:
  - 0.00 - 0.25: frame 1
  - 0.25 - 0.50: frame 2
  - 0.50 - 0.75: frame 3
  - 0.75 - 1.00: frame 4

# 5. POSITIONING

Each frame's 3D scene is rendered into a "viewport" that aligns with the HTML
card's right side (or above the card on mobile). Use the same screen-to-world
helper from step 01.

# 6. PERFORMANCE

- Only one frame's mesh is "active" at a time (mounted in the THREE.Scene).
  Inactive frames are unmounted. This avoids paying for all 4 every frame.
- During transitions, both old and new are temporarily mounted.
- Mobile (< 768px): show a static screenshot/poster for each frame, no 3D animation,
  no morph. Just a fade-in on scroll.

# ACCEPTANCE CRITERIA

[ ] Scroll into Pursuits section: frame 1 (automation) shows the arm doing its loop
[ ] Scroll progress crosses 0.25: frame 1 exits with wave, frame 2 enters
[ ] Each frame has the right "concept content" matching the table above
[ ] Vertex shader morph is visibly used (you can see the wave sweep on entry)
[ ] FPS stays ≥ 50 on desktop during transitions
[ ] Saas card flips on hover with elastic easing
[ ] AiResearch bbox scan animation reads as "scanning a steel surface"
[ ] Mobile fallback: static posters fade in, no jank
[ ] No memory leak after scrolling back and forth 20 times
   (check Chrome DevTools Memory tab — heap should not climb)

# REPORTING BACK

Tell me:
1. The morphShader.ts content (full vertex + fragment, with comments)
2. How you handled the bezier curve particles in ProtocolsFrame (instancing approach)
3. Frame rate when you scroll fast through the whole Pursuits section
4. Any frame whose visual you're not confident about (so I know where to push back)
```

---

## 踩雷預警

### Wave morph 看起來像「閃一下」而不是「掃過去」
這是 timing 問題。AI 預設 transition 太快（300ms），看不到 wave。叫它調到 800ms–1200ms。

### Particles 用 100 個 Mesh 而不是 instancing
Bezier 上的粒子如果用 100 個獨立 Mesh，draw call 爆炸。一定要用 `InstancedMesh` 或 GPU particle system（自己寫 shader 用 vertex displacement）。AI 知道，但要明確要求。

### CanvasTexture 字會糊
SaasFrame 的卡片字如果用 CanvasTexture 直接畫，距離一遠就糊。解決辦法：用 MSDF font（msdf-bmfont-xml 預生成 atlas，three-mesh-ui 或 troika-three-text 套件）。AI 不一定會主動上 MSDF，要點名要求。

### Frame 邊界的「卡卡」
0.25/0.50/0.75 這種 hard threshold 切換很跳。可以給 100ms 的 cross-fade buffer：在 0.20–0.30 之間兩個 frame 都半透。

### 字標籤「0.836 mAP」位置漂移
3D Sprite 在 perspective camera 下會有 depth issue。如果跟著 bbox 移動沒對齊，改用 HTML overlay（absolute position，每幀計算 3D-to-screen 投影）。

---

## 驗收完成後

```bash
git add -A
git commit -m "step 03: pursuits 4-frame morph with vertex shader transitions"
```

下一個檔案：[`04-work.md`](./04-work.md)
