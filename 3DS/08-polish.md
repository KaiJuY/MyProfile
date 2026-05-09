# 08 — Polish: Loader, Postprocessing, RWD, EN/中, 效能

**目標**：上線前的最後一段。把 loader、postprocessing、響應式、語言切換、效能 guard 全部處理完，讓網站達到「可以丟到 Awwwards 提名」的完成度。

這段不是裝飾，是區分「DEMO」跟「PRODUCT」的分水嶺。

---

## 貼給 AI 的 prompt

```
We are now executing file 08: Polish. Steps 01-07 are done. The site visually works
end-to-end. This step is about production-readiness: loader, postprocessing,
responsive fallbacks, language switch preservation, and performance hardening.

# 1. LOADER

Create a custom loader that runs before the main app starts. While loading:

  Display state (HTML overlay, full-screen, on top of everything):
    INIT WEBGL CONTEXT          [ok]
    LOAD MATCAP TEXTURES        [ok]
    COMPILE SHADERS             [ok]
    INIT PHYSICS WORLD          [ok]
    BUILD SCENES                [73%]
    
    LOADING ··· 73%
    ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
    
    PROFILE_v9.4 / TPE-HSZ / KAI-JU YANG

Identity rules:
  - Monospace font (matching site identity)
  - Dark background, off-white text, NO color flash
  - The "boot sequence" rows feel like an industrial machine starting up
  - Each row appears with a slight stagger (100ms each)
  - Status flips from blank to [ok] when that resource finishes loading
  - When all resources loaded: "READY" appears, click-to-enter prompt
  - Click-to-enter required to proceed (also satisfies browser autoplay policy
    if you have audio in step 07)

Track loading of:
  - All texture files (matcap, dimple normal map procgen, any other PNGs)
  - All shader compilations (force compile by rendering one frame off-screen)
  - Rapier WASM init
  - Font loading (MSDF font for toolkit labels)

Do NOT load 3D model files unless you've added external .glb assets — most of
this site uses procedural geometry, so the loader is mostly waiting on Rapier
and shaders.

# 2. POSTPROCESSING

Use the `postprocessing` package (already installed in step 01).

Pipeline (in order):
  1. RenderPass (main scene render)
  2. BloomEffect — radius 0.5, intensity 0.4, luminanceThreshold 0.7
     (only emissive elements bloom: hero ball rim light, protocols nodes,
     trajectory markers, divine whisper sprites)
  3. ChromaticAberrationEffect — offset (0.0008, 0.0008) ~ very subtle
  4. NoiseEffect (film grain) — premultiply true, blendFunction OVERLAY,
     intensity 0.05 ~ barely there
  5. ToneMappingEffect (ACES Filmic) — already in renderer, but include here
     for consistency

CRITICAL: postprocessing is expensive. Add a quality toggle:
  - HIGH (default desktop): all 5 passes
  - MEDIUM: drop chromatic aberration + noise, keep bloom
  - LOW (default mobile): no postprocessing, direct render

Auto-detect quality:
  - Mobile (touch device, screen < 768px): LOW
  - Mid-range desktop (FPS < 50 over 5 seconds): drop to MEDIUM
  - High-end desktop: HIGH

Expose a manual toggle in the corner of the page (small icon, not intrusive).

# 3. RESPONSIVE / MOBILE FALLBACKS

For mobile (touch device OR width < 768px):
  - Hero: static rotating ball (no physics, no stats binding, no trajectory trail)
  - Pursuits: poster images for each frame, fade in on scroll, no 3D
  - Work: NO 3D companions, just HTML cards (already done in step 04)
  - Toolkit: 8 objects rendered in fixed cluster, slowly rotating, no physics
  - Trajectory: full version OK (it's light) but disable marker emissive glow
  - Contact: simplified ball drop (straight line, 0.5s) instead of physics roll
  - Postprocessing: disabled

The mobile experience is intentionally a degraded version — that's fine. The story
still reads. It just reads in 2D-ish.

# 4. LANGUAGE SWITCH (EN / 中)

The existing site has an EN / 中 toggle. Make sure it works WITH the WebGL layer:
  - All HTML text content has both EN and 中 versions
  - The 中 toggle swaps `lang` attribute on body and updates all text via i18n
  - WebGL labels (toolkit MSDF text) need to handle 中:
      * If you didn't load CJK glyphs in step 05 (recommended), the toolkit labels
        stay in EN even when site is in 中 mode. Add a small note or just leave
        them — abbreviations like "PYTHON" / "C# / .NET" don't need translation
      * Alternatively, lazy-load Noto Sans TC subset on first 中 toggle (~200KB)
  - Stats numbers (SPIN / LAUNCH / CARRY) stay numeric (no translation needed)
  - HUD labels in trajectory: keep EN (POS / DEPTH / STEP) — these are technical
    abbreviations, not localized

# 5. PERFORMANCE BUDGET (HARD LIMITS)

Enforce these or fail the build:

  Initial JS bundle:        < 350 KB gzipped
  Initial CSS bundle:        < 30 KB gzipped
  3D model assets total:     < 500 KB (we use mostly procedural, so easy)
  Texture assets total:      < 1 MB (matcap + any baked maps)
  
  Time to Interactive (TTI): < 4s on 4G mid-range mobile
  First Contentful Paint:    < 1.5s
  
  Steady-state FPS:
    Desktop high-end:        60
    Desktop mid:             ≥ 45
    Mobile:                  ≥ 30
  
  Lighthouse Performance:    ≥ 75 (WebGL sites won't hit 100, 75+ is realistic)

Add a visible FPS counter in dev mode (?debug=1 query param).

Use `vite-plugin-bundle-analyzer` to check bundle composition. Common offenders:
  - GSAP (full bundle is big — use only the modules you need)
  - Three.js (don't bundle examples wholesale — only import what you use)
  - postprocessing (tree-shake what you don't use)

# 6. ACCESSIBILITY

WebGL sites tend to be a11y nightmares. Minimum bar:
  - All HTML content readable by screen reader (canvas is decoration, aria-hidden)
  - Keyboard navigation works for nav, links, language toggle
  - prefers-reduced-motion respected:
      * No idle bobbing, no scroll-jacking, no morph transitions
      * Just static 3D + standard scroll behavior
      * Stats stay at baseline values, no live update
  - Focus indicators on all interactive elements (not just hover states)

# 7. SEO / META

The existing meta tags should be preserved. Add:
  - Open Graph image (a static screenshot of the hero — render once, save as JPG)
  - JSON-LD structured data for Person schema (Kai-Ju Yang, jobTitle, alumniOf,
    knowsAbout, contactPoint)

# 8. DEPLOYMENT

The site is hosted on Cloudflare Pages (per the URL). Make sure:
  - vite build outputs to /dist
  - All assets use relative paths or proper base URL
  - HTTP caching headers for /assets/* set to immutable + 1 year
  - Service worker NOT needed (over-engineering for this scope)

# ACCEPTANCE CRITERIA

[ ] Loader displays the boot sequence with [ok] flips and percentage
[ ] Loader takes 1-3 seconds on a fresh load (cached: < 0.5s)
[ ] Bloom is visible on emissive elements but not overdone
[ ] Chromatic aberration is barely perceptible — taste the line, don't cross it
[ ] Quality toggle works: switch between HIGH/MEDIUM/LOW visibly changes effects
[ ] Auto-quality kicks in: throttle CPU in DevTools, watch quality drop to MEDIUM
[ ] Mobile: open in Chrome DevTools mobile emulator + a real phone, no jank
[ ] EN ↔ 中 toggle works, all HTML text swaps, no broken layout
[ ] prefers-reduced-motion: enable in OS, all heavy animations disabled
[ ] Lighthouse Performance ≥ 75 desktop, ≥ 60 mobile
[ ] Bundle size: `npm run build` then check dist/ — under budget
[ ] Deploy to staging Cloudflare Pages, test on a real phone over 4G

# REPORTING BACK

Tell me:
1. Final bundle sizes (JS, CSS, assets)
2. Lighthouse scores on desktop and mobile
3. Steady-state FPS on your test machine for each section
4. Any acceptance criterion that's hard to satisfy and why
```

---

## 踩雷預警

### Postprocessing 一加上 FPS 砍半
這幾乎一定會發生。Bloom 是最貴的。如果 desktop 從 60 掉到 30，先**只開 bloom，關掉其他全部**，再逐個加回來看。Chromatic aberration 跟 noise 視覺貢獻其實小，效能比卻吃很重，可以果斷砍。

### Loader 卡在 99% 不動
通常是某個 async 任務沒回 callback。Rapier WASM 初始化失敗、shader compile 出錯、MSDF font 404 都會卡住。Loader 要有 timeout（例如 10 秒沒進度就跳「LOAD FAILED · CLICK TO RETRY」）。

### iOS Safari 上 postprocessing 整個壞掉
iOS Safari 的 WebGL 對 floating point 紋理支援限制多。如果 bloom pass 在 iOS 上全黑，要用 `HalfFloatType` 而不是 `FloatType`。AI 不一定知道，遇到再叫它改。

### EN/中 切換重新跑 loader
不應該。只是 swap text，不要重 init scene。如果 AI 寫的 i18n 邏輯太重會這樣。

### prefers-reduced-motion 沒做
Awwwards 提名 2025 後越來越要求這個。一定要做。可以是 `if (matchMedia('(prefers-reduced-motion: reduce)').matches)` 直接 disable 大部分動畫。

### 字型 FOIT/FOUT
字型載入時的 flash 很醜。用 `font-display: swap` 配合 fallback 字型樣式接近的（serif 用 Georgia 接，monospace 用 Menlo 接）。

---

## 驗收完成後

```bash
git add -A
git commit -m "step 08: polish — loader, postprocessing, rwd, i18n, perf"
git tag v10.0.0
```

整站完成。

---

## 上線前最後一輪 self-check

不寫 code 了，自己過一遍：

- [ ] 把網站丟給三個朋友看，30 秒內他們能說出「這人是做什麼的」嗎？（如果不行，識別性不夠強）
- [ ] iPhone Safari + Android Chrome 各看一次，整站能完整跑完不卡嗎？
- [ ] 盲測：把 lusion.co、你的網站、隨便一個 portfolio 站三個放一起，10 個朋友選哪個「最有質感」。如果你能拿到 3 票以上，就是 90% 對標達成。
- [ ] 開新 incognito 視窗、4G throttle、看 LCP — 第一螢幕內容多久出現？4 秒內 OK。
- [ ] 關鍵頁面（hero、contact）開 prefers-reduced-motion 看，靜態版本也好看嗎？

---

## 結束

整套 playbook 跑完，你應該會：

1. 對 Three.js / Rapier / GLSL 有基本到中階的理解
2. 看懂 Lusion 那種網站到底在玩什麼把戲
3. 有一個能放在履歷上、跟你的工程深度匹配的個人站
4. 大概燒掉 6–8 週的週末跟晚上

**做完之後**：把它丟去 Awwwards 試試看 honorable mention（不要期待 SOTY，那要更多）。然後把整個過程寫一篇 case study 在你的部落格或 Medium，這篇 case study 本身會是你下一個求職的有力武器。

如果 playbook 中間哪段卡死了，回來找我。我可以針對特定段落寫更細的 prompt，或幫你 debug shader / 物理參數。
