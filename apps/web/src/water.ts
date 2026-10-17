/**
 * Cosmetic water for the wash: the spray arms turn, jets fan out of their nozzles, droplets
 * fall, splash off the load and the walls and run down them, a haze of mist and steam hangs in
 * the tub and a pool shimmers in the sump, rising and falling as the cycle fills and drains.
 *
 * Purely for the eye. Nothing here is sent to the server or read by the game: the arms are
 * turned on the page only (their pose is put back when the water stops), and the particles are
 * a toy physics of their own, seeded from `Math.random`. The simulation that scores the wash
 * never sees any of it.
 *
 * Scene units are metres in the tub frame, z up (as `@spotless/render`).
 */

import { findMachine } from '@spotless/machine';
import type { MachineSpec, SprayArmSpec } from '@spotless/machine';
import type { Camera, Object3D, Scene } from 'three';
import {
  AdditiveBlending,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  NormalBlending,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';

/** A pose as the page draws it: millimetres, `quat_wxyz`. */
interface PoseInput {
  readonly position_mm: readonly [number, number, number];
  readonly quat_wxyz: readonly [number, number, number, number];
}

/** What the page says of the wash, each frame. */
export interface WashSignal {
  /** The job's status as the page knows it; null when it knows of no job. */
  readonly status: 'queued' | 'running' | 'done' | 'failed' | null;
  /** How far the wash has got as the progress bar shows it, 0 to 1. */
  readonly fraction: number;
  /** True while the episode's phase is `washing`. */
  readonly washing: boolean;
}

/** How strongly each effect plays at a point of the cosmetic cycle. All 0 to 1. */
export interface CycleEnvelope {
  /** The pump: jets and the turning of the arms. */
  readonly spray: number;
  /** How full the sump is. */
  readonly pool: number;
  /** Steam and mist. */
  readonly steam: number;
  /** Name of the step, for a caption. */
  readonly step: 'fill' | 'wash' | 'drain' | 'rinse' | 'dry';
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The cosmetic cycle: fill, wash, drain, refill, rinse, drain, dry, by position `c` from 0 to 1.
 * It is a look, not the programme: the wash is computed, not run in real time.
 */
export function cycleEnvelope(c: number): CycleEnvelope {
  const x = Math.max(0, Math.min(1, c));
  if (x < 0.08) {
    return {
      spray: 0.35 + 0.65 * smooth(0.02, 0.08, x),
      pool: smooth(0, 0.07, x),
      steam: 0.15 + x * 2,
      step: 'fill',
    };
  }
  if (x < 0.5) return { spray: 1, pool: 1, steam: 0.3 + 0.3 * smooth(0.08, 0.5, x), step: 'wash' };
  if (x < 0.55) {
    return {
      spray: 1 - 0.8 * smooth(0.5, 0.52, x),
      pool: 1 - 0.85 * smooth(0.5, 0.55, x),
      steam: 0.6,
      step: 'drain',
    };
  }
  if (x < 0.6) {
    return {
      spray: 0.2 + 0.8 * smooth(0.56, 0.6, x),
      pool: 0.15 + 0.85 * smooth(0.55, 0.6, x),
      steam: 0.55,
      step: 'rinse',
    };
  }
  if (x < 0.86)
    return { spray: 1, pool: 1, steam: 0.55 + 0.35 * smooth(0.6, 0.86, x), step: 'rinse' };
  if (x < 0.91) {
    return {
      spray: 1 - smooth(0.86, 0.88, x),
      pool: 1 - smooth(0.86, 0.91, x),
      steam: 0.9,
      step: 'drain',
    };
  }
  return { spray: 0, pool: 0, steam: 1 - 0.75 * smooth(0.93, 1, x), step: 'dry' };
}

/**
 * Where the cosmetic cycle stands for a wash in progress: the progress bar carried onto fill,
 * wash, drain, rinse, never into the final drain and dry, which play once the wash is done.
 * At least as far as a few seconds of filling would have got, so that a wash whose progress
 * stays at nought for a while still sprays.
 */
export function cycleOfWash(fraction: number, activeSeconds: number): number {
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  const byProgress = 0.04 + f * 0.82;
  const byTime = Math.min(0.3, (0.1 * activeSeconds) / 6);
  return Math.min(0.86, Math.max(byProgress, byTime));
}

// ---------------------------------------------------------------------------------------------
// Nozzles
// ---------------------------------------------------------------------------------------------

/** One nozzle of a sprayer, in the frame of the part that carries it. */
interface Nozzle {
  readonly position: Vector3;
  readonly direction: Vector3;
  /** Half the angle of the fan the jet spreads into, radians, and the axis it spreads about. */
  readonly fan: number;
  readonly fanAxis: Vector3;
  /** Jet speed, m/s. */
  readonly speed: number;
  /** Particles a second at full spray. */
  readonly rate: number;
}

interface Sprayer {
  /** The id of the machine part that carries it; null for a sprayer fixed to the tub. */
  readonly partId: string | null;
  /** Where a fixed sprayer is, tub frame. */
  readonly fixedAt: Vector3 | null;
  readonly nozzles: readonly Nozzle[];
  /** Turning speed at full spray, rad/s, signed by the sense (+z right-handed); 0 for fixed. */
  readonly omega: number;
  /** Accumulated emission, one per nozzle. */
  readonly carry: Float64Array;
  angle: number;
  speed: number;
}

/** Visual speed-up of the arms over their design speed: they read better a little quicker. */
const ARM_SPIN_GAIN = 1.6;

/** Nozzles of a spray arm from its specification, in the arm frame (see machine/geometry/arm.ts). */
function armNozzles(arm: SprayArmSpec): Nozzle[] {
  const senseSign = arm.sense === 'cw' ? -1 : 1;
  const out: Nozzle[] = [];
  for (const n of arm.nozzles) {
    const side = n.blade === '-' ? -1 : n.blade === '+' ? 1 : 0;
    const radius = side === 0 ? 0 : n.radius;
    const zUp = (arm.nozzleUpZ ?? arm.topFaceZ) - arm.topFaceZ;
    const zDown = (arm.nozzleDownZ ?? arm.bladeUndersideZ) - arm.topFaceZ;
    const z = n.face === 'underside' ? zDown : zUp;
    // Radially outward along the blade, and trailing: against the blade's travel.
    const radial = new Vector3(side === 0 ? 1 : side, 0, 0);
    const trailing = new Vector3(0, -senseSign * (side === 0 ? 1 : side), 0);
    const direction = new Vector3()
      .addScaledVector(radial, Math.cos(n.rho) * Math.cos(n.theta))
      .addScaledVector(trailing, Math.cos(n.rho) * Math.sin(n.theta))
      .add(new Vector3(0, 0, Math.sin(n.rho)))
      .normalize();
    const oblong = n.shape !== 'round';
    const fanHalf = n.fan !== null ? n.fan.angle / 2 : oblong ? 0.22 : 0.05;
    // The fan spreads along the long axis of the opening (radial when not recorded).
    const along = n.slotAxis === 'tangential' ? trailing : radial;
    const fanAxis = new Vector3().crossVectors(direction, along);
    if (fanAxis.lengthSq() < 1e-6) fanAxis.set(0, 1, 0);
    fanAxis.normalize();
    out.push({
      position: new Vector3(side * radius, 0, z),
      direction,
      fan: fanHalf,
      fanAxis,
      speed: n.face === 'underside' ? 2.6 : 3.7 + 0.6 * Math.sin(n.rho),
      rate: oblong ? 640 : 460,
    });
  }
  return out;
}

/** Nozzles of an arm whose specification is not known: a row on each blade, up and slightly back. */
function fallbackNozzles(tipRadius: number): Nozzle[] {
  const out: Nozzle[] = [];
  for (const side of [1, -1]) {
    for (let k = 1; k <= 5; k++) {
      const r = (tipRadius * k) / 5.4;
      const lean = k === 5 ? 0.5 : 0.08 * k;
      const direction = new Vector3(
        side * Math.sin(lean) * 0.4,
        -side * Math.sin(lean),
        Math.cos(lean),
      ).normalize();
      out.push({
        position: new Vector3(side * r, 0, 0),
        direction,
        fan: 0.12,
        fanAxis: new Vector3(0, 1, 0),
        speed: 3.9,
        rate: 380,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------

const STREAK_VERTEX = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iData;
uniform float uStretch;
uniform float uMinPx;
uniform float uScale;
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
varying float vKind;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  vec3 vv = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
  float depth = max(0.05, -mv.z);
  float minW = uMinPx * depth / uScale;
  float w = max(iData.x, minW);
  vec2 d2 = vv.xy;
  float sp = length(d2);
  vec2 dir = sp > 1e-5 ? d2 / sp : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  float len = max(w, sp * uStretch);
  // The head of the streak is at the particle; it trails back along its motion.
  vec2 off = dir * (position.x * 0.5 - 0.42) * len + perp * position.y * w * 0.5;
  mv.xy += off;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy;
  vAlpha = iData.y * sqrt(min(1.0, iData.x / w));
  vSeed = iData.z;
  vKind = iData.w;
}
`;

const STREAK_FRAGMENT = /* glsl */ `
uniform vec3 uDeep;
uniform vec3 uLight;
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
varying float vKind;
void main() {
  float across = 1.0 - vUv.y * vUv.y;
  float along = smoothstep(-1.0, -0.1, vUv.x) * (1.0 - smoothstep(0.75, 1.0, vUv.x));
  float a = vAlpha * pow(across, 1.4) * along;
  if (a < 0.004) discard;
  vec3 colour = mix(uDeep, uLight, pow(across, 4.0) * (0.55 + 0.45 * smoothstep(-0.2, 0.9, vUv.x)));
  gl_FragColor = vec4(colour, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const GLINT_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uGlint;
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
varying float vKind;
void main() {
  float phase = uTime * (9.0 + vSeed * 23.0) + vSeed * 61.0;
  float twinkle = pow(max(0.0, sin(phase)), 18.0);
  float spot = exp(-(pow(vUv.x - 0.6, 2.0) * 9.0 + vUv.y * vUv.y * 5.0));
  float k = vKind > 0.5 ? 1.0 : 0.45;
  float g = twinkle * spot * uGlint * k * min(1.0, vAlpha * 3.0);
  if (g < 0.004) discard;
  gl_FragColor = vec4(vec3(1.0, 0.98, 0.92) * g, g);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const MIST_VERTEX = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
uniform float uScale;
uniform float uIntensity;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = min(600.0, aSize * uScale / max(0.05, -mv.z));
  gl_Position = projectionMatrix * mv;
  vA = aAlpha * uIntensity;
}
`;

const MIST_FRAGMENT = /* glsl */ `
uniform vec3 uColour;
varying float vA;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = dot(c, c);
  if (r > 1.0) discard;
  float a = vA * (1.0 - r) * (1.0 - r);
  gl_FragColor = vec4(uColour, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const POOL_VERTEX = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const POOL_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uChop;
uniform float uOpacity;
uniform vec3 uDeep;
uniform vec3 uSky;
uniform vec3 uSun;
uniform vec2 uCentre;
varying vec3 vWorld;
// Height of the surface (metres) and its slope, from a few travelling waves and rings.
vec3 wave(vec2 p, vec2 k, float speed, float amp) {
  float ph = dot(p, k) - uTime * speed;
  return vec3(amp * sin(ph), amp * cos(ph) * k);
}
void main() {
  vec2 p = vWorld.xy;
  vec3 h = vec3(0.0);
  h += wave(p, vec2(61.0, 23.0), 3.1, 0.0009);
  h += wave(p, vec2(-37.0, 71.0), 2.3, 0.0008);
  h += wave(p, vec2(113.0, -89.0), 5.7, 0.00035);
  h += wave(p, vec2(-151.0, -47.0), 6.9, 0.00028);
  vec2 d = p - uCentre;
  float r = length(d) + 1e-4;
  float ring = r * 140.0 - uTime * 9.0;
  h += vec3(0.0006 * sin(ring), 0.0006 * 140.0 * cos(ring) * d / r) * smoothstep(0.32, 0.02, r);
  vec2 slope = h.yz * (0.35 + uChop);
  vec3 n = normalize(vec3(-slope, 1.0));
  vec3 view = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - max(0.0, dot(n, view)), 3.0);
  vec3 hv = normalize(normalize(uSun) + view);
  float spec = pow(max(0.0, dot(n, hv)), 260.0) * 2.2 + pow(max(0.0, dot(n, hv)), 40.0) * 0.18;
  float caustic = pow(1.0 - abs(sin(h.x * 2600.0 + p.x * 40.0)), 10.0) * 0.18 * (0.4 + uChop);
  vec3 colour = mix(uDeep, uSky, 0.25 + 0.75 * fres) + vec3(caustic) + vec3(spec);
  float a = uOpacity * clamp(0.5 + 0.4 * fres + spec + caustic, 0.0, 1.0);
  if (a < 0.004) discard;
  gl_FragColor = vec4(colour, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------------------------
// The effect
// ---------------------------------------------------------------------------------------------

/** Most particles alive at once. */
export const WATER_PARTICLES_MAX = 9000;
const MIST_COUNT = 320;
const GRAVITY = 9.81;

/** Kinds of particle. */
const JET = 0;
const DROP = 1;
const RUN = 2;

/** Seconds of a demonstration cycle. */
const DEMO_CYCLE_S = 48;

/** The water of the wash, added to a scene. */
export class WaterFx {
  readonly root = new Group();
  private sprayers: Sprayer[] = [];
  private readonly arms = new Map<string, Object3D>();
  private tubMin = new Vector3(-0.27, -0.235, 0);
  private tubMax = new Vector3(0.27, 0.265, 0.64);
  private floorZ = 0;
  // Particles: struct of arrays, swap-removed.
  private count = 0;
  private readonly pos = new Float32Array(3 * WATER_PARTICLES_MAX);
  private readonly vel = new Float32Array(3 * WATER_PARTICLES_MAX);
  private readonly life = new Float32Array(WATER_PARTICLES_MAX);
  private readonly maxLife = new Float32Array(WATER_PARTICLES_MAX);
  private readonly size = new Float32Array(WATER_PARTICLES_MAX);
  private readonly kind = new Uint8Array(WATER_PARTICLES_MAX);
  private readonly seed = new Float32Array(WATER_PARTICLES_MAX);
  private readonly alpha = new Float32Array(WATER_PARTICLES_MAX);
  private readonly iPos: InstancedBufferAttribute;
  private readonly iVel: InstancedBufferAttribute;
  private readonly iData: InstancedBufferAttribute;
  private readonly streaks: InstancedBufferGeometry;
  private readonly streakMaterial: ShaderMaterial;
  private readonly glintMaterial: ShaderMaterial;
  private readonly mist: Points;
  private readonly mistMaterial: ShaderMaterial;
  private readonly mistPos: Float32Array;
  private readonly mistVel: Float32Array;
  private readonly pool: Mesh;
  private readonly poolMaterial: ShaderMaterial;
  // The cycle.
  private demoOn = false;
  private demoT = 0;
  private demoFixed: number | null = null;
  private activeSeconds = 0;
  private wasActive = false;
  private finishing = false;
  private cycle = 0;
  private master = 0;
  private env = { spray: 0, pool: 0, steam: 0 };
  private time = 0;
  private boxes: Box3[] = [];
  private boxesAge = 1e9;
  private spinning = false;
  private readonly m = new Matrix4();
  private readonly v1 = new Vector3();
  private readonly v2 = new Vector3();
  private readonly q1 = new Quaternion();
  private readonly q2 = new Quaternion();
  private readonly zAxis = new Vector3(0, 0, 1);

  constructor(private readonly scene: Scene) {
    this.root.name = 'water_fx';
    // Streaks: a quad drawn once per particle, stretched along its motion on the screen.
    const quad = new InstancedBufferGeometry();
    quad.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
    );
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    this.iPos = new InstancedBufferAttribute(new Float32Array(3 * WATER_PARTICLES_MAX), 3);
    this.iVel = new InstancedBufferAttribute(new Float32Array(3 * WATER_PARTICLES_MAX), 3);
    this.iData = new InstancedBufferAttribute(new Float32Array(4 * WATER_PARTICLES_MAX), 4);
    for (const a of [this.iPos, this.iVel, this.iData]) a.setUsage(DynamicDrawUsage);
    quad.setAttribute('iPos', this.iPos);
    quad.setAttribute('iVel', this.iVel);
    quad.setAttribute('iData', this.iData);
    quad.instanceCount = 0;
    this.streaks = quad;
    const shared = {
      uStretch: { value: 0.024 },
      uMinPx: { value: 1.6 },
      uScale: { value: 1000 },
      uTime: { value: 0 },
    };
    this.streakMaterial = new ShaderMaterial({
      vertexShader: STREAK_VERTEX,
      fragmentShader: STREAK_FRAGMENT,
      uniforms: {
        ...shared,
        uDeep: { value: new Color(0.42, 0.62, 0.86) },
        uLight: { value: new Color(0.93, 0.98, 1.0) },
      },
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
    });
    this.glintMaterial = new ShaderMaterial({
      vertexShader: STREAK_VERTEX,
      fragmentShader: GLINT_FRAGMENT,
      uniforms: { ...shared, uGlint: { value: 2.2 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const body = new Mesh(quad, this.streakMaterial);
    const glints = new Mesh(quad, this.glintMaterial);
    for (const mesh of [body, glints]) mesh.frustumCulled = false;
    body.renderOrder = 12;
    glints.renderOrder = 13;
    // Mist and steam: soft round puffs.
    const mistGeometry = new BufferGeometry();
    this.mistPos = new Float32Array(3 * MIST_COUNT);
    this.mistVel = new Float32Array(3 * MIST_COUNT);
    const mistSize = new Float32Array(MIST_COUNT);
    const mistAlpha = new Float32Array(MIST_COUNT);
    for (let i = 0; i < MIST_COUNT; i++) {
      mistSize[i] = 0.05 + Math.random() * 0.11;
      mistAlpha[i] = 0.035 + Math.random() * 0.05;
    }
    mistGeometry.setAttribute(
      'position',
      new BufferAttribute(this.mistPos, 3).setUsage(DynamicDrawUsage),
    );
    mistGeometry.setAttribute('aSize', new BufferAttribute(mistSize, 1));
    mistGeometry.setAttribute('aAlpha', new BufferAttribute(mistAlpha, 1));
    this.mistMaterial = new ShaderMaterial({
      vertexShader: MIST_VERTEX,
      fragmentShader: MIST_FRAGMENT,
      uniforms: {
        uScale: shared.uScale,
        uIntensity: { value: 0 },
        uColour: { value: new Color(0.93, 0.96, 1.0) },
      },
      transparent: true,
      depthWrite: false,
    });
    this.mist = new Points(mistGeometry, this.mistMaterial);
    this.mist.frustumCulled = false;
    this.mist.renderOrder = 14;
    // The pool in the sump.
    this.poolMaterial = new ShaderMaterial({
      vertexShader: POOL_VERTEX,
      fragmentShader: POOL_FRAGMENT,
      uniforms: {
        uTime: shared.uTime,
        uChop: { value: 0 },
        uOpacity: { value: 0 },
        uDeep: { value: new Color(0.2, 0.42, 0.55) },
        uSky: { value: new Color(0.78, 0.9, 0.98) },
        uSun: { value: new Vector3(0.9, -1.6, 2.4) },
        uCentre: { value: new Vector3(0, 0, 0) },
      },
      transparent: true,
      depthWrite: false,
    });
    this.pool = new Mesh(new PlaneGeometry(1, 1, 1, 1), this.poolMaterial);
    this.pool.renderOrder = 11;
    this.pool.name = 'water_pool';
    this.root.add(this.pool, body, glints, this.mist);
    this.root.visible = false;
    scene.add(this.root);
    this.resetMist();
  }

  /**
   * The machine the water plays in: its catalogue id (for the nozzles of its arms), the ids of
   * its parts with their roles, and the inside of the tub, millimetres.
   */
  setMachine(
    machineId: string,
    parts: readonly { readonly id: string; readonly role: string }[],
    tubMinMm: readonly number[],
    tubMaxMm: readonly number[],
  ): void {
    this.restoreArms(null);
    this.arms.clear();
    this.tubMin.set(
      (tubMinMm[0] ?? -270) / 1000,
      (tubMinMm[1] ?? -235) / 1000,
      (tubMinMm[2] ?? 0) / 1000,
    );
    this.tubMax.set(
      (tubMaxMm[0] ?? 270) / 1000,
      (tubMaxMm[1] ?? 265) / 1000,
      (tubMaxMm[2] ?? 640) / 1000,
    );
    this.floorZ = this.tubMin.z;
    const spec: MachineSpec | undefined = findMachine(machineId);
    const sprayers: Sprayer[] = [];
    const armParts = parts.filter((p) => p.role === 'arm' || /_arm$/.test(p.id));
    for (const part of armParts) {
      const levelId = part.id.replace(/_arm$/, '');
      const level = spec?.sprayLevels.find((l) => l.id === levelId);
      const arm = level?.kind === 'arm' ? level : null;
      const nozzles = arm !== null ? armNozzles(arm) : fallbackNozzles(0.2);
      const sense = arm?.sense === 'cw' ? -1 : 1;
      const omega = sense * (arm?.designSpeed ?? 4) * ARM_SPIN_GAIN;
      sprayers.push({
        partId: part.id,
        fixedAt: null,
        nozzles,
        omega,
        carry: new Float64Array(nozzles.length),
        angle: 0,
        speed: 0,
      });
    }
    // A sprayer fixed to the roof of the tub (no part of its own): a head spraying downwards.
    for (const level of spec?.sprayLevels ?? []) {
      if (level.kind === 'arm' || level.mount.kind !== 'tub') continue;
      const nozzles: Nozzle[] = [];
      for (let k = 0; k < 6; k++) {
        const az = (2 * Math.PI * k) / 6;
        nozzles.push({
          position: new Vector3(0, 0, 0),
          direction: new Vector3(Math.cos(az) * 0.45, Math.sin(az) * 0.45, -1).normalize(),
          fan: 0.3,
          fanAxis: new Vector3(-Math.sin(az), Math.cos(az), 0),
          speed: 2.2,
          rate: 110,
        });
      }
      sprayers.push({
        partId: null,
        fixedAt: new Vector3(level.axis[0], level.axis[1], this.tubMax.z - 0.012),
        nozzles,
        omega: 0,
        carry: new Float64Array(nozzles.length),
        angle: 0,
        speed: 0,
      });
    }
    this.sprayers = sprayers;
    // The pool covers the floor of the tub, a little in from its walls.
    const w = this.tubMax.x - this.tubMin.x - 0.006;
    const d = this.tubMax.y - this.tubMin.y - 0.006;
    this.pool.scale.set(w, d, 1);
    this.pool.position.set(
      (this.tubMin.x + this.tubMax.x) / 2,
      (this.tubMin.y + this.tubMax.y) / 2,
      this.floorZ,
    );
    (this.poolMaterial.uniforms['uCentre']?.value as Vector3).set(
      (this.tubMin.x + this.tubMax.x) / 2,
      (this.tubMin.y + this.tubMax.y) / 2,
      0,
    );
    this.count = 0;
    this.resetMist();
  }

  /** Deepens the colour of the water, for a light backdrop. */
  setDeepTint(r: number, g: number, b: number): void {
    (this.streakMaterial.uniforms['uDeep']?.value as Color).setRGB(r, g, b);
    (this.poolMaterial.uniforms['uDeep']?.value as Color).setRGB(r * 0.6, g * 0.75, b * 0.75);
  }

  /** Whether the demonstration plays (without a wash). */
  get demo(): boolean {
    return this.demoOn;
  }

  /**
   * Plays the water without a wash: looping through the cycle, or held at one point of it
   * (`at`, 0 to 1) for a picture.
   */
  setDemo(on: boolean, at: number | null = null): void {
    this.demoOn = on;
    this.demoFixed = at;
    if (on && at === null) this.demoT = 0.12 * DEMO_CYCLE_S;
  }

  /** Where the cosmetic cycle stands and how strongly the water plays, for a caption or a check. */
  status(): { cycle: number; master: number; particles: number; step: CycleEnvelope['step'] } {
    return {
      cycle: this.cycle,
      master: this.master,
      particles: this.count,
      step: cycleEnvelope(this.cycle).step,
    };
  }

  /**
   * One frame. `parts` are the poses the arms are drawn at now (the page's); `heightPx` the
   * height of the drawing buffer, for sizes in pixels.
   */
  update(
    dt: number,
    signal: WashSignal,
    parts: { readonly [id: string]: PoseInput },
    camera: Camera,
    heightPx: number,
  ): void {
    const step = Math.min(dt, 1 / 30);
    this.time += dt;
    this.advanceCycle(dt, signal);
    if (this.master < 0.001 && this.count === 0) {
      this.root.visible = false;
      if (this.spinning) this.restoreArms(parts);
      return;
    }
    this.root.visible = true;
    const e = cycleEnvelope(this.cycle);
    const k = 1 - Math.exp(-dt * 3);
    this.env.spray += (e.spray * this.master - this.env.spray) * k;
    this.env.pool += (e.pool * this.master - this.env.pool) * (1 - Math.exp(-dt * 1.2));
    this.env.steam += (e.steam * this.master - this.env.steam) * (1 - Math.exp(-dt * 0.8));
    const scale =
      camera instanceof PerspectiveCamera
        ? heightPx / (2 * Math.tan((camera.fov * Math.PI) / 360))
        : heightPx / 2;
    for (const material of [this.streakMaterial, this.glintMaterial, this.mistMaterial]) {
      const u = material.uniforms;
      if (u['uScale'] !== undefined) u['uScale'].value = scale;
      if (u['uTime'] !== undefined) u['uTime'].value = this.time;
    }
    this.boxesAge += dt;
    if (this.boxesAge > 0.5) this.collectBoxes();
    this.spinArms(dt, parts);
    // Two half steps when the frame is long: the jets are fast and the tub is small.
    const substeps = step > 1 / 50 ? 2 : 1;
    for (let s = 0; s < substeps; s++) {
      this.emit(step / substeps);
      this.simulate(step / substeps);
    }
    this.upload();
    this.updateMist(dt);
    this.updatePool();
  }

  private advanceCycle(dt: number, signal: WashSignal): void {
    if (this.demoOn) {
      this.demoT += dt;
      this.cycle = this.demoFixed ?? (this.demoT / DEMO_CYCLE_S) % 1;
      this.master = Math.min(1, this.master + dt / 1.2);
      this.wasActive = false;
      this.finishing = false;
      return;
    }
    const running = signal.status === 'queued' || signal.status === 'running';
    const active = running || (signal.washing && signal.status === null);
    if (active) {
      if (!this.wasActive) {
        this.activeSeconds = 0;
        this.cycle = 0;
      }
      this.wasActive = true;
      this.finishing = false;
      this.activeSeconds += dt;
      const target =
        signal.status === 'queued'
          ? Math.min(0.06, (0.06 * this.activeSeconds) / 8)
          : cycleOfWash(signal.fraction, this.activeSeconds);
      // Never backwards; catches up gently when the progress jumps.
      if (target > this.cycle) this.cycle += (target - this.cycle) * Math.min(1, dt * 0.9);
      this.master = Math.min(1, this.master + dt / 1.5);
      return;
    }
    if (this.wasActive && signal.status !== 'failed') {
      // The wash has ended: the last drain and the drying play out, then the water fades.
      this.wasActive = false;
      this.finishing = true;
      this.cycle = Math.max(this.cycle, 0.86);
    }
    if (this.finishing) {
      this.cycle = Math.min(1, this.cycle + dt * 0.022);
      if (this.cycle >= 1) this.finishing = false;
      return;
    }
    this.wasActive = false;
    this.master = Math.max(0, this.master - dt / 1.8);
  }

  /** The bounding boxes of the items in the machine, in which water splashes. */
  private collectBoxes(): void {
    this.boxesAge = 0;
    const boxes: Box3[] = [];
    const visit = (object: Object3D): void => {
      if (typeof object.userData['itemId'] === 'string') {
        if (object.visible) {
          const box = new Box3().setFromObject(object);
          // Only what is inside the tub; slightly in from the box, which is generous.
          if (!box.isEmpty() && box.max.z > this.floorZ && box.min.y < this.tubMax.y) {
            box.expandByScalar(-0.004);
            boxes.push(box);
          }
        }
        return;
      }
      for (const child of object.children) visit(child);
    };
    for (const child of this.scene.children) if (child !== this.root) visit(child);
    this.boxes = boxes;
  }

  private armObject(id: string): Object3D | null {
    let object = this.arms.get(id) ?? null;
    if (object === null || object.parent === null) {
      object = this.scene.getObjectByName(id) ?? null;
      if (object !== null) this.arms.set(id, object);
    }
    return object;
  }

  /** Turns the arms about their own z axes, from the pose the page draws them at. */
  private spinArms(dt: number, parts: { readonly [id: string]: PoseInput }): void {
    for (const sprayer of this.sprayers) {
      if (sprayer.partId === null) continue;
      const target = sprayer.omega * this.env.spray;
      sprayer.speed += (target - sprayer.speed) * (1 - Math.exp(-dt * 1.6));
      sprayer.angle = (sprayer.angle + sprayer.speed * dt) % (2 * Math.PI);
      const object = this.armObject(sprayer.partId);
      if (object === null) continue;
      const pose = parts[sprayer.partId];
      if (pose !== undefined) {
        const [w, x, y, z] = pose.quat_wxyz;
        this.q1.set(x, y, z, w).normalize();
        object.position.set(
          pose.position_mm[0] / 1000,
          pose.position_mm[1] / 1000,
          pose.position_mm[2] / 1000,
        );
      } else {
        this.q1.copy(object.quaternion);
        if (!this.spinning) object.userData['waterBase'] = object.quaternion.clone();
        const base = object.userData['waterBase'];
        if (base instanceof Quaternion) this.q1.copy(base);
      }
      object.quaternion.copy(this.q1).multiply(this.q2.setFromAxisAngle(this.zAxis, sprayer.angle));
      object.updateMatrixWorld(true);
    }
    this.spinning = true;
  }

  /** Puts the arms back at the pose the page draws them at. */
  private restoreArms(parts: { readonly [id: string]: PoseInput } | null): void {
    for (const sprayer of this.sprayers) {
      if (sprayer.partId === null) continue;
      sprayer.angle = 0;
      sprayer.speed = 0;
      const object = this.armObject(sprayer.partId);
      if (object === null) continue;
      const pose = parts?.[sprayer.partId];
      if (pose !== undefined) {
        const [w, x, y, z] = pose.quat_wxyz;
        object.quaternion.set(x, y, z, w).normalize();
      } else if (object.userData['waterBase'] instanceof Quaternion) {
        object.quaternion.copy(object.userData['waterBase']);
      }
      delete object.userData['waterBase'];
    }
    this.spinning = false;
  }

  private spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    kind: number,
    lifeS: number,
    sizeM: number,
    alpha: number,
  ): void {
    if (this.count >= WATER_PARTICLES_MAX) return;
    const i = this.count++;
    this.pos[3 * i] = x;
    this.pos[3 * i + 1] = y;
    this.pos[3 * i + 2] = z;
    this.vel[3 * i] = vx;
    this.vel[3 * i + 1] = vy;
    this.vel[3 * i + 2] = vz;
    this.kind[i] = kind;
    this.life[i] = lifeS;
    this.maxLife[i] = lifeS;
    this.size[i] = sizeM;
    this.alpha[i] = alpha;
    this.seed[i] = Math.random();
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    for (let c = 0; c < 3; c++) {
      this.pos[3 * i + c] = this.pos[3 * last + c] as number;
      this.vel[3 * i + c] = this.vel[3 * last + c] as number;
    }
    this.kind[i] = this.kind[last] as number;
    this.life[i] = this.life[last] as number;
    this.maxLife[i] = this.maxLife[last] as number;
    this.size[i] = this.size[last] as number;
    this.alpha[i] = this.alpha[last] as number;
    this.seed[i] = this.seed[last] as number;
  }

  private emit(dt: number): void {
    const spray = this.env.spray;
    if (spray < 0.02) return;
    // Leave room for the splashes: the jets take at most a third of the particles.
    const jetRoom = WATER_PARTICLES_MAX * 0.34;
    let jets = 0;
    for (let i = 0; i < this.count; i++) if (this.kind[i] === JET) jets++;
    if (jets > jetRoom) return;
    const dir = this.v1;
    const at = this.v2;
    for (const sprayer of this.sprayers) {
      let matrix: Matrix4;
      if (sprayer.partId !== null) {
        const object = this.armObject(sprayer.partId);
        if (object === null) continue;
        matrix = object.matrixWorld;
      } else if (sprayer.fixedAt !== null) {
        matrix = this.m.makeTranslation(sprayer.fixedAt.x, sprayer.fixedAt.y, sprayer.fixedAt.z);
      } else continue;
      sprayer.nozzles.forEach((nozzle, n) => {
        const rate = nozzle.rate * spray;
        let carry = (sprayer.carry[n] ?? 0) + rate * dt;
        while (carry >= 1) {
          carry -= 1;
          // Somewhere across the fan, with a little scatter.
          const spread = (Math.random() * 2 - 1) * nozzle.fan;
          dir.copy(nozzle.direction).applyAxisAngle(nozzle.fanAxis, spread);
          dir.x += (Math.random() - 0.5) * 0.018;
          dir.y += (Math.random() - 0.5) * 0.018;
          dir.z += (Math.random() - 0.5) * 0.018;
          dir.transformDirection(matrix);
          at.copy(nozzle.position).applyMatrix4(matrix);
          const speed = nozzle.speed * (0.94 + 0.12 * Math.random()) * (0.75 + 0.25 * spray);
          // Spread over the step, so that the stream is not drawn in clumps.
          const ahead = Math.random() * dt;
          this.spawn(
            at.x + dir.x * speed * ahead,
            at.y + dir.y * speed * ahead,
            at.z + dir.z * speed * ahead,
            dir.x * speed,
            dir.y * speed,
            dir.z * speed,
            JET,
            0.6,
            0.0032 + Math.random() * 0.0014,
            0.3 + 0.12 * Math.random(),
          );
        }
        sprayer.carry[n] = carry;
      });
    }
  }

  private splash(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    energy: number,
  ): void {
    const n = Math.random() < 0.55 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      // Off the surface, in a cone about its normal, with some sideways scatter.
      const sx = (Math.random() * 2 - 1) * 0.9;
      const sy = (Math.random() * 2 - 1) * 0.9;
      const sz = (Math.random() * 2 - 1) * 0.9;
      const speed = (0.35 + Math.random() * 0.9) * energy;
      this.spawn(
        x + nx * 0.003,
        y + ny * 0.003,
        z + nz * 0.003,
        (nx + sx) * speed,
        (ny + sy) * speed,
        (nz + sz) * speed + 0.2,
        DROP,
        0.35 + Math.random() * 0.5,
        0.0022 + Math.random() * 0.002,
        0.32 + 0.2 * Math.random(),
      );
    }
  }

  private simulate(dt: number): void {
    const lo = this.tubMin;
    const hi = this.tubMax;
    const pool = this.floorZ + this.poolLevel();
    const boxes = this.boxes;
    for (let i = this.count - 1; i >= 0; i--) {
      const kind = this.kind[i] as number;
      let life = (this.life[i] as number) - dt;
      if (life <= 0) {
        this.kill(i);
        continue;
      }
      this.life[i] = life;
      let vx = this.vel[3 * i] as number;
      let vy = this.vel[3 * i + 1] as number;
      let vz = this.vel[3 * i + 2] as number;
      if (kind === RUN) {
        // Running down a wall: slow, wavering, speeding up a little.
        vz = Math.max(-0.45, vz - 0.25 * dt);
        vx *= 0.9;
        vy *= 0.9;
      } else {
        vz -= GRAVITY * dt;
        if (kind === DROP) {
          vx *= 1 - 0.6 * dt;
          vy *= 1 - 0.6 * dt;
        }
      }
      let x = (this.pos[3 * i] as number) + vx * dt;
      let y = (this.pos[3 * i + 1] as number) + vy * dt;
      let z = (this.pos[3 * i + 2] as number) + vz * dt;
      // The surface it struck, if any: its outward normal.
      let nx = 0;
      let ny = 0;
      let nz = 0;
      if (x < lo.x) {
        x = lo.x + 0.002;
        nx = 1;
      } else if (x > hi.x) {
        x = hi.x - 0.002;
        nx = -1;
      } else if (y < lo.y) {
        y = lo.y + 0.002;
        ny = 1;
      } else if (y > hi.y) {
        y = hi.y - 0.002;
        ny = -1;
      } else if (z > hi.z) {
        z = hi.z - 0.002;
        nz = -1;
      } else if (z < pool) {
        z = pool + 0.001;
        nz = 1;
      } else if (kind !== RUN && boxes.length > 0) {
        for (const box of boxes) {
          if (
            x < box.min.x ||
            x > box.max.x ||
            y < box.min.y ||
            y > box.max.y ||
            z < box.min.z ||
            z > box.max.z
          )
            continue;
          // Out through the nearest face.
          const px = this.pos[3 * i] as number;
          const py = this.pos[3 * i + 1] as number;
          const pz = this.pos[3 * i + 2] as number;
          if (pz < box.min.z) {
            nz = -1;
            z = box.min.z - 0.002;
          } else if (pz > box.max.z) {
            nz = 1;
            z = box.max.z + 0.002;
          } else if (px < box.min.x) {
            nx = -1;
            x = box.min.x - 0.002;
          } else if (px > box.max.x) {
            nx = 1;
            x = box.max.x + 0.002;
          } else if (py < box.min.y) {
            ny = -1;
            y = box.min.y - 0.002;
          } else if (py > box.max.y) {
            ny = 1;
            y = box.max.y + 0.002;
          } else {
            nz = vz > 0 ? -1 : 1;
          }
          break;
        }
      }
      const struck = nx !== 0 || ny !== 0 || nz !== 0;
      if (struck) {
        const speed = Math.hypot(vx, vy, vz);
        const floor = nz === 1 && z <= pool + 0.002;
        if (kind === RUN) {
          this.kill(i);
          continue;
        }
        if (kind === JET || Math.random() < 0.35) {
          if (Math.random() < (kind === JET ? 0.42 : 0.25))
            this.splash(x, y, z, nx, ny, nz, Math.min(1.4, speed * 0.32));
        }
        const wall = nx !== 0 || ny !== 0;
        if (wall && Math.random() < (kind === JET ? 0.16 : 0.3)) {
          // Stays on the wall and runs down it.
          this.kind[i] = RUN;
          life = 0.7 + Math.random() * 1.1;
          this.life[i] = life;
          this.maxLife[i] = life;
          vx = 0;
          vy = 0;
          vz = -0.05 - Math.random() * 0.12;
          this.size[i] = 0.0026;
          this.alpha[i] = 0.3;
        } else if (nz === -1 && !floor && Math.random() < 0.3) {
          // Off the roof or the underside of something: a drop falls.
          this.kind[i] = DROP;
          vx *= 0.05;
          vy *= 0.05;
          vz = -0.1;
          life = 0.6;
          this.life[i] = life;
          this.maxLife[i] = life;
        } else {
          this.kill(i);
          continue;
        }
      }
      this.pos[3 * i] = x;
      this.pos[3 * i + 1] = y;
      this.pos[3 * i + 2] = z;
      this.vel[3 * i] = vx;
      this.vel[3 * i + 1] = vy;
      this.vel[3 * i + 2] = vz;
    }
  }

  private poolLevel(): number {
    // The sump holds a couple of centimetres; the arm stands clear above it.
    return 0.004 + 0.02 * this.env.pool;
  }

  private upload(): void {
    const n = this.count;
    const p = this.iPos.array as Float32Array;
    const v = this.iVel.array as Float32Array;
    const d = this.iData.array as Float32Array;
    p.set(this.pos.subarray(0, 3 * n));
    v.set(this.vel.subarray(0, 3 * n));
    for (let i = 0; i < n; i++) {
      const life = this.life[i] as number;
      const max = this.maxLife[i] as number;
      // Fades in at birth and out at the end of its life.
      const fade = Math.min(1, life / Math.min(0.2, max * 0.5));
      const kind = this.kind[i] as number;
      d[4 * i] = this.size[i] as number;
      d[4 * i + 1] =
        (this.alpha[i] as number) * fade * (kind === JET ? 0.6 + 0.4 * this.master : 1);
      d[4 * i + 2] = this.seed[i] as number;
      d[4 * i + 3] = kind;
    }
    this.iPos.needsUpdate = true;
    this.iVel.needsUpdate = true;
    this.iData.needsUpdate = true;
    this.iPos.clearUpdateRanges();
    this.iPos.addUpdateRange(0, 3 * n);
    this.iVel.clearUpdateRanges();
    this.iVel.addUpdateRange(0, 3 * n);
    this.iData.clearUpdateRanges();
    this.iData.addUpdateRange(0, 4 * n);
    this.streaks.instanceCount = n;
  }

  private resetMist(): void {
    for (let i = 0; i < MIST_COUNT; i++) this.placeMist(i, true);
  }

  private placeMist(i: number, anywhere: boolean): void {
    const lo = this.tubMin;
    const hi = this.tubMax;
    this.mistPos[3 * i] = lo.x + 0.04 + Math.random() * (hi.x - lo.x - 0.08);
    this.mistPos[3 * i + 1] = lo.y + 0.04 + Math.random() * (hi.y - lo.y - 0.08);
    this.mistPos[3 * i + 2] = anywhere
      ? lo.z + 0.03 + Math.random() * (hi.z - lo.z - 0.06)
      : lo.z + 0.03 + Math.random() * 0.08;
    this.mistVel[3 * i] = (Math.random() - 0.5) * 0.04;
    this.mistVel[3 * i + 1] = (Math.random() - 0.5) * 0.04;
    this.mistVel[3 * i + 2] = 0.01 + Math.random() * 0.04;
  }

  private updateMist(dt: number): void {
    const lo = this.tubMin;
    const hi = this.tubMax;
    const swirl = 0.15 + this.env.spray;
    for (let i = 0; i < MIST_COUNT; i++) {
      const x = this.mistPos[3 * i] as number;
      const y = this.mistPos[3 * i + 1] as number;
      // A slow swirl about the axis of the tub, stirred by the arms.
      const cx = (lo.x + hi.x) / 2;
      const cy = (lo.y + hi.y) / 2;
      const ux = -(y - cy) * 0.25 * swirl;
      const uy = (x - cx) * 0.25 * swirl;
      this.mistPos[3 * i] = x + ((this.mistVel[3 * i] as number) + ux) * dt;
      this.mistPos[3 * i + 1] = y + ((this.mistVel[3 * i + 1] as number) + uy) * dt;
      this.mistPos[3 * i + 2] =
        (this.mistPos[3 * i + 2] as number) +
        (this.mistVel[3 * i + 2] as number) * (0.5 + this.env.steam) * dt;
      const px = this.mistPos[3 * i] as number;
      const py = this.mistPos[3 * i + 1] as number;
      const pz = this.mistPos[3 * i + 2] as number;
      if (pz > hi.z - 0.03 || px < lo.x || px > hi.x || py < lo.y || py > hi.y)
        this.placeMist(i, false);
    }
    const attribute = this.mist.geometry.getAttribute('position');
    attribute.needsUpdate = true;
    const u = this.mistMaterial.uniforms['uIntensity'];
    if (u !== undefined)
      u.value = Math.min(1, 0.25 * this.env.spray + 0.75 * this.env.steam) * this.master;
  }

  private updatePool(): void {
    this.pool.position.z = this.floorZ + this.poolLevel();
    const u = this.poolMaterial.uniforms;
    if (u['uChop'] !== undefined) u['uChop'].value = 0.6 * this.env.spray;
    if (u['uOpacity'] !== undefined) u['uOpacity'].value = Math.min(1, this.env.pool * 1.6);
    this.pool.visible = this.env.pool > 0.01;
  }

  /** Takes the water out of the scene. */
  dispose(): void {
    this.restoreArms(null);
    this.scene.remove(this.root);
    this.streaks.dispose();
    this.streakMaterial.dispose();
    this.glintMaterial.dispose();
    this.mist.geometry.dispose();
    this.mistMaterial.dispose();
    this.pool.geometry.dispose();
    this.poolMaterial.dispose();
  }
}
