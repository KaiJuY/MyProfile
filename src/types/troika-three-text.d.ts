/**
 * Minimal ambient declaration for troika-three-text.
 *
 * troika-three-text doesn't ship .d.ts files. Their public API is documented
 * at https://protectwise.github.io/troika/troika-three-text/. We type the
 * subset we actually use: the `Text` class (extends THREE.Mesh).
 *
 * Per CLAUDE.md "explicit types on public APIs" — if you add a new troika
 * property, declare it here too rather than `(text as any).foo = ...`.
 */
declare module 'troika-three-text' {
  import * as THREE from 'three';

  export class Text extends THREE.Mesh {
    text: string;
    font: string | undefined;
    fontSize: number;
    color: number | string | THREE.Color;
    outlineColor: number | string | THREE.Color;
    outlineWidth: number | string;
    outlineBlur: number | string;
    outlineOpacity: number;
    anchorX: 'left' | 'center' | 'right' | number | string;
    anchorY:
      | 'top'
      | 'top-baseline'
      | 'middle'
      | 'bottom-baseline'
      | 'bottom'
      | number
      | string;
    depthOffset: number;
    maxWidth: number;
    textAlign: 'left' | 'right' | 'center' | 'justify';
    letterSpacing: number;
    /** Render-order hint preserved by Three.js. */
    renderOrder: number;
    /** Trigger atlas/font loading and prepare for next frame. */
    sync(callback?: () => void): void;
    /** Free GPU resources. */
    dispose(): void;
  }
}
