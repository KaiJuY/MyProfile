// troika-three-text ships an ES module export named `Text` that extends
// THREE.Mesh — it manages its own MSDF font atlas via a webworker. We don't
// need to load a font file ourselves; the default Roboto bundled with troika
// is fine for step 05 (per playbook §171: "第一版先用 EN label, 不要硬上中文").
import { Text } from 'troika-three-text';

/**
 * Build a configured Text mesh that:
 *   - reads as off-white on dark backgrounds (no neon — CLAUDE.md aesthetic rule)
 *   - has a thin outline so it doesn't z-fight against the underlying mesh
 *   - uses a small depthOffset so it renders just in front of the mesh face
 *   - is ANCHOR_CENTER so positioning is by mesh center (easy to billboard)
 *   - is OUTSIDE the stencil mask (stencilWrite=false) — labels always show
 *     even if they hang outside the stencil window per playbook §7.
 *
 * Caller is responsible for adding the returned Text to the scene graph and
 * disposing via `text.dispose()` when removed.
 */
export interface SkillTextOptions {
  /** Final string drawn — already concatenated by the caller. */
  text: string;
  /** Em-height in world units. 0.12 reads cleanly at our HEAD_DEPTH=5. */
  fontSize?: number;
  /** Outline width as fraction of em (troika convention). */
  outlineWidth?: string;
  /** Outline color. Off-black so text-on-light still has separation. */
  outlineColor?: number;
  /** Body fill color. Off-white so it never reads as #fff bloom. */
  color?: number;
  /** depthOffset (positive = pushes BACKWARD; negative = forward). */
  depthOffset?: number;
}

export function createSkillText(opts: SkillTextOptions): Text {
  const t: Text = new Text();
  t.text = opts.text;
  t.fontSize = opts.fontSize ?? 0.12;
  // Default Roboto from troika (no external font URL needed).
  t.font = undefined as unknown as string; // unset → built-in default
  t.color = opts.color ?? 0xeeeae0; // off-white, matches site --ink-1
  t.outlineColor = opts.outlineColor ?? 0x111111;
  t.outlineWidth = opts.outlineWidth ?? '8%';
  t.outlineBlur = '0%';
  t.outlineOpacity = 0.85;
  // anchorX/anchorY 'center' → world position is the text mesh's center, which
  // makes Y-axis billboarding clean (no per-frame offset to recompute).
  t.anchorX = 'center';
  t.anchorY = 'middle';
  // depthOffset is in NDC-ish polygon-offset units. Negative pulls toward camera.
  // We want labels just in front of the mesh face so they don't z-fight.
  t.depthOffset = opts.depthOffset ?? -0.5;
  t.maxWidth = 2.4; // wrap long labels (e.g. "AI · ML · DL · 0°")
  t.textAlign = 'center';
  t.letterSpacing = 0.02;
  // Fire async font/atlas init now — sync() resolves when the GPU upload is
  // safe. We don't await it here (it'd block the caller), but we DO trigger
  // it so first-frame render isn't blank.
  t.sync();
  return t;
}
