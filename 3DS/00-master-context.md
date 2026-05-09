# 00 — Master Context

**用法**：每次開新 AI 對話視窗，**第一件事就是把這份文件全文貼上**，不要省略。AI 必須先看懂這個再開工。

---

## 貼給 AI 的 prompt（從這行下面開始複製）

```
You are helping me upgrade my personal website to a Lusion-style WebGL experience.
Read this entire context before responding. After reading, briefly confirm you understand
by listing back the 7 Lusion techniques and the section structure. Do not write code yet.

# WHO

I'm Kai-Ju Yang ("Allen"), Senior Software Engineer based in Hsinchu, Taiwan, 9+ years
of experience in semiconductor automation (EFEM, SECS/GEM), C# / C++ / Python platform
engineering, and AI/ML (PyTorch, custom YOLO, RAG). My existing site is at
https://myprofile-ec7.pages.dev — please treat that as the content source of truth.

# AESTHETIC IDENTITY (DO NOT ERASE THIS)

The current site has a deliberate identity I want to KEEP:

- Industrial / editorial layout: chapter numbers like "FRAME 01 / 04", project IDs
  like "PRJ_01", file headers like "FILE — 06.05.2026 / TPE-HSZ PROFILE_v9.4"
- Golf metaphor: TrackMan-style stat cards (SPIN 2,840 rpm / LAUNCH 11.2° / CARRY 262 yds),
  a TITLEIST PRO V1X reference, golf ball as hero visual
- Typography: serif headlines ("Software is passion, system design is art.")
  mixed with monospace meta tags ("// automation", "// protocols")
- Color: mostly black / off-white / very limited cool accent — restrained, not flashy
- Section structure: Index → Pursuits → Work → Toolkit → Trajectory → Contact
- Bilingual: EN primary, 中 toggle

DO NOT replace this with Lusion's warm white + photoreal vibe. We are using Lusion's
TECHNIQUES with my AESTHETIC. The result should look like "Kai-Ju's site if he had
Lusion's tech budget", not "a Lusion knockoff with Kai-Ju's name on it".

# THE 7 LUSION TECHNIQUES (we will implement these)

1. Full-screen <canvas> behind HTML, with screen-to-world coordinate mapping
   so HTML grid positions drive 3D object positions (responsive automatic).
2. Vertex Animation Texture (VAT): pre-baked deformation in PNG textures, sampled
   in vertex shader. We probably won't bake new VATs (no Houdini), but we WILL use
   the same shader pattern with simpler procedurally-generated data.
3. Vertex shader pure-math morphs: a single animateProgress (0→1) value drives
   complex deformation via UV-based masks for rotation/translation/scale.
4. Stencil buffer region masking: 3D objects clipped to a rounded-rectangle "window"
   defined by an HTML element's bounding box.
5. Rapier.js physics + cursor-as-collider + custom amplified impulse so small
   mouse movements feel like big hits.
6. Pre-baked matcap + AO + thickness + 2-state diffuse maps combined in a fragment
   shader to fake translucent / SSS materials cheaply.
7. Scroll-jacked chapter pacing with Lenis smooth scroll, GSAP timelines triggered
   by scroll progress, never CSS transitions for hero animations.

# SITE SECTION STRUCTURE

## Hero
"Software is passion, system design is art." headline + subtitle + 3 stats
(9+ years / 10+ systems / 5+ products) + the golf-ball+TrackMan card on the right.
TARGET: Real 3D golf ball, mouse-as-club physics, stats updating live, stencil-clipped window.

## Pursuits (FRAME 01 / 04)
Four small cards: automation / protocols / ai_research / saas.
TARGET: Each frame is a 3D chapter scene; vertex shader morph between them on scroll.

## Work — "Systems that ship and stay shipped." (10+ projects)
Vertical list of project cards: EFEM, SECS Simulator, DCSA-YOLO, PLCSimulation_Service,
Material Manager, Divine Whisper, SN Version, etc.
TARGET: HTML grid stays; each card gets a small 3D companion object that animates in
on scroll, connected by a thin SVG leader line (industrial schematic style).

## Toolkit — "Tools of the obsession."
Skills list with TrackMan-style angle markers (Python 9°, C#/.NET 15°, etc.).
TARGET: Single Rapier.js physics sandbox; each skill is a 3D object with MSDF text
label; cursor pushes them around; stencil-clipped to a window.

## Trajectory (timeline 2025.11 → 2010.09)
4 employer entries + education.
TARGET: Camera flies along a 3D timeline path (Theatre.js), HTML text fades in at
each milestone, with a HUD readout (POS / DEPTH / step counter).

## Contact — "Let's build something precise."
Email / phone / GitHub.
TARGET: A golf ball drops into a hole (the 18th green metaphor — the round is over);
footer fades in after.

# TECH STACK (mandatory)

- Vite + vanilla TypeScript (NOT React Three Fiber — we want low-level control)
- Three.js (latest)
- Rapier.js (@dimforge/rapier3d-compat)
- Lenis (smooth scroll)
- GSAP + ScrollTrigger
- Theatre.js (for trajectory section camera animation only)
- postprocessing (npm package, not three.js examples) for bloom + chromatic aberration

# TECH STACK (forbidden)

- Spline (too generic looking)
- React Three Fiber (we want vanilla three.js)
- Any "no-code 3D" embed widget
- ScrollMagic (deprecated, use ScrollTrigger)
- Three.js example postprocessing (the EffectComposer in /examples/ is OK but the
  pmndrs/postprocessing package is preferred)

# WORKFLOW

I will paste section-specific prompts one at a time (file 01, then 02, then 03...).
After each, you produce code. I run it and report what I see. We iterate until the
"Acceptance Criteria" in that section's prompt are all green, then move to the next.

Always:
- Write code in TypeScript with explicit types on public APIs
- Comment GLSL shaders generously (I will be reading them to learn)
- Prefer composition over inheritance (small classes, no deep hierarchies)
- Use absolute imports via Vite's alias config
- Cap your reply length: don't dump the entire codebase, only files you changed

Confirm you've read this by:
1. Listing the 7 Lusion techniques in your own words (one line each)
2. Listing the 6 site sections in order
3. Stating the one aesthetic rule you must not violate
Then wait for me to paste the next file.
```

---

## 你需要做的事（在貼上之前）

在貼這段 prompt 之前先完成：

1. ✅ 把現有網站 fork / clone 一份到本機
2. ✅ 確認 git working tree 乾淨（`git status` 是 clean 的）
3. ✅ 開好 Cursor / Claude Code，把專案資料夾載入
4. ✅ 開新對話視窗（不要在已經有 context 的舊對話裡貼）

## 驗收（AI 回覆後檢查）

AI 應該回覆三件事：

1. **7 個技術**用它自己的話列出來（不能完全照抄，要能看懂它真的理解）
2. **6 個 section** 按順序列出（Index 不算 section，是 nav）
3. **一條美學鐵律**：保留你的工業/編輯/golf 識別，不要變成 Lusion 翻版

如果 AI 漏掉任何一項或亂講，**重貼一次**，不要往下走。Context 沒鋪好，後面每段都會歪。

---

下一個檔案：[`01-skeleton-setup.md`](./01-skeleton-setup.md)
