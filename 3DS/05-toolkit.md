# 05 — Toolkit: 物理沙盒 + 漂浮技能物件

**目標**：Toolkit 區（"Tools of the obsession."）變成一個 Rapier.js 物理沙盒。每個技能（Python / C# / C/C++ / AI ML / Embedded / Comm Protocols / Database / DevOps）是一個 3D 物件，上面有 MSDF 文字 label。物件互相吸引但被滑鼠推開，像一群有個性的小生物。

這段是整站「最有戲」的單一互動。Lusion 風格的精華——物理 + 文字 + stencil window 三個招式合體。

---

## 概念定調

把每個技能想成一個「punch card / 籌碼」，上面刻著技能名 + 那個 TrackMan 風格的角度（9°、15°…）。物件本身的旋轉**就反映那個角度**——9° 的就真的傾斜 9°。

物件們漂浮在一個透明玻璃箱裡，互相磁吸又互相排斥（balanced equilibrium），滑鼠進入箱子就把它們撥開，鬆開又緩緩聚集。

---

## 貼給 AI 的 prompt

```
We are now executing file 05: Toolkit Section. Steps 01-04 are done.
Goal: Transform the Toolkit section into a single Rapier.js physics sandbox where
each skill is a 3D object with an MSDF text label, drifting in zero-G, magnetically
clustered but pushed apart by mouse cursor.

This is the "wow moment" of the site after the hero. Take time to tune the feel.

# 1. STRUCTURE

Create:
  src/scenes/toolkit/
    ToolkitScene.ts            # owns the sandbox
    SkillObject.ts             # one skill = one rigid body + label
    SandboxBoundary.ts         # invisible walls (kinematic colliders) keeping things in
    SandboxWindow.ts           # stencil-clipped viewing window
    msdfText.ts                # MSDF text rendering helper

Install msdf font support:
  npm install troika-three-text
  (or: npm install three-msdf-text-utils — your choice, troika is easier)

# 2. SKILLS DATA

Read from the existing HTML or hardcode this list (matching the current site):

  [
    { id: "python",     label: "PYTHON",       angle: 0,    geometry: "octahedron" },
    { id: "csharp",     label: "C# / .NET",    angle: 15,   geometry: "rounded_cube" },
    { id: "cpp",        label: "C / C++",      angle: 18,   geometry: "tetrahedron" },
    { id: "ai_ml",      label: "AI · ML · DL", angle: 0,    geometry: "icosahedron" },
    { id: "embedded",   label: "EMBEDDED",     angle: 46,   geometry: "rounded_cube" },
    { id: "protocols",  label: "PROTOCOLS",    angle: 52,   geometry: "torus" },
    { id: "database",   label: "DATABASE",     angle: 56,   geometry: "cylinder" },
    { id: "devops",     label: "DEVOPS",       angle: 3.5,  geometry: "octahedron" },
  ]

Each skill becomes one SkillObject.

# 3. SkillObject

Each one consists of:
- A 3D mesh (geometry per the table above, ~0.6 unit size)
- A Rapier dynamic rigid body (mass 1.0, linearDamping 1.5, angularDamping 1.5)
- A ball collider attached to the body (radius matches geometry bounding sphere)
- An MSDF text label using troika-three-text:
    * text: skill.label + " · " + skill.angle + "°"
    * fontSize: 0.12
    * anchor: top of the mesh, slightly forward toward camera
    * material: white text with subtle outline
- Initial rotation: tilt by skill.angle on the X axis (so 9° literally tilts 9°)
- Material: same matcap/pearl pattern as hero, but slightly different tint per skill
  (or all the same — your call, both work)

# 4. PHYSICS BEHAVIOR

Every frame, for each SkillObject:
  - Apply weak attractive force toward the sandbox center (radial spring, k=0.3)
  - Apply weak repulsive force from each other SkillObject (inverse-square, capped)
  - Apply rotation torque toward "upright" so labels stay readable
  - When close to the cursor collider, apply strong repulsive impulse

Cursor collider:
  - Kinematic ball, radius 0.5, follows mouse with damping 0.2
  - Only active when mouse is inside the toolkit section's bounding box
  - When inactive, parked off-screen so it can't accidentally interact

Tuning targets (you'll need to iterate):
  - Equilibrium: objects form a loose cluster around center, gently bobbing
  - Mouse interaction: cursor entering pushes objects 1-2 units away, they drift back
    over ~1 second
  - No object should fly out of the sandbox (boundary walls catch them)
  - No constant jittering at rest (damping high enough)

# 5. SANDBOX BOUNDARY

Six invisible kinematic colliders forming an open box around the play area:
  - Width: matches the toolkit section's content width
  - Height: ~6 units
  - Depth: 3 units
  - Walls have restitution 0.1 (objects don't bounce hard, just get pushed back)

# 6. STENCIL WINDOW

Same technique as hero: render a rounded-rectangle mesh to stencil buffer first,
then render all skill objects with stencilFunc EQUAL stencilRef 1.

The window's HTML anchor: the entire toolkit section's content area.

# 7. LABEL READABILITY

MSDF text must remain readable:
  - When object rotates, text always faces camera (use Sprite-like billboarding,
    OR rotate text node only on Y to face camera)
  - When object is near another object, prevent text overlap (z-sort labels by
    distance to camera, render closer ones over farther ones)
  - Text doesn't get clipped by stencil if it's slightly outside the window
    boundary — labels are rendered AFTER stencil clear, so they always show

# 8. IDLE ACTIVITY

When user hasn't moved mouse for 5 seconds:
  - Pick a random object, apply a small impulse to make it drift
  - This keeps the sandbox feeling alive

# 9. PERFORMANCE

- 8 objects = 8 rigid bodies. Trivial for Rapier.
- 8 MSDF texts = 8 draw calls — fine.
- BUT: physics step + label re-projection every frame. Cap to 60fps.
- Mobile: SHOW objects but DISABLE physics — render them in a fixed cluster
  arrangement, slowly rotating. No mouse interaction on mobile.

# ACCEPTANCE CRITERIA

[ ] Scroll into Toolkit: 8 objects floating in a rough cluster, each with its label
[ ] Labels show skill name + angle (e.g. "C# / .NET · 15°")
[ ] Objects' tilt matches their angle value (15° object visibly tilts 15° from upright)
[ ] Move mouse over the section: objects get pushed away from cursor
[ ] Mouse leaves: objects drift back to center cluster within ~1 second
[ ] No object escapes the visible boundary (stencil window edges)
[ ] Labels stay readable and don't overlap badly
[ ] After 5 seconds idle: random object drifts, sandbox feels alive
[ ] Mobile: objects shown but no physics, no jank
[ ] FPS ≥ 50 desktop during heavy interaction

# REPORTING BACK

Tell me:
1. The physics constants you tuned (mass, damping, attractive k, repulsive coef,
   cursor impulse strength) — list them so I can adjust
2. The MSDF font you chose (Inter? Custom? from where?)
3. Any visible glitches you couldn't solve (e.g. objects sometimes clip through walls)
```

---

## 踩雷預警

### 物理參數最容易調歪
這段最容易做出「物件抖到爆」或「物件不動」兩個極端。要 AI 給你一組可調 constants（不要 hardcode），方便你拖拉測試。建議加一個 dat.gui 或 lil-gui 的 debug panel，dev 模式才出現。

### MSDF 字 Z-fighting
文字疊在 mesh 上會 z-fighting。troika-three-text 有 `outlineWidth` 跟 `depthOffset` 屬性，把字稍微推出來避免閃爍。

### 物件互相穿透
Rapier 的 ball collider 之間如果速度太快會穿過去（tunneling）。解法：物件之間加 `ContactForceEvents` 或降低初始 impulse 強度。AI 不一定會處理。

### Cursor 進入時所有東西爆飛
Repulsive impulse 太強就會這樣。記得 cap impulse magnitude，不要讓單幀 impulse 超過某個 threshold。

### 中文 label 顯示不出來
troika-three-text 預設只載 ASCII glyph。如果之後想要支援 EN/中切換的中文 label，要載 CJK font subset（Noto Sans TC 之類），檔案很大，要做 lazy load。第一版**先用 EN label**，不要硬上中文。

---

## 驗收完成後

```bash
git add -A
git commit -m "step 05: toolkit physics sandbox with MSDF labels"
```

這段做完整站的「肉」就有了。剩下三段是收尾。

下一個檔案：[`06-trajectory.md`](./06-trajectory.md)
