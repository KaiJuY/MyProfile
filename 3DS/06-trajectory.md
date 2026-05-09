# 06 — Trajectory: 相機沿 Timeline 飛行

**目標**：Trajectory 區的職涯時間軸（2025.11 → 2010.09）變成一條 3D 空間中的軌跡線，相機沿著它前進。每個雇主/里程碑是空間中的一個標記點，相機經過時對應 HTML 文字 fade in。背景是工程圖紙風的 grid floor。

整段帶一個工程儀表 HUD：座標、深度、進度條。

---

## 概念定調

不是「飛炫的 3D 時間軸」，是「**捲動 = 沿職涯軌跡前進**」的隱喻。每個職涯階段是一個 milestone marker（簡單幾何，例如一個發光的圓環），camera 通過它的瞬間 HTML 描述文字 fade in 在右側。

灰白配色，工業圖紙感，不要花俏。

---

## 貼給 AI 的 prompt

```
We are now executing file 06: Trajectory Section. Steps 01-05 are done.
Goal: Convert the Trajectory section's vertical timeline into a 3D spatial path.
Camera flies along this path as the user scrolls through the section. Each career
milestone is a marker in 3D space; HTML text for that milestone fades in when the
camera passes its corresponding scroll progress.

# 1. STRUCTURE

Create:
  src/scenes/trajectory/
    TrajectoryScene.ts        # owns the path, camera animation, markers, HUD
    PathBuilder.ts             # generates the bezier path through 3D space
    Marker.ts                  # one career milestone visualization
    GridFloor.ts               # technical-drawing-style ground plane
    HUD.ts                     # screen-space readout (POS, DEPTH, step counter)

# 2. PATH GENERATION

The camera follows a smooth 3D path. Generate it using a CatmullRomCurve3 with
control points placed for each career milestone:

  Milestones (from existing site, in order from earliest to latest):
    1. 2010.09 — TEL Process Engineer (start)
    2. 2018.02 — JCC Software (mid)
    3. 2021.06 — JCC Senior R&D
    4. 2025.11 — SunSun Technology (current)
    5. 2026 — "now" (end of path)
    + an Education branch around 2018-2020 (NYCU master's)

  Path positions (rough):
    Milestone 1: (0, 0, 0)
    Milestone 2: (3, 1, -8)
    Milestone 3: (6, 2, -16)
    Milestone 4: (9, 3, -24)
    "now":       (12, 4, -32)

  Path slopes upward and forward — visual metaphor for "career trajectory ascending".

The camera looks slightly forward along the path tangent, with smooth lookAhead
(target = position 2 seconds ahead on the path).

# 3. SCROLL → CAMERA POSITION

Use the existing scroll progress for the trajectory section:
  - Section scroll progress 0..1 → curve.getPoint(t).
  - Camera position = path point
  - Camera look-at = path point at t + 0.05 (slightly ahead)

Use Theatre.js if you want a designer-friendly editor, but for this section a direct
math implementation is simpler. Theatre.js is overkill here. Skip it.

# 4. MARKERS

Each milestone is a Marker:
  - A flat ring (TorusGeometry, thin) at the path point, oriented perpendicular to
    the path tangent (so camera "passes through" it like a checkpoint)
  - A small sphere at the ring's center
  - A short tick line extending upward from the marker (like an architect's annotation)
  - Slight emissive glow when camera is within ~3 units (use distance-to-camera
    uniform in shader)

When the camera passes a marker, an event fires that triggers the corresponding
HTML text block to fade in.

# 5. HTML TEXT BINDING

The existing HTML for Trajectory has blocks like:

  <div data-milestone="2025.11">
    <h3>Software R&D Assistant Manager</h3>
    <p>SunSun Technology · Hsinchu, Taiwan</p>
    ...
  </div>

For each block:
  - Initially: opacity 0
  - When camera enters a "reveal zone" around its milestone (path t within ±0.05
    of the marker's t): tween opacity 0 → 1 with subtle Y translate (entering from
    below)
  - When camera exits the zone (going backward in scroll): reverse the tween

Position the HTML block to the right side of the viewport, fixed-position-style,
so it stays in roughly the same screen location as the camera moves through 3D.

# 6. GRID FLOOR

A subtle ground plane that gives the camera a sense of motion:
  - GridHelper or a custom shader-based grid (the latter scales nicer)
  - Color: very light gray on dark, or vice versa depending on bg
  - Major lines every 1 unit, minor every 0.2 unit
  - Fade out toward the horizon (distance fog applied to grid only)
  - Doesn't move — camera moves over it

# 7. HUD READOUT

Top-right or bottom-right corner overlay (HTML, not WebGL — easier to style):

  POS · 2021.06
  DEPTH · 142m
  STEP · 3 / 5
  ▔▔▔▔▔▔ (progress bar)

Where:
  - POS is interpolated from milestone dates based on path t
  - DEPTH is path point's |Z| value displayed in meters (for fun, not real)
  - STEP is current milestone index / total milestones
  - Progress bar is the section scroll progress

Style this in monospace, matching the existing site's "FILE — 06.05.2026" header
typography. This HUD is identity, not Lusion-imitation.

# 8. ENTRY / EXIT TRANSITIONS

When user scrolls INTO the Trajectory section from above:
  - Previous section's content fades out
  - Camera "drops in" — starts above the path, descends to the start point over
    ~600ms while user begins scrolling

When user scrolls OUT (continues to Contact):
  - Camera continues on path past the last milestone, fading out
  - Smooth handoff to next section's scene

# 9. PERFORMANCE

- This section is mostly static geometry. Should be very cheap.
- Markers: 5 of them, ~3 draw calls each = 15 calls. Trivial.
- Grid floor: 1 large mesh with shader. 1 call.
- Total: < 25 draw calls.
- Mobile: full version is OK (this section is light), just disable the slight
  emissive glow on markers to save the shader cost.

# ACCEPTANCE CRITERIA

[ ] Scroll into Trajectory: camera drops to start of path
[ ] Continued scroll moves camera along the path
[ ] Camera passes through ring markers like checkpoints
[ ] Each milestone's HTML text fades in at the right moment
[ ] HUD displays POS / DEPTH / STEP / progress bar correctly
[ ] HUD typography matches site identity (monospace, file-header style)
[ ] Grid floor visible and gives sense of motion
[ ] Reverse scroll: camera goes back, text fades out, HUD updates
[ ] No FPS drops, this section should be the smoothest in the site
[ ] Camera path looks like a believable "trajectory" — not zigzag, not boring straight

# REPORTING BACK

Tell me:
1. The actual control points you used for the path (so I can tune the feel)
2. How you implemented the grid floor (shader or GridHelper?) and why
3. Whether the HUD readout is HTML overlay or rendered into canvas
```

---

## 踩雷預警

### Camera lookAt 抖動
直接用 `camera.lookAt(nextPoint)` 在路徑彎曲處會跳一下。解法：lerp 當前的 lookAt target 朝 nextPoint 移動，不要瞬間切換。

### Marker 看起來都一樣，沒記憶點
五個 marker 如果完全相同就沒層次。可以給「current」狀態（camera 正在通過的那個）加大、加亮、加 ring scale 動畫。AI 第一版常常忘記做。

### HTML text fade timing 跟 camera 不同步
camera 移動是 GSAP timeline，HTML fade 是另一個系統，兩個用同一個 scroll progress 驅動。如果不同步是因為 AI 用了不同的 progress source。要明確要求：「HTML fade 直接讀 path t，不要自己另外算」。

### Grid floor 太花
工程圖紙感是「淡」，不是「密」。grid 線太密會變黑色螢幕。間距、透明度、距離 fog 都要調。

### 「DEPTH 142m」意義不明
HUD 上的 DEPTH 純粹是視覺裝飾。但要看起來合理——隨 camera 移動單調遞增。如果 AI 寫的會跳來跳去，提醒它要平滑單調。

---

## 驗收完成後

```bash
git add -A
git commit -m "step 06: trajectory camera path + markers + HUD"
```

下一個檔案：[`07-contact.md`](./07-contact.md)
