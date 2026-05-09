import * as THREE from 'three';

/**
 * Lightweight scene registry. We keep ONE THREE.Scene (cheaper than juggling
 * multiple, and Three doesn't really support cross-scene objects anyway) but
 * register named "scene modules" — each owning their own meshes/lights and an
 * `update(dt, scrollProgress)` hook.
 *
 * SceneManager calls update on every registered module each frame. Modules can
 * be enabled/disabled to control which sections are "live" — e.g., the toolkit
 * scene's GPGPU compute is expensive, no point ticking it while the user is on
 * the hero section.
 */

export interface SceneModule {
  readonly name: string;
  /** Called once on registration. Add meshes/lights here, NOT in the constructor. */
  init(scene: THREE.Scene): void | Promise<void>;
  /** Called every frame while enabled. */
  update(dt: number, scrollProgress: number): void;
  /** Called when un-registered or app disposed. Clean up GPU resources. */
  dispose(scene: THREE.Scene): void;
}

export class SceneManager {
  readonly scene: THREE.Scene;
  private modules: Map<string, { mod: SceneModule; enabled: boolean }> = new Map();

  constructor() {
    this.scene = new THREE.Scene();
  }

  async register(mod: SceneModule, enabled: boolean = true): Promise<void> {
    if (this.modules.has(mod.name)) {
      throw new Error(`SceneModule "${mod.name}" already registered`);
    }
    await mod.init(this.scene);
    this.modules.set(mod.name, { mod, enabled });
  }

  setEnabled(name: string, enabled: boolean): void {
    const entry = this.modules.get(name);
    if (entry) entry.enabled = enabled;
  }

  update(dt: number, scrollProgress: number): void {
    for (const { mod, enabled } of this.modules.values()) {
      if (enabled) mod.update(dt, scrollProgress);
    }
  }

  unregister(name: string): void {
    const entry = this.modules.get(name);
    if (!entry) return;
    entry.mod.dispose(this.scene);
    this.modules.delete(name);
  }

  dispose(): void {
    for (const name of [...this.modules.keys()]) {
      this.unregister(name);
    }
  }
}
