/**
 * The camera of a watching page (`#<episode>&watch`): one fixed three-quarter view from the
 * front right and above that shows both baskets and, during the wash, the water in the tub.
 * It does not move for the whole episode. Display only.
 */

import type { Camera } from 'three';
import { Vector3 } from 'three';

export class WatchCamera {
  private readonly target = new Vector3();
  private readonly position = new Vector3();
  private ready = false;

  /** The machine to look at: the inside of the tub, metres. */
  frame(min: readonly number[], max: readonly number[]): void {
    const x0 = min[0] ?? -0.27;
    const x1 = max[0] ?? 0.27;
    const y0 = min[1] ?? -0.24;
    const y1 = max[1] ?? 0.27;
    const z0 = min[2] ?? 0;
    const z1 = max[2] ?? 0.64;
    // A little in front of the middle of the tub, so that a basket pulled out stays in view.
    this.target.set((x0 + x1) / 2, (y0 + y1) / 2 - 0.2, z0 + (z1 - z0) * 0.4);
    const radius = Math.max(x1 - x0, z1 - z0) * 3.6;
    const az = -Math.PI / 2 + 0.3;
    const el = 0.5;
    this.position.set(
      this.target.x + radius * Math.cos(el) * Math.cos(az),
      this.target.y + radius * Math.cos(el) * Math.sin(az),
      this.target.z + radius * Math.sin(el),
    );
    this.ready = true;
  }

  update(camera: Camera, controlsTarget: Vector3): void {
    if (!this.ready) return;
    camera.position.copy(this.position);
    camera.lookAt(this.target);
    controlsTarget.copy(this.target);
  }
}
