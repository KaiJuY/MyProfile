# Lusion 風格升級 Playbook

把 `myprofile-ec7.pages.dev` 用 Lusion (https://lusion.co) 工法升級的逐步劇本。

---

## 誠實的期待設定（讀完再開始）

AI 助理（Cursor / Claude Code / Windsurf）能幫你做到的：

- **60–75% 的 Lusion 質感**

剩下 15–30% 的差距來自：

- 3D 模型品質 — AI 不會生 .glb 檔，要從 Sketchfab 找或自己用 Blender 做
- Matcap / Normal map / AO 多通道貼圖的美感 — 需要 Blender 烘焙 + 設計判斷
- Houdini VAT（高階布料/角色動畫）— Lusion 最強的招，AI 沒辦法操作 Houdini
- 整體節奏感 — 動畫的 timing、easing、章節之間的呼吸點，靠你看著螢幕一直微調

**如果你的目標是「在朋友面前看起來像 Lusion 等級」**：60–75% 完全達標。
**如果你的目標是 1:1 對標 Lusion 並打 Awwwards SOTY**：這份 playbook 不夠，你需要請真人團隊。

---

## Playbook 結構

10 個檔案，按順序執行：

| 檔案 | 內容 | 預估時間 |
|---|---|---|
| `00-master-context.md` | 每次開新 AI session 必貼的全站背景 | 0.5 天讀懂 |
| `01-skeleton-setup.md` | Vite + Three.js + Rapier + Lenis 骨架 | 1 天 |
| `02-hero.md` | Hero 高爾夫球 + 物理 + TrackMan 數據綁定 | 3–5 天 |
| `03-pursuits.md` | Pursuits 4 frame 切換 + vertex shader morph | 2 天 |
| `04-work.md` | Work 區每專案 mini 3D scene | 3–4 天 |
| `05-toolkit.md` | Toolkit 物理沙盒 + MSDF 文字 | 3 天 |
| `06-trajectory.md` | Trajectory 相機沿 timeline 飛行 | 2 天 |
| `07-contact.md` | Contact 進洞收尾動畫 | 1 天 |
| `08-polish.md` | Loader + postprocessing + RWD + 中/EN | 2 天 |

合計 **17–22 個工作天**（每天 3–5 小時 AI 協作）。週末 + 晚上做的話約 6–8 週。

---

## 工作流

1. 把現在的網站 fork 或 clone 一份專門用來改造，**不要直接改線上版**
2. 開 Cursor / Claude Code，打開那個 fork
3. 開新 AI 對話 → **貼 `00-master-context.md` 全文** → 等 AI 確認看懂
4. 接著貼 `01-skeleton-setup.md`，等 AI 跑完
5. **驗收**：每個檔案最後都有 "Acceptance Criteria"，按條目逐一檢查，不過就讓 AI 修
6. 通過 → `git commit` 一次（必做，方便壞了能 rollback）
7. 進下一個檔案，重複
8. 整段做不出來 → 看本檔最後「卡住怎麼辦」

**重要**：每進入新 section 都建議**開新對話視窗**，重新貼 `00-master-context.md`。長對話 AI 會忘記 context、也會越來越貴。

---

## 工具需求

| 必備 | 用途 |
|---|---|
| Node.js 20+ | 跑 Vite |
| Cursor 或 Claude Code | AI 協作 IDE |
| Git | rollback 救命 |
| Chrome/Edge 最新版 | WebGL 2.0 開發測試 |

| 強烈建議 | 用途 |
|---|---|
| Blender 4.x（免費） | 匯入/匯出 .glb、烘 normal map、做簡單 AO |
| iPhone/Android 實機 | mobile 測試（GPU 行為跟桌面差很多） |

| 資源網站 | 用途 |
|---|---|
| https://sketchfab.com | 找免費 3D 模型 |
| https://polyhaven.com | 免費 HDRI 環境貼圖 |
| https://github.com/nidorx/matcaps | matcap 紋理庫（直接抓 PNG） |
| https://gltf-viewer.donmccurdy.com | 線上預覽 .glb |

---

## 推薦的 AI 工具

對這種 multi-file、需要看整個 codebase 的長期改造，**Claude Code 是目前最適合的**——可以在 terminal 裡讓 AI 直接改你的 repo，不用一直複製貼上。Cursor 也行但更適合短任務。

如果你選 Claude Code，工作流變成：

```bash
cd your-fork
claude
# 然後把 00-master-context.md 內容貼進去
# 之後每段直接說 "now do file 02"
```

---

## 卡住怎麼辦

### 情境 1：AI 寫的 shader 顯示全黑/全白

- 把 GLSL 程式碼貼回給 AI 說「畫面是全黑/全白，幫我除錯」
- 大概率是 `gl_Position` 或 `gl_FragColor` 沒設好、或 uniform 名稱拼錯
- 最後一招：要 AI 改寫成最簡版（純色 fragment）逐步加複雜度

### 情境 2：物理表現怪怪的（球飛走、抖動）

- 問題 99% 是 timestep 跟渲染 frame rate 不同步
- Rapier 用固定 60Hz timestep（`world.timestep = 1/60`），不要跟著 `requestAnimationFrame`
- 質量 (mass) 設太小會抖、太大會慢

### 情境 3：模型載入後位置不對 / 看不到

- Blender 跟 Three.js 的座標系不同：Blender Z up、Three.js Y up
- 匯出 .glb 時勾「+Y up」
- 模型過大或過小：先 `scene.add(new THREE.AxesHelper(5))` 看軸向

### 情境 4：滾動不流暢 / 卡頓

- Lenis 跟 GSAP ScrollTrigger 要正確接通（兩者都會搶 scroll 事件）
- 問 AI：「Lenis 跟 GSAP ScrollTrigger 的整合是不是正確的？貼相關程式碼」
- mobile 上 60fps 是不切實際的目標，30fps 已經很好

### 情境 5：performance 掉到爆

- 開 Chrome DevTools → Performance → 錄一段 → 看 GPU 跟 main thread
- 常見元兇：太多 draw call（每幀超過 200 就要 instancing）、texture 太大（單張 > 2048x2048 要警惕）、postprocess pass 太多
- 砍掉一半 effect 看是哪個在燒

### 情境 6：AI 一直循環給同樣的錯解

- 開新對話視窗、重貼 master context、只貼當前要做的這一段 prompt
- 把錯誤訊息**完整**貼上去（包含 stack trace），不要省略
- 還是不行：直接 google 該錯誤訊息 + Three.js / Rapier，stack overflow 的解通常比 AI 強

---

## 心態建議

這不是「貼 prompt 就跑」的活，是**「你當 art director、AI 當實作員」的協作**。你的工作是：

- 看著螢幕說「這個球跳得太快」「這個地方節奏卡住了」「stencil 邊界太硬」
- 找參考截圖（lusion.co 的對應段落、Awwwards 上其他作品）給 AI 對標
- 拒絕 AI 給你的「OK 但平庸」第一版，逼它再改

如果你只想貼一個 prompt 就拿到 90% Lusion，那不存在。但如果你願意花 6 週看著 AI 改，這條路會通。

---

開始吧。下一個檔案：[`00-master-context.md`](./00-master-context.md)
