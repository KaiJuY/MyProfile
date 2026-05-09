# 04 — Work: 每個專案的 mini 3D 伴隨物件

**目標**：Work 區的 10+ 個專案卡片，每張右側帶一個小 3D 物件，scroll 進入視野時觸發進場動畫。物件跟 HTML 卡片之間用一條極細虛線（leader line）連起來，呼應你的工業設備技術手冊風格。

---

## 各專案對應的 3D 物件（直接給 AI，不要讓它自己想）

| 專案 | 3D 伴隨物件 | 動畫 |
|---|---|---|
| PRJ_01 EFEM Automation | 旋轉中的精密齒輪（兩個咬合）| 持續轉動 |
| PRJ_02 SECS Simulator | 兩個發光終端機節點 + 訊號線 | 訊號脈衝來回 |
| PRJ_03 DCSA-YOLO | 3D 柱狀圖（已存在 PNG 升級成 3D） | 柱子從 0 升起到目標高度 |
| PRJ_04 PLCSimulation | 一個 JSON 形狀的 brace 結構 morph 成程式碼方塊 | 形狀漸變 |
| PRJ_05 Material Manager | 倉儲格 / box stack 的 isometric 視角 | 箱子逐個堆上去 |
| PRJ_06 Divine Whisper | 一張籤詩卡 + 浮動光點 | 卡片旋轉 + 光點環繞 |
| PRJ_07 SN Version | 一條 3D SPC 曲線 + 上下界面 | 曲線繪製 + 點上去 |

剩下的專案如果有就比照這個邏輯給。

---

## 貼給 AI 的 prompt

```
We are now executing file 04: Work Section. Steps 01-03 are done.
Goal: Add a small 3D companion object to each project card in the Work section
("Systems that ship and stay shipped."). The HTML grid stays unchanged. The 3D
objects are positioned to the right of each card (or above on mobile), connected
to the card by a thin SVG leader line.

# 1. STRUCTURE

Create:
  src/scenes/work/
    WorkScene.ts              # owns all project companion objects
    LeaderLine.ts             # SVG-based connector between HTML element and 3D object
    objects/
      EfemGear.ts              # PRJ_01: meshing gears
      SecsSimulator.ts         # PRJ_02: signal nodes
      DcsaYolo.ts              # PRJ_03: 3D bar chart
      PlcSimulation.ts         # PRJ_04: JSON-to-code morph
      MaterialManager.ts       # PRJ_05: stacking boxes
      DivineWhisper.ts         # PRJ_06: tarot card with light particles
      SnVersion.ts             # PRJ_07: SPC curve

Each object exposes:
  - mount() / unmount()
  - update(dt, scrollProgress) — scrollProgress here is 0..1 within the card's
    on-screen visible window
  - getLeaderAnchor(): THREE.Vector3 — where the leader line attaches on the 3D side

# 2. OBJECT IMPLEMENTATIONS

Each object is small (~1–1.5 unit world size), monochrome (use a cool gray + one
accent color — pick something from the existing site, or stick to off-white).

## EfemGear (PRJ_01)
- Two CylinderGeometry "gears" with notched edges (use shader to add notches via
  fragment alpha, or use ExtrudeGeometry with a star-shaped path)
- Rotate continuously, opposite directions, kinematically locked (one drives the other)

## SecsSimulator (PRJ_02)
- Two boxes at left/right (the "nodes")
- A thin line between them (line geometry)
- Pulse: a small bright sphere travels along the line back and forth
- When pulse reaches a node, that node briefly glows brighter

## DcsaYolo (PRJ_03)
- 5 vertical bars, BoxGeometry stretched on Y axis
- Heights animate from 0 to: 0.800, 0.836, 0.78, 0.81, 0.79 (5 different model
  benchmarks, with 0.836 being highest = your DCSA result)
- The 0.836 bar uses an accent color (others gray)
- Animation: sequential rise as scroll progresses through the card

## PlcSimulation (PRJ_04)
- Start state: a 3D representation of curly braces { }
- End state: a small box (representing a compiled module)
- Vertex shader morph (reuse pattern from step 03) drives the transition based on
  scrollProgress

## MaterialManager (PRJ_05)
- 5 small boxes stack on each other as scrollProgress goes 0 → 1
- Isometric-ish viewing angle (camera looks down at slight tilt)
- Each box has a slight rotation when it lands (not perfectly aligned — feels real)

## DivineWhisper (PRJ_06)
- A flat card mesh, slowly rotating on Y
- 8–12 small additive-blended sprites orbiting around it (like fireflies)
- Card front has a single character drawn via CanvasTexture: 籤 or a number
- Glow with bloom postprocess (already enabled in step 08)

## SnVersion (PRJ_07)
- A 3D line geometry following a smooth wave (sine + noise)
- 20 small spheres at line points, glowing
- "Tolerance band" — two horizontal planes above and below the line, semi-transparent
- Line "draws in" as scrollProgress goes 0 → 1, points appear sequentially

# 3. POSITIONING

Each project card in the existing HTML has roughly this structure:
  <div class="project-card" id="prj-01">
    <span>PRJ_01 FEATURED</span>
    <h3>EFEM Automation Framework</h3>
    <p>...</p>
    <div class="tags">...</div>
  </div>

Use the screen-to-world helper to position the 3D object at:
  - Desktop: centered vertically with the card, offset to the right by 60% of card width
  - Mobile (< 768px): hidden entirely, no 3D for project cards on mobile
    (they're not the hero — not worth the perf cost)

# 4. LEADER LINE

LeaderLine.ts renders an SVG <path> that connects:
  - HTML anchor: right edge of the project card
  - 3D anchor: the object's getLeaderAnchor() projected to screen space

Style:
  - 1px stroke, dashed (e.g. stroke-dasharray: 2,4)
  - Color: same gray as project card meta text
  - Slight curve (use bezier control points), not straight
  - Animates in (stroke-dashoffset from full length to 0) when card enters viewport

This is a visible, deliberate "industrial schematic" detail. Do not skip it — it's
what gives this section its identity.

# 5. SCROLL TRIGGER

Use GSAP ScrollTrigger (Lenis-integrated from step 01) to:
  - Mount object when card is 100vh away from entering viewport (preload)
  - Trigger update(scrollProgress) for that object's specific timeline
  - Unmount when card is 200vh past viewport (cleanup)

Only objects within ±200vh of viewport are mounted. We never have all 7+ objects
in the scene at once.

# 6. PERFORMANCE

- Each object should use < 5 draw calls (use mergeGeometries where possible)
- Total active draw calls in this section: aim for < 50 even with 2 cards in view
- Use simpler materials for these objects (MeshBasicMaterial or MeshLambertMaterial),
  reserve MeshPhysicalMaterial for hero only
- All these objects share ONE light setup (one ambient + one directional) — no
  per-object lights

# ACCEPTANCE CRITERIA

[ ] Scroll into Work section: each card has a 3D object visible to its right
[ ] Each object matches the spec table (gears for EFEM, bars for YOLO, etc.)
[ ] Leader line connects HTML card to 3D object, with dashed style
[ ] Leader line animates in (draws itself) when card enters viewport
[ ] Object's animation progresses with scroll (not on a wall-clock timer)
[ ] Mobile: no 3D, just the existing HTML cards (verify no console errors)
[ ] Scrolling fast through all projects: 60fps maintained on desktop
[ ] After scrolling past, scrolling back up: animations replay correctly

# REPORTING BACK

Tell me:
1. Which 3 of the 7 objects look the weakest visually (so I can push back)
2. Total draw call count when 2 cards are in view (use renderer.info.render.calls)
3. Whether the leader line animation looks right or stiff
```

---

## 踩雷預警

### Leader line 抖動
HTML 元素的 bounding rect 在每幀 scroll 中會跳動（因為 Lenis 的 transform）。用 `requestAnimationFrame` 同步而不是 scroll event 直接綁。AI 第一版常常綁 scroll event，線會抖。

### 太多物件同時 mount 導致 GPU 累
如果 scroll 太快，preload window（±200vh）內的物件全部被 mount，可能 5+ 個物件同時跑。要在 unmount 時真的 dispose geometry/material/texture，否則記憶體不釋放。

### 物件大小不一致
AI 給的物件常常一個是 0.5 單位、一個是 3 單位，視覺上看起來忽大忽小。明確要求：「所有 work 區物件 bounding box 不超過 1.5 unit」。

### Mobile 沒處理
AI 預設會所有設備都跑 3D，手機掉到 15fps。strict 要求：mobile 直接不渲染 work 區的 3D。

---

## 驗收完成後

```bash
git add -A
git commit -m "step 04: work section mini scenes with leader lines"
```

下一個檔案：[`05-toolkit.md`](./05-toolkit.md)
