/**
 * The turntable of a watching page (`#<episode>&turntable&item=<item id>`): one item alone on a
 * plinth, turning slowly under soft studio light, soiled as the game draws it, or as it came out
 * of the wash once the report is in. Display only.
 */

import type { Object3D, WebGLRenderer } from 'three';
import {
  Color,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Vector3,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export class Turntable {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(30, 1, 0.01, 20);
  private readonly spin = new Group();
  private readonly plinth: Mesh;
  private item: Object3D | null = null;
  private key: string | null = null;
  private fade = 1;
  private angle = 0.6;
  private distance = 0.6;
  private height = 0.1;
  private readonly look = new Vector3();

  constructor(renderer: WebGLRenderer) {
    this.scene.background = new Color('#f6f6f4');
    this.camera.up.set(0, 0, 1);
    const generator = new PMREMGenerator(renderer);
    this.scene.environment = generator.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    generator.dispose();
    this.scene.add(new HemisphereLight(0xffffff, 0xd8d8d8, 0.9));
    const key = new DirectionalLight(0xfffaf2, 2.2);
    key.position.set(0.8, -1.2, 1.6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -0.4;
    key.shadow.camera.right = 0.4;
    key.shadow.camera.top = 0.4;
    key.shadow.camera.bottom = -0.4;
    key.shadow.radius = 6;
    const rim = new DirectionalLight(0xeef4ff, 1.1);
    rim.position.set(-1.2, 1.0, 1.2);
    this.scene.add(key, rim);
    this.plinth = new Mesh(
      new CylinderGeometry(1, 1.04, 1, 64),
      new MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0 }),
    );
    this.plinth.rotation.x = Math.PI / 2;
    this.plinth.receiveShadow = true;
    this.scene.add(this.plinth, this.spin);
  }

  /**
   * Shows an item: `build` makes its object (item frame, metres, z up); `bounds` is its box.
   * `key` names what is shown (item and paint): the same key keeps the object.
   */
  show(
    key: string,
    build: () => Group,
    bounds: { min: readonly number[]; max: readonly number[] },
  ): void {
    if (this.key === key) return;
    const fresh = this.key?.split('|')[0] !== key.split('|')[0];
    this.key = key;
    if (this.item !== null) this.spin.remove(this.item);
    const object = build();
    object.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    const [x0, y0, z0] = [bounds.min[0] ?? 0, bounds.min[1] ?? 0, bounds.min[2] ?? 0];
    const [x1, y1, z1] = [bounds.max[0] ?? 0, bounds.max[1] ?? 0, bounds.max[2] ?? 0];
    // Centred on the turning axis, standing on the plinth.
    object.position.set(-(x0 + x1) / 2, -(y0 + y1) / 2, -z0);
    object.visible = true;
    this.item = object;
    this.spin.add(object);
    const size = Math.max(x1 - x0, y1 - y0, z1 - z0, 0.03);
    const reach = Math.max(x1 - x0, y1 - y0) / 2;
    this.plinth.scale.set(reach * 1.12 + 0.008, 0.012, reach * 1.12 + 0.008);
    this.plinth.position.set(0, 0, -0.006);
    this.height = z1 - z0;
    this.distance = size * 2.05 + 0.04;
    this.look.set(0, 0, this.height * 0.45);
    if (fresh) this.fade = 0;
  }

  /** Nothing to show. */
  clear(): void {
    if (this.item !== null) this.spin.remove(this.item);
    this.item = null;
    this.key = null;
  }

  update(dt: number, aspect: number): void {
    this.angle += dt * 0.45;
    this.spin.rotation.z = this.angle;
    this.fade = Math.min(1, this.fade + dt * 2.5);
    // A short drop into place for a new item.
    this.spin.position.z = (1 - this.fade) * (1 - this.fade) * this.height * 0.6;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    const el = 0.62;
    this.camera.position.set(
      0,
      -this.distance * Math.cos(el),
      this.look.z + this.distance * Math.sin(el),
    );
    this.camera.lookAt(this.look);
  }
}
