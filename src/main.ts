import './style.css';
import { bootApp } from '@core/App';

/**
 * Entry point. Vite picks this up via the <script type="module" src="/src/main.ts">
 * tag we added at the end of <body> in index.html.
 *
 * Why DOMContentLoaded gating?
 *  - The existing inline <script> at end of body assumes the DOM is fully parsed
 *    (it queries section elements by id, attaches scroll handlers, etc.). We
 *    follow the same convention so #gl and #hero h1 are guaranteed to exist.
 *  - In practice, Vite-injected modules execute after parsing reaches their
 *    <script> tag. Since our <script> is the last in body, this is moot — but
 *    explicit is better than implicit.
 */
function ready(fn: () => void): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

ready(async () => {
  const app = await bootApp();

  // Expose globals for dev / orchestrator verification.
  // The orchestrator can read window.scrollManager.scrollProgress in browser_evaluate
  // to confirm scroll wiring, and window.app for general inspection.
  type DevWindow = Window & {
    app?: typeof app;
    scrollManager?: typeof app.scrollManager;
  };
  const w = window as DevWindow;
  w.app = app;
  w.scrollManager = app.scrollManager;
});
