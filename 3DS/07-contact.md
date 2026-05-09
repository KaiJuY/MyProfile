# 07 — Contact: 進洞收尾動畫

**目標**：Contact 區的視覺收尾——一顆高爾夫球從上方掉下、彈幾下、滾進洞裡。球進洞後，footer 跟聯絡資訊才浮現。

整個 18 洞 round 的隱喻在這裡收尾。

---

## 概念定調

整站的敘事就是一場 golf round：
- Hero = tee off（開球）
- Pursuits / Work / Toolkit / Trajectory = fairway 跟綠草
- Contact = green / hole-out（進洞）

球進洞後，整個體驗才算「完成」。footer 的版本號 `VER 9.4.0 · TRACKED · LIVE` 在球進洞後才出現，呼應「shipped」的概念。

---

## 貼給 AI 的 prompt

```
We are now executing file 07: Contact Section. Steps 01-06 are done.
Goal: A finale animation — a golf ball drops into a hole as the user reaches the
Contact section. Footer + contact info fades in only after the ball is in the hole.

This is the narrative bookend of the site's golf metaphor.

# 1. STRUCTURE

Create:
  src/scenes/contact/
    ContactScene.ts            # owns the finale animation
    Hole.ts                    # the cup geometry
    GreenSurface.ts            # subtle ground plane

# 2. SCENE SETUP

Camera: looking down at a slight angle (like a putting view), focused on a hole.

Hole:
  - A circular flat plane with a ring (TorusGeometry, thin) marking the rim
  - A dark hollow inside (the actual cup) — implement as a black disc slightly
    below the green surface
  - Subtle shadow ring around the hole (use a radial gradient texture or shader)

Green surface:
  - A subtle textured ground plane around the hole
  - Color: dark, low contrast — this is the "putting green" but stylized minimal

# 3. THE BALL DROP ANIMATION

Triggered when the user scrolls into the Contact section (top of section reaches
viewport).

Animation timeline (use GSAP):
  - 0.0s: ball appears at top-of-viewport position, above the hole, with downward
    velocity (it's "falling onto the green")
  - 0.0s - 0.6s: ball falls under gravity, lands on green surface near hole
  - 0.6s - 1.5s: ball rolls toward hole (use Rapier physics for this part — apply
    initial velocity, let physics handle the rolling)
  - 1.5s - 1.8s: ball reaches hole edge, teeters on rim briefly (small physics
    deflections), then drops in
  - 1.8s - 2.2s: ball falls into hole, disappears below surface
  - 2.2s+: a soft "thunk" haptic — small camera shake, brief flash of the rim glow

# 4. FOOTER FADE-IN

The contact info HTML (email, phone, GitHub link) and the footer text:

  © 2026 KAI-JU YANG · BUILT IN VS, SHIPPED FROM HSINCHU
  VER 9.4.0 · TRACKED · LIVE

Initial state: opacity 0.

After the ball drops into the hole (at ~2.2s into the animation):
  - "Let's build something precise." headline fades in (already there in HTML,
    just unhide it)
  - Contact info fades in (staggered, 100ms between items)
  - Footer fades in last
  - The "TRACKED · LIVE" suffix in the footer pulses gently (subtle scale animation
    on "LIVE")

# 5. RE-PLAY

If user scrolls UP and back DOWN, the animation should replay (don't lock to "first
visit only"). But replays should be slightly faster (1.5s total instead of 2.2s) so
returning visitors aren't held up.

# 6. AUDIO (OPTIONAL)

If you want to add a soft "thunk" sound when the ball drops in:
  - Use a tiny mp3 (< 30KB)
  - Only play after the FIRST user interaction with the page (browser autoplay policy)
  - Mute by default; provide a small audio toggle in the corner
  - SKIP this if you're not confident — silence is better than awkward sound

# 7. THE BALL ITSELF

Reuse the hero's golf ball mesh (same material, same dimple normal map). Keep
visual consistency. This is THE SAME ball from the hero — it's been on a journey
through the site, and now it's coming home.

# 8. PERFORMANCE

This section is light. The animation runs once per visit (or scroll cycle), so
performance isn't a concern. Just don't keep simulating physics after the ball
is in the hole — destroy the rigid body or set it to sleeping.

# ACCEPTANCE CRITERIA

[ ] Scroll into Contact section: animation triggers automatically
[ ] Ball falls, lands, rolls, teeters, drops in — feels physically believable
[ ] Camera shake / rim flash on drop is subtle, not Disney
[ ] Contact info + footer fade in AFTER ball is in hole, not before
[ ] Footer "LIVE" text has a subtle pulse animation
[ ] Scroll up and back down: animation replays (slightly faster)
[ ] Email / phone / GitHub links remain clickable (no canvas blocking pointer events)
[ ] Mobile: simplified animation (ball drops straight in, no roll), still triggers
   the fade-in correctly

# REPORTING BACK

Tell me:
1. Whether you used Rapier physics for the roll, or scripted it with GSAP, and why
2. The total animation duration on first play vs replay
3. Any visual that doesn't feel "satisfying" so I can request a revision
```

---

## 踩雷預警

### 物理不穩定，球永遠不進洞
碗狀 hole 的物理碰撞很容易讓球卡在邊緣震動。實務上**不要真的用物理算進洞**——前 1.5 秒用物理（讓滾動真實），最後 0.7 秒用 GSAP scripted（拉著球進洞）。AI 如果硬要全程物理，調不出來就會放棄，要明確要求混合方案。

### 球從哪裡掉下來不明顯
如果球從畫面正上方掉下，使用者可能根本沒看到掉下的瞬間。可以讓球從**側上方**進入（有方向性），或在球出現時加一條淡淡的軌跡虛線（呼應 hero 的 trajectory trail）。

### Footer fade in 太快
2.2 秒等待對行動裝置使用者來說太久（他們已經滾到底想看 contact 了）。replay 模式要更快，第一次也可以縮到 1.5 秒。AI 預設給 2.2 秒不一定理想，自己感受後調。

### Ball 進洞後消失太突兀
進洞後可以用 **alpha fade out** 而不是瞬間消失。或者球掉下後 camera 微微下移，視覺暗示「掉下去了」。

### Pointer events 被 canvas 擋住
Contact 區的 mailto / tel / github 連結要能點。Canvas 預設 `pointer-events: none`，但 ContactScene 如果意外開了 pointer-events 就 GG。檢查：點擊 email 連結真的會開信箱。

---

## 驗收完成後

```bash
git add -A
git commit -m "step 07: contact finale with ball drop animation"
```

整站「故事」完整了。最後一段是 polish 跟 production-ready。

下一個檔案：[`08-polish.md`](./08-polish.md)
