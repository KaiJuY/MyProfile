import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Vite root is the project root; index.html is the entry point.
// We expose alias paths so source files can import via `@core/...`, `@scenes/...`, etc.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@scenes': fileURLToPath(new URL('./src/scenes', import.meta.url)),
      '@physics': fileURLToPath(new URL('./src/physics', import.meta.url)),
      '@utils': fileURLToPath(new URL('./src/utils', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  // Ensure Rapier's wasm is processed correctly — @dimforge/rapier3d-compat ships
  // wasm inlined as base64 so no special config is needed, but we mark it as one
  // big chunk to avoid ESM import-cycle issues during dev pre-bundling.
  optimizeDeps: {
    include: ['three', 'lenis', 'gsap', 'gsap/ScrollTrigger', '@dimforge/rapier3d-compat'],
  },
});
