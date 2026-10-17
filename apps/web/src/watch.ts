/**
 * The camera of a watching page (`#<episode>&watch`): a slow sway about the machine, a short
 * close look at the item just placed, and a lower, closer look into the tub while it washes.
 * Display only.
 */

import type { Camera } from 'three';
import { Vector3 } from 'three';

export class WatchCamera {
  private t = 0;
  private readonly centre = new Vector3();
  private radius = 1.9;
  private az0 = -Math.PI / 2 - 0.5;
  private el0 = 0.5;
  private readonly target = new Vector3();
  private currentRadius = 1.9;
  private focus: { point: Vector3; until: number } | null = null;
  private ready = false;

  /** The machine to circle: the middle of the tub and its size, metres. */
  frame(min: readonly number[], max: readonly number[]): void {
    this.centre.set(
      ((min[0] ?? -0.27) + (max[0] ?? 0.27)) / 2,
      ((min[1] ?? -0.24) + (max[1] ?? 0.27)) / 2,
      ((min[2] ?? 0) + (max[2] ?? 0.64)) * 0.42,
    );
    const size = Math.max((max[0] ?? 0.27) - (min[0] ?? -0.27), (max[2] ?? 0.64) - (min[2] ?? 0));
    this.radius = size * 3.7;
    if (!this.ready) {
      this.target.copy(this.centre);
      this.currentRadius = this.radius;
      this.ready = true;
    }
  }

  /** Looks closely at a point (metres) for a few seconds. */
  focusOn(point: Vector3, seconds = 3.5): void {
    this.focus = { point: point.clone(), until: this.t + seconds };
  }

  update(dt: number, camera: Camera, controlsTarget: Vector3, washing: boolean): void {
    if (!this.ready) return;
    this.t += dt;
    const focus = this.focus !== null && this.t < this.focus.until ? this.focus : null;
    if (focus === null) this.focus = null;
    const wantTarget = focus !== null ? focus.point : this.centre;
    const wantRadius =
      focus !== null ? this.radius * 0.5 : washing ? this.radius * 0.66 : this.radius;
    const k = 1 - Math.exp(-dt * 1.4);
    this.target.lerp(wantTarget, k);
    this.currentRadius += (wantRadius - this.currentRadius) * k;
    const az = this.az0 + 0.55 * Math.sin((2 * Math.PI * this.t) / 46);
    const el = (washing ? this.el0 - 0.1 : this.el0) + 0.08 * Math.sin((2 * Math.PI * this.t) / 29);
    camera.position.set(
      this.target.x + this.currentRadius * Math.cos(el) * Math.cos(az),
      this.target.y + this.currentRadius * Math.cos(el) * Math.sin(az),
      this.target.z + this.currentRadius * Math.sin(el),
    );
    camera.lookAt(this.target);
    controlsTarget.copy(this.target);
  }
}
