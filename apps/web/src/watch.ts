/**
 * The camera of a watching page (`#<episode>&watch`): one fixed three-quarter view from the
 * front right and above that shows both baskets and, during the wash, the water in the tub.
 * The direction never changes; the distance is fitted to the frame every time it is drawn, so
 * that the machine fills about 85% of the limiting side whatever the shape of the frame.
 * Display only.
 */

import type { Camera } from 'three';
import { PerspectiveCamera, Vector3 } from 'three';

/** Share of the limiting side of the frame the machine fills. */
const FILL = 0.85;

export class WatchCamera {
  private readonly target = new Vector3();
  private readonly corners: Vector3[] = [];
  private readonly toward = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly p = new Vector3();
  private ready = false;

  /** The machine to look at: the inside of the tub, metres. */
  frame(min: readonly number[], max: readonly number[]): void {
    const x0 = min[0] ?? -0.27;
    const x1 = max[0] ?? 0.27;
    // In front of the tub too: a basket pulled out for loading stays in view.
    const y0 = (min[1] ?? -0.24) - 0.3;
    const y1 = max[1] ?? 0.27;
    const z0 = (min[2] ?? 0) - 0.04;
    const z1 = (max[2] ?? 0.64) + 0.03;
    this.target.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.corners.length = 0;
    for (const x of [x0, x1]) {
      for (const y of [y0, y1]) for (const z of [z0, z1]) this.corners.push(new Vector3(x, y, z));
    }
    const az = -Math.PI / 2 + 0.3;
    const el = 0.5;
    this.toward.set(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
    this.right
      .crossVectors(new Vector3(0, 0, 1), this.toward)
      .normalize()
      .negate();
    this.up.crossVectors(this.toward, this.right).normalize().negate();
    this.ready = true;
  }

  /** Places the camera for a frame of the given aspect (width over height). */
  update(camera: Camera, controlsTarget: Vector3, aspect: number): void {
    if (!this.ready || !(aspect > 0) || !Number.isFinite(aspect)) return;
    const fov = camera instanceof PerspectiveCamera ? camera.fov : 32;
    const tanV = Math.tan((fov * Math.PI) / 360) * FILL;
    const tanH = tanV * aspect;
    // The nearest distance at which every corner is inside the frame.
    let distance = 0.2;
    for (const corner of this.corners) {
      this.p.copy(corner).sub(this.target);
      const depth = this.p.dot(this.toward);
      const needH = depth + Math.abs(this.p.dot(this.right)) / tanH;
      const needV = depth + Math.abs(this.p.dot(this.up)) / tanV;
      distance = Math.max(distance, needH, needV);
    }
    camera.position.copy(this.target).addScaledVector(this.toward, distance);
    camera.lookAt(this.target);
    if (camera instanceof PerspectiveCamera && camera.aspect !== aspect) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    }
    controlsTarget.copy(this.target);
  }
}
