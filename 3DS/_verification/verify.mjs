// Verification harness — drives Chrome via puppeteer-core for scroll/eval/screenshot.
// Usage: node 3DS/_verification/verify.mjs <step-name> <flow>
//   flow ∈ { hero | flythrough | projects | bag | career | contact | full }
// Outputs to 3DS/_verification/<step>/{flow}-{viewport}.png + {flow}-state.json
// Usage from Bash:
//   node 3DS/_verification/verify.mjs step-03 flythrough
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://127.0.0.1:5173/';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, dpr: 1 },
  { name: 'mobile', width: 390, height: 844, dpr: 2 },
];

async function main() {
  const [, , stepName, flow = 'hero'] = process.argv;
  if (!stepName) {
    console.error('Usage: node verify.mjs <step-name> <flow>');
    process.exit(2);
  }
  const outDir = path.resolve('3DS/_verification', stepName);
  await mkdir(outDir, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  });
  try {
    const consoleLogs = [];
    const errors = [];

    for (const vp of VIEWPORTS) {
      const page = await browser.newPage();
      await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr });
      page.on('console', (m) => consoleLogs.push(`[${vp.name}/${m.type()}] ${m.text()}`));
      page.on('pageerror', (e) => errors.push(`[${vp.name}/error] ${e.message}`));

      await page.goto(URL, { waitUntil: 'networkidle0', timeout: 20000 });
      // wait for window.app to exist (means main.ts boot finished)
      await page.waitForFunction(() => Boolean((globalThis).app), { timeout: 10000 });
      await new Promise((r) => setTimeout(r, 500)); // settle one extra RAF

      // scroll to flow target. Special syntax: "section@N" scrolls into a section
      // by N% (0..1) of its height; useful for verifying frame transitions inside
      // sticky sections like #flythrough.
      const scrollResult = await page.evaluate(async (target) => {
        const sectionMap = {
          hero: 0,
          flythrough: 'flythrough',
          projects: 'projects',
          bag: 'bag',
          career: 'career',
          contact: 'contact',
          full: 'bottom',
        };
        const m = /^(\w+)@(\d*\.?\d+)$/.exec(target);
        let key = target, pct = null;
        if (m) { key = m[1]; pct = Number(m[2]); }
        const t = sectionMap[key] ?? key;
        let y = 0;
        if (t === 0) y = 0;
        else if (t === 'bottom') y = document.body.scrollHeight - innerHeight;
        else {
          const el = document.getElementById(t);
          if (el) {
            const rect = el.getBoundingClientRect();
            const top = rect.top + window.scrollY;
            if (pct !== null) y = top + rect.height * pct;
            else y = top - 60;
          }
        }
        // Use Lenis if present (so smooth scroll is a no-op via immediate)
        const lenis = (globalThis).app?.scrollManager?.lenis;
        if (lenis && typeof lenis.scrollTo === 'function') {
          lenis.scrollTo(y, { immediate: true, force: true });
        } else {
          window.scrollTo(0, y);
        }
        // give RAF + Lenis time to settle, also tick a few frames
        await new Promise((r) => setTimeout(r, 800));
        return {
          target,
          y,
          scrollY: window.scrollY,
          scrollProgress: (globalThis).app?.scrollManager?.scrollProgress,
          sectionProgress: typeof t === 'string' && t !== 'bottom'
            ? (globalThis).app?.scrollManager?.sectionProgress?.(t)
            : undefined,
          sectionRect: typeof t === 'string' && t !== 'bottom'
            ? document.getElementById(t)?.getBoundingClientRect().toJSON()
            : undefined,
          activeFrame: (globalThis).app?.sceneManager?.modules
            ? Array.from((globalThis).app.sceneManager.modules.keys())
            : undefined,
        };
      }, flow);

      await new Promise((r) => setTimeout(r, 300));
      const shot = path.join(outDir, `${flow}-${vp.name}.png`);
      await page.screenshot({ path: shot, type: 'png' });
      await page.close();

      console.log(`[${vp.name}] saved ${shot}`);
      console.log(`[${vp.name}] state:`, JSON.stringify(scrollResult, null, 2));
    }

    const stateFile = path.join(outDir, `${flow}-state.json`);
    await writeFile(stateFile, JSON.stringify({ consoleLogs, errors }, null, 2));
    console.log(`state saved to ${stateFile}`);
    if (errors.length) {
      console.error('PAGE ERRORS:');
      errors.forEach((e) => console.error(' ', e));
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
