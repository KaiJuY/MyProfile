// wave-03: Hero ball anchor / return-to-center verification.
//
// Boots the dev site, simulates a fast mouse pass that hits the ball, waits
// for the anchor to reel it back in, then asserts:
//   - ball position is within 0.1 world units of home
//   - linear velocity magnitude is < 0.05 world units / s
//
// Usage (from repo root):
//   node 3DS/_verification/wave-03/verify-hero-anchor.mjs
// Outputs:
//   3DS/_verification/wave-03/hero-anchor-result.json
//   3DS/_verification/wave-03/hero-anchor-rest.png   (screenshot at rest)
//   3DS/_verification/wave-03/hero-anchor-hit.png    (screenshot mid-hit)

import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://127.0.0.1:5173/?nogate=1';
const OUT_DIR = path.resolve('3DS/_verification/wave-03');

// Tolerances for pass/fail.
const POS_TOL = 0.1;   // world units from home
const VEL_TOL = 0.05;  // world units / s

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  });
  const consoleLogs = [];
  const errors = [];
  let result = { passed: false, reason: 'unknown' };

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    page.on('console', (m) => consoleLogs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for hero physics body to be live (init is async — GLB load).
    await page.waitForFunction(
      () => {
        const m = globalThis.app?.sceneManager?.modules?.get?.('hero')?.mod;
        return Boolean(m?.ballBody);
      },
      { timeout: 30000 }
    );
    // Settle a few RAFs.
    await new Promise((r) => setTimeout(r, 500));

    // Read home + sphere screen rect so we can target mousemove events at it.
    const initial = await page.evaluate(() => {
      const m = globalThis.app.sceneManager.modules.get('hero').mod;
      const home = m.home;
      const t = m.ballBody.translation();
      const lv = m.ballBody.linvel();
      const sphereEl = document.querySelector('.sphere-stage .sphere');
      const r = sphereEl ? sphereEl.getBoundingClientRect() : null;
      return {
        home: { x: home.x, y: home.y, z: home.z },
        ballPos: { x: t.x, y: t.y, z: t.z },
        ballLinvel: { x: lv.x, y: lv.y, z: lv.z },
        sphereRect: r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null,
      };
    });

    if (!initial.sphereRect) {
      result = { passed: false, reason: 'sphere element not found' };
      return;
    }

    // Center of the ball on screen.
    const cx = initial.sphereRect.left + initial.sphereRect.width / 2;
    const cy = initial.sphereRect.top + initial.sphereRect.height / 2;

    // Simulate a fast horizontal mouse swipe that crosses the ball center.
    // We dispatch a sequence of mousemove events with large deltas so the
    // mouseVel EMA reads as a hard hit.
    await page.mouse.move(cx - 200, cy);
    await new Promise((r) => setTimeout(r, 50));
    // Series of fast moves crossing the ball:
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const x = cx - 200 + (400 * i) / steps;
      await page.mouse.move(x, cy + (Math.sin(i) * 4));
      await new Promise((r) => setTimeout(r, 8));
    }

    // Quick screenshot just after the hit (should show ball displaced).
    await new Promise((r) => setTimeout(r, 80));
    await page.screenshot({ path: path.join(OUT_DIR, 'hero-anchor-hit.png'), type: 'png' });

    // Read state shortly after hit (sanity: ball should be moving).
    const midHit = await page.evaluate(() => {
      const m = globalThis.app.sceneManager.modules.get('hero').mod;
      const t = m.ballBody.translation();
      const lv = m.ballBody.linvel();
      return {
        pos: { x: t.x, y: t.y, z: t.z },
        linvel: { x: lv.x, y: lv.y, z: lv.z },
        speed: Math.sqrt(lv.x * lv.x + lv.y * lv.y + lv.z * lv.z),
      };
    });

    // Park cursor far away so it can't hit again, then wait for anchor to settle.
    await page.mouse.move(10, 10);
    await new Promise((r) => setTimeout(r, 2200));

    // Read at-rest state.
    const atRest = await page.evaluate(() => {
      const m = globalThis.app.sceneManager.modules.get('hero').mod;
      const t = m.ballBody.translation();
      const lv = m.ballBody.linvel();
      const home = m.home;
      const dx = t.x - home.x;
      const dy = t.y - home.y;
      const dz = t.z - home.z;
      const posErr = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const speed = Math.sqrt(lv.x * lv.x + lv.y * lv.y + lv.z * lv.z);
      const sm = globalThis.app?.scrollManager;
      return {
        pos: { x: t.x, y: t.y, z: t.z },
        home: { x: home.x, y: home.y, z: home.z },
        linvel: { x: lv.x, y: lv.y, z: lv.z },
        posErr,
        speed,
        scrollProgress: sm?.scrollProgress,
        scrollY: window.scrollY,
        anchorStrength: (() => {
          const sinceHit = performance.now() - m.lastHitT;
          const t0 = 200, t1 = 600;
          const tt = Math.max(0, Math.min(1, (sinceHit - t0) / (t1 - t0)));
          return tt * tt * (3 - 2 * tt);
        })(),
        meshVisible: m.ballMesh?.visible,
        ballPaused: m.paused,
        stageSize: m.cachedStageSize,
        halfW: m.cachedStageSize?.width * 0.45,
        halfH: m.cachedStageSize?.height * 0.45,
        bodyType: m.ballBody?.bodyType?.(),
      };
    });

    await page.screenshot({ path: path.join(OUT_DIR, 'hero-anchor-rest.png'), type: 'png' });

    const passed = atRest.posErr < POS_TOL && atRest.speed < VEL_TOL;
    result = {
      passed,
      reason: passed
        ? 'ball returned to home and settled below tolerance'
        : `posErr=${atRest.posErr.toFixed(4)} (tol ${POS_TOL}) speed=${atRest.speed.toFixed(4)} (tol ${VEL_TOL})`,
      tolerances: { POS_TOL, VEL_TOL },
      initial,
      midHit,
      atRest,
    };

    await page.close();
  } catch (err) {
    result = { passed: false, reason: `harness error: ${err && err.message}` };
  } finally {
    await browser.close();
  }

  const out = { result, consoleLogs, errors };
  await writeFile(path.join(OUT_DIR, 'hero-anchor-result.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
