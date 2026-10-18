"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import * as THREE from "three";
const cn = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export type DappledLightPlant = "ficus" | "olive" | "palm" | "fern";
export type DappledLightPlacement = "top-right" | "top-left" | "right" | "left" | "bottom-right" | "bottom-left";
export type DappledLightWindow = "auto" | "on" | "off";

export interface DappledLightProps {
  plant?: DappledLightPlant;
  placement?: DappledLightPlacement;
  scale?: number;
  density?: number;
  depth?: number;
  softness?: number;
  shadowStrength?: number;
  lightColor?: string;
  shadowColor?: string;
  backgroundColor?: string;
  window?: DappledLightWindow;
  windowAngle?: number;
  windowSize?: number;
  intensity?: number;
  bloom?: number;
  wind?: number;
  windSpeed?: number;
  clouds?: number;
  breeze?: boolean;
  grain?: number;
  seed?: number;
  intro?: boolean;
  paused?: boolean;
  dpr?: number;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export interface DappledLightHandle {
  gust: (strength?: number) => void;
  replay: () => void;
}

type Settings = Required<Omit<DappledLightProps, "children" | "className" | "style">> & {
  reduced: boolean;
};

interface Controller {
  sync: () => void;
  gust: (strength?: number) => void;
  replay: () => void;
  destroy: () => void;
}

interface LeafSpec {
  at: number;
  side: number;
  length: number;
  width: number;
  tilt: number;
  droop: number;
  flutter: number;
  rate: number;
  kind: number;
}

interface BranchSpec {
  base: [number, number];
  angle: number;
  length: number;
  segments: number;
  curl: number;
  droop: number;
  depth: number;
  phase: number;
  thickness: number;
  leaves: LeafSpec[];
  bend: number;
  velocity: number;
  kick: number;
  kickAt: number;
}

const MAX_LEAVES = 192;
const MAX_STEMS = 96;
const TAU = Math.PI * 2;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const smoother = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

const wrapAngle = (a: number) => {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
};

const subscribeToMotion = (notify: () => void) => {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};

const readMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const scratchColor = new THREE.Color();

const parseColor = (value: string): [number, number, number] | null => {
  const text = value.trim().toLowerCase();
  if (!text || text === "transparent" || text === "none" || text === "auto") return null;
  try {
    scratchColor.setStyle(text, THREE.NoColorSpace);
  } catch {
    return null;
  }
  return [scratchColor.r, scratchColor.g, scratchColor.b];
};

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

const random = (seed: number) => {
  let state = (Math.floor(Math.abs(seed)) % 2147483646) + 1;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
};

interface Template {
  offset: number;
  length: number;
  segments: number;
  curl: number;
  droop: number;
  depth: number;
  spread: number;
}

const TEMPLATES: Record<DappledLightPlant, Template[]> = {
  ficus: [
    { offset: 0, length: 0.95, segments: 6, curl: 0.16, droop: 0.05, depth: 0.12, spread: 0 },
    { offset: -0.44, length: 0.74, segments: 5, curl: -0.1, droop: 0.06, depth: 0.55, spread: -0.12 },
    { offset: 0.42, length: 0.66, segments: 5, curl: 0.2, droop: 0.04, depth: 0.95, spread: 0.1 },
    { offset: 0.88, length: 0.52, segments: 4, curl: -0.14, droop: 0.07, depth: 0.35, spread: 0.2 },
  ],
  olive: [
    { offset: 0.02, length: 1.15, segments: 10, curl: 0.1, droop: 0.035, depth: 0.18, spread: 0 },
    { offset: -0.36, length: 0.92, segments: 8, curl: -0.07, droop: 0.04, depth: 0.6, spread: -0.1 },
    { offset: 0.4, length: 0.86, segments: 8, curl: 0.14, droop: 0.03, depth: 1, spread: 0.12 },
  ],
  palm: [
    { offset: 0.04, length: 1.28, segments: 14, curl: 0.02, droop: 0.05, depth: 0.14, spread: 0 },
    { offset: -0.5, length: 1.05, segments: 12, curl: -0.02, droop: 0.06, depth: 0.6, spread: -0.08 },
    { offset: 0.56, length: 1.0, segments: 12, curl: 0.03, droop: 0.065, depth: 0.95, spread: 0.1 },
  ],
  fern: [
    { offset: 0.0, length: 1.1, segments: 18, curl: 0.22, droop: 0.06, depth: 0.15, spread: 0 },
    { offset: -0.42, length: 0.88, segments: 15, curl: 0.12, droop: 0.07, depth: 0.55, spread: -0.1 },
    { offset: 0.45, length: 0.82, segments: 14, curl: 0.3, droop: 0.06, depth: 0.95, spread: 0.12 },
    { offset: 0.9, length: 0.62, segments: 11, curl: 0.18, droop: 0.08, depth: 0.4, spread: 0.2 },
  ],
};

const ANCHORS: Record<DappledLightPlacement, { x: number; y: number; angle: number }> = {
  "top-right": { x: 1, y: 1, angle: -2.42 },
  "top-left": { x: -1, y: 1, angle: -0.72 },
  right: { x: 1, y: 0.18, angle: Math.PI - 0.18 },
  left: { x: -1, y: 0.18, angle: 0.18 },
  "bottom-right": { x: 1, y: -1, angle: 2.42 },
  "bottom-left": { x: -1, y: -1, angle: 0.72 },
};

const buildPlant = (
  kind: DappledLightPlant,
  placement: DappledLightPlacement,
  aspect: number,
  scale: number,
  density: number,
  seed: number,
): BranchSpec[] => {
  const rng = random(seed * 7919 + kind.length * 131 + placement.length * 17);
  const anchor = ANCHORS[placement] ?? ANCHORS["top-right"];
  const mirror = anchor.x < 0 ? -1 : 1;
  const flip = anchor.y < 0 ? -1 : 1;
  const keep = clamp(0.5 + 0.5 * density, 0.25, 1);
  const leafScale = 0.82 + 0.18 * clamp(density, 0.3, 1.6);
  const baseX = anchor.x * (aspect / 2 + 0.05);
  const baseY = anchor.y === 1 || anchor.y === -1 ? anchor.y * 0.56 : anchor.y;
  return (TEMPLATES[kind] ?? TEMPLATES.ficus).map((template, index) => {
    const along = anchor.angle + Math.PI / 2;
    const offset = template.spread * scale;
    const base: [number, number] = [
      baseX + Math.cos(along) * offset * 0.6,
      baseY + Math.sin(along) * offset * 0.6 * (Math.abs(anchor.y) < 1 ? 1 : 0.4),
    ];
    const branch: BranchSpec = {
      base,
      angle: anchor.angle + template.offset * mirror * flip,
      length: template.length * scale * (0.92 + rng() * 0.16),
      segments: template.segments,
      curl: template.curl * mirror * flip,
      droop: template.droop,
      depth: template.depth,
      phase: rng() * TAU + index,
      thickness: kind === "palm" ? 0.0036 : kind === "fern" ? 0.0028 : 0.0042,
      leaves: [],
      bend: 0,
      velocity: 0,
      kick: 0,
      kickAt: 0,
    };
    const segs = template.segments;
    for (let k = 1; k <= segs; k++) {
      const progress = k / segs;
      const sides = k === segs ? [0] : [-1, 1];
      for (const side of sides) {
        if (side !== 0 && rng() > keep) continue;
        if (kind === "ficus") {
          if (side !== 0 && (k + (side > 0 ? 1 : 0)) % 2 === 0 && rng() < 0.35) continue;
          branch.leaves.push({
            at: k,
            side,
            length: (0.13 + rng() * 0.08) * scale * leafScale * (side === 0 ? 1.12 : 1),
            width: 0.4 + rng() * 0.14,
            tilt: side === 0 ? 0 : 0.62 + rng() * 0.45,
            droop: 0.22,
            flutter: rng() * TAU,
            rate: 1.1 + rng() * 1.1,
            kind: 0,
          });
        } else if (kind === "olive") {
          branch.leaves.push({
            at: k,
            side,
            length: (0.095 + rng() * 0.05) * scale * leafScale,
            width: 0.15 + rng() * 0.06,
            tilt: side === 0 ? 0 : 0.42 + rng() * 0.32,
            droop: 0.12,
            flutter: rng() * TAU,
            rate: 1.6 + rng() * 1.4,
            kind: 0,
          });
        } else if (kind === "fern") {
          const taper = Math.pow(Math.sin(Math.PI * clamp(progress * 0.9 + 0.08, 0, 1)), 0.85) * (1 - 0.35 * progress);
          branch.leaves.push({
            at: k,
            side,
            length: (0.03 + 0.11 * taper) * scale * leafScale * (0.92 + rng() * 0.16),
            width: 0.3 + rng() * 0.08,
            tilt: side === 0 ? 0 : 1.05 + rng() * 0.12,
            droop: 0.18,
            flutter: rng() * TAU,
            rate: 1.6 + rng() * 1.4,
            kind: 0,
          });
        } else {
          const taper = Math.pow(Math.sin(Math.PI * clamp(progress * 0.94 + 0.04, 0, 1)), 0.7);
          branch.leaves.push({
            at: k,
            side,
            length: (0.06 + 0.2 * taper) * scale * leafScale * (0.92 + rng() * 0.16),
            width: 0.11 + rng() * 0.04,
            tilt: side === 0 ? 0 : 0.92 + rng() * 0.18,
            droop: 0.38,
            flutter: rng() * TAU,
            rate: 1.8 + rng() * 1.6,
            kind: 0,
          });
        }
      }
    }
    return branch;
  });
};

const passVertex = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const leafVertex = `
attribute vec4 iLeaf;
attribute vec4 iShape;
uniform vec2 uHalf;
varying vec2 vLocal;
varying vec4 vShape;
varying float vLength;
void main() {
  float r = iLeaf.w * 0.5;
  float halfWidth = r * iShape.x;
  vec2 extent = vec2(r, halfWidth) + iShape.y * 2.4 + 0.003;
  vec2 local = position.xy * extent;
  float c = cos(iLeaf.z);
  float s = sin(iLeaf.z);
  vec2 world = iLeaf.xy + vec2(c * local.x - s * local.y, s * local.x + c * local.y);
  gl_Position = vec4(world / uHalf, 0.0, 1.0);
  vLocal = local;
  vShape = iShape;
  vLength = iLeaf.w;
}
`;

const leafFragment = `
varying vec2 vLocal;
varying vec4 vShape;
varying float vLength;

float sdLeaf(vec2 p, float len, float ratio) {
  float r = len * 0.5;
  float w = max(r * ratio, 1e-4);
  float R = (r * r + w * w) / (2.0 * w);
  float d = R - w;
  vec2 q = abs(p);
  return max(length(vec2(q.x, q.y + d)) - R, q.x - r);
}

void main() {
  float sd = sdLeaf(vLocal, vLength, vShape.x);
  float occ = 1.0 - smoothstep(-vShape.y, vShape.y, sd);
  gl_FragColor = vec4(occ * vShape.z);
}
`;

const stemVertex = `
attribute vec4 iStem;
attribute vec4 iStemShape;
uniform vec2 uHalf;
varying vec2 vWorld;
varying vec4 vSegment;
varying vec4 vShape;
void main() {
  vec2 a = iStem.xy;
  vec2 b = iStem.zw;
  vec2 axis = b - a;
  float len = max(length(axis), 1e-5);
  vec2 dir = axis / len;
  vec2 perp = vec2(-dir.y, dir.x);
  float pad = iStemShape.x + iStemShape.y * 2.4 + 0.003;
  vec2 center = (a + b) * 0.5;
  vec2 world = center + dir * position.x * (len * 0.5 + pad) + perp * position.y * pad;
  gl_Position = vec4(world / uHalf, 0.0, 1.0);
  vWorld = world;
  vSegment = iStem;
  vShape = iStemShape;
}
`;

const stemFragment = `
varying vec2 vWorld;
varying vec4 vSegment;
varying vec4 vShape;
void main() {
  vec2 pa = vWorld - vSegment.xy;
  vec2 ba = vSegment.zw - vSegment.xy;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  float sd = length(pa - ba * h) - vShape.x;
  float occ = 1.0 - smoothstep(-vShape.y, vShape.y, sd);
  gl_FragColor = vec4(occ * vShape.z);
}
`;

const windowChunk = `
uniform vec2 uHalf;
uniform vec4 uWindow;
uniform float uWindowAngle;
uniform float uWindowOn;

float windowMask(vec2 p, out float falloff) {
  falloff = 1.0;
  if (uWindowOn < 0.5) return 1.0;
  vec2 d = p - uWindow.xy;
  if (uWindowOn > 1.5) {
    vec2 e = d / vec2(uWindow.z * 1.35, uWindow.z);
    float r = length(e);
    falloff = mix(0.55, 1.0, 1.0 - smoothstep(0.0, 1.0, r));
    return 1.0 - smoothstep(0.35, 1.0, r);
  }
  float c = cos(uWindowAngle);
  float s = sin(uWindowAngle);
  vec2 r = vec2(c * d.x + s * d.y, -s * d.x + c * d.y);
  float size = uWindow.z;
  float soft = uWindow.w;
  float halfLen = size * 1.3;
  float persp = 1.0 + 0.3 * clamp(r.x / halfLen, -1.0, 1.0);
  float y = r.y / persp;
  float halfW = size * 0.5;
  float across = smoothstep(-halfW - soft, -halfW + soft, y) * (1.0 - smoothstep(halfW - soft, halfW + soft, y));
  float along = smoothstep(-halfLen - soft * 2.0, -halfLen + soft * 2.0, r.x) * (1.0 - smoothstep(halfLen - soft * 2.0, halfLen + soft * 2.0, r.x));
  float bar = size * 0.016;
  float mullion = 1.0 - (1.0 - smoothstep(bar, bar + soft * 0.8, abs(y))) * 0.94;
  float transom = 1.0 - (1.0 - smoothstep(bar, bar + soft * 0.8, abs(r.x + halfLen * 0.28))) * 0.9;
  falloff = mix(0.5, 1.0, 1.0 - smoothstep(-halfLen, halfLen, r.x)) * mix(0.8, 1.0, 1.0 - smoothstep(0.0, halfW, abs(y)));
  return across * along * mullion * transom;
}
`;

const lightCompositeFragment = `
uniform sampler2D uMask;
uniform vec3 uBackground;
uniform vec3 uShadowTint;
uniform float uSun;
uniform float uStrength;
uniform float uGrain;
uniform float uTime;
varying vec2 vUv;
${windowChunk}
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec2 p = (vUv * 2.0 - 1.0) * uHalf;
  float shade = texture2D(uMask, vUv).r;
  float falloff;
  float win = windowMask(p, falloff);
  float lit = win * (1.0 - shade);
  float amount = clamp((1.0 - lit) * uSun * uStrength, 0.0, 1.0);
  vec3 color = uBackground * (1.0 - amount * (1.0 - uShadowTint));
  float n = hash(gl_FragCoord.xy + fract(uTime * 17.0) * 911.0) - 0.5;
  float mask = smoothstep(0.0, 0.05, amount);
  color += n * uGrain * 0.09 * mask;
  color += (hash(gl_FragCoord.xy * 1.7) - 0.5) / 255.0 * mask;
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

const emissionFragment = `
uniform sampler2D uMask;
uniform vec3 uLightColor;
uniform vec3 uShadowColor;
uniform float uSun;
uniform float uIntensity;
varying vec2 vUv;
${windowChunk}
void main() {
  vec2 p = (vUv * 2.0 - 1.0) * uHalf;
  float shade = texture2D(uMask, vUv).r;
  float falloff;
  float win = windowMask(p, falloff);
  vec3 light = uLightColor * (1.0 - shade) + uShadowColor * shade * 0.08;
  vec3 emission = light * win * falloff * uSun * uIntensity;
  gl_FragColor = vec4(emission, 1.0);
}
`;

const downFragment = `
uniform sampler2D uSource;
uniform vec2 uTexel;
varying vec2 vUv;
vec3 tap(vec2 d) { return texture2D(uSource, vUv + d * uTexel).rgb; }
void main() {
  vec3 a = tap(vec2(-2.0, 2.0));
  vec3 b = tap(vec2(0.0, 2.0));
  vec3 c = tap(vec2(2.0, 2.0));
  vec3 d = tap(vec2(-2.0, 0.0));
  vec3 e = tap(vec2(0.0, 0.0));
  vec3 f = tap(vec2(2.0, 0.0));
  vec3 g = tap(vec2(-2.0, -2.0));
  vec3 h = tap(vec2(0.0, -2.0));
  vec3 i = tap(vec2(2.0, -2.0));
  vec3 j = tap(vec2(-1.0, 1.0));
  vec3 k = tap(vec2(1.0, 1.0));
  vec3 l = tap(vec2(-1.0, -1.0));
  vec3 m = tap(vec2(1.0, -1.0));
  vec3 color = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  gl_FragColor = vec4(color, 1.0);
}
`;

const upFragment = `
uniform sampler2D uSource;
uniform vec2 uTexel;
varying vec2 vUv;
vec3 tap(vec2 d) { return texture2D(uSource, vUv + d * uTexel).rgb; }
void main() {
  vec3 color = tap(vec2(0.0)) * 4.0
    + (tap(vec2(-1.0, 0.0)) + tap(vec2(1.0, 0.0)) + tap(vec2(0.0, -1.0)) + tap(vec2(0.0, 1.0))) * 2.0
    + tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0));
  gl_FragColor = vec4(color / 16.0, 1.0);
}
`;

const darkCompositeFragment = `
uniform sampler2D uEmission;
uniform sampler2D uBloom;
uniform vec3 uBackground;
uniform vec2 uResolution;
uniform float uBloomStrength;
uniform float uGrain;
uniform float uTime;
varying vec2 vUv;
vec3 neutral(vec3 color) {
  const float start = 0.76;
  const float desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < start) return color;
  const float d = 1.0 - start;
  float next = 1.0 - d * d / (peak + d - start);
  color *= next / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - next) + 1.0);
  return mix(color, vec3(next), g);
}
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec2 c = vUv - 0.5;
  vec2 shift = c * 1.4 / uResolution.y;
  vec3 emission;
  emission.r = texture2D(uEmission, vUv + shift).r;
  emission.g = texture2D(uEmission, vUv).g;
  emission.b = texture2D(uEmission, vUv - shift).b;
  emission += texture2D(uBloom, vUv).rgb * uBloomStrength;
  vec3 light = neutral(max(emission, 0.0));
  light = pow(light, vec3(1.0 / 2.2));
  vec3 color = 1.0 - (1.0 - uBackground) * (1.0 - light);
  float l = max(light.r, max(light.g, light.b));
  float mask = smoothstep(0.0, 0.04, l);
  float n = hash(gl_FragCoord.xy + fract(uTime * 17.0) * 911.0) - 0.5;
  color += n * uGrain * 0.1 * mask;
  color += (hash(gl_FragCoord.xy * 1.7) - 0.5) / 255.0 * mask;
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

const createLight = (
  root: HTMLElement,
  stage: HTMLElement,
  settingsRef: { current: Settings },
): Controller | null => {
  const doc = root.ownerDocument;
  const view = doc.defaultView ?? window;
  const canvas = doc.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: false, antialias: false, powerPreference: "high-performance" });
  } catch {
    return null;
  }
  stage.appendChild(canvas);
  renderer.autoClear = false;

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  const quadGeometry = new THREE.PlaneGeometry(2, 2);
  const quadScene = new THREE.Scene();
  const quad = new THREE.Mesh(quadGeometry);
  quad.frustumCulled = false;
  quadScene.add(quad);

  const half = new THREE.Vector2(1, 0.5);
  const leafGeometry = new THREE.InstancedBufferGeometry();
  leafGeometry.index = quadGeometry.index;
  leafGeometry.setAttribute("position", quadGeometry.getAttribute("position"));
  const leafData = new Float32Array(MAX_LEAVES * 4);
  const leafShape = new Float32Array(MAX_LEAVES * 4);
  const leafAttribute = new THREE.InstancedBufferAttribute(leafData, 4);
  const leafShapeAttribute = new THREE.InstancedBufferAttribute(leafShape, 4);
  leafAttribute.setUsage(THREE.DynamicDrawUsage);
  leafShapeAttribute.setUsage(THREE.DynamicDrawUsage);
  leafGeometry.setAttribute("iLeaf", leafAttribute);
  leafGeometry.setAttribute("iShape", leafShapeAttribute);
  leafGeometry.instanceCount = 0;

  const stemGeometry = new THREE.InstancedBufferGeometry();
  stemGeometry.index = quadGeometry.index;
  stemGeometry.setAttribute("position", quadGeometry.getAttribute("position"));
  const stemData = new Float32Array(MAX_STEMS * 4);
  const stemShape = new Float32Array(MAX_STEMS * 4);
  const stemAttribute = new THREE.InstancedBufferAttribute(stemData, 4);
  const stemShapeAttribute = new THREE.InstancedBufferAttribute(stemShape, 4);
  stemAttribute.setUsage(THREE.DynamicDrawUsage);
  stemShapeAttribute.setUsage(THREE.DynamicDrawUsage);
  stemGeometry.setAttribute("iStem", stemAttribute);
  stemGeometry.setAttribute("iStemShape", stemShapeAttribute);
  stemGeometry.instanceCount = 0;

  const maxBlend = {
    transparent: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.MaxEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    depthTest: false,
    depthWrite: false,
  };
  const leafMaterial = new THREE.ShaderMaterial({
    uniforms: { uHalf: { value: half } },
    vertexShader: leafVertex,
    fragmentShader: leafFragment,
    ...maxBlend,
  });
  const stemMaterial = new THREE.ShaderMaterial({
    uniforms: { uHalf: { value: half } },
    vertexShader: stemVertex,
    fragmentShader: stemFragment,
    ...maxBlend,
  });
  const maskScene = new THREE.Scene();
  const leafMesh = new THREE.Mesh(leafGeometry, leafMaterial);
  const stemMesh = new THREE.Mesh(stemGeometry, stemMaterial);
  leafMesh.frustumCulled = false;
  stemMesh.frustumCulled = false;
  maskScene.add(stemMesh);
  maskScene.add(leafMesh);

  const windowUniforms = {
    uHalf: { value: half },
    uWindow: { value: new THREE.Vector4(0, 0, 0.6, 0.03) },
    uWindowAngle: { value: 0 },
    uWindowOn: { value: 0 },
  };
  const background = new THREE.Vector3(1, 1, 1);
  const shadowTint = new THREE.Vector3(0.8, 0.78, 0.88);
  const lightColor = new THREE.Vector3(0.6, 0.5, 1.2);
  const shadowColor = new THREE.Vector3(0.2, 0.15, 0.45);
  const target = (hdr: boolean) =>
    new THREE.WebGLRenderTarget(1, 1, {
      type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
  const maskTarget = target(false);
  const emissionTarget = target(true);
  const bloomTargets = Array.from({ length: 5 }, () => target(true));

  const lightComposite = new THREE.ShaderMaterial({
    uniforms: {
      ...windowUniforms,
      uMask: { value: maskTarget.texture },
      uBackground: { value: background },
      uShadowTint: { value: shadowTint },
      uSun: { value: 1 },
      uStrength: { value: 1 },
      uGrain: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: passVertex,
    fragmentShader: lightCompositeFragment,
    depthTest: false,
    depthWrite: false,
  });
  const emissionMaterial = new THREE.ShaderMaterial({
    uniforms: {
      ...windowUniforms,
      uMask: { value: maskTarget.texture },
      uLightColor: { value: lightColor },
      uShadowColor: { value: shadowColor },
      uSun: { value: 1 },
      uIntensity: { value: 1 },
    },
    vertexShader: passVertex,
    fragmentShader: emissionFragment,
    depthTest: false,
    depthWrite: false,
  });
  const downMaterial = new THREE.ShaderMaterial({
    uniforms: { uSource: { value: null }, uTexel: { value: new THREE.Vector2() } },
    vertexShader: passVertex,
    fragmentShader: downFragment,
    depthTest: false,
    depthWrite: false,
  });
  const upMaterial = new THREE.ShaderMaterial({
    uniforms: { uSource: { value: null }, uTexel: { value: new THREE.Vector2() } },
    vertexShader: passVertex,
    fragmentShader: upFragment,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const darkComposite = new THREE.ShaderMaterial({
    uniforms: {
      uEmission: { value: emissionTarget.texture },
      uBloom: { value: bloomTargets[0].texture },
      uBackground: { value: background },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uBloomStrength: { value: 0.5 },
      uGrain: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: passVertex,
    fragmentShader: darkCompositeFragment,
    depthTest: false,
    depthWrite: false,
  });

  let width = 0;
  let height = 0;
  let dpr = 1;
  let sized = false;
  let plant: BranchSpec[] = [];
  let plantKey = "";
  const centroid = { x: 0, y: 0 };
  let lightMode = true;
  let page: [number, number, number] = [1, 1, 1];
  let colorKey = "";
  let backgroundAt = -10;
  let time = 0;
  let windClock = 0;
  let windBoost = 0;
  const breeze = { x: 0, y: 0 };
  let pointerLast: { x: number; y: number; t: number } | null = null;
  let introAt = -1;
  let introDone = false;
  let raf = 0;
  let last = 0;
  let visible = false;
  let destroyed = false;
  let lost = false;

  const clock = () => performance.now() / 1000;

  const readSize = () => {
    const settings = settingsRef.current;
    const nextWidth = Math.round(root.clientWidth);
    const nextHeight = Math.round(root.clientHeight);
    if (nextWidth < 2 || nextHeight < 2) {
      sized = false;
      return false;
    }
    const nextDpr = Math.min(view.devicePixelRatio || 1, Math.max(settings.dpr, 0.5));
    if (sized && nextWidth === width && nextHeight === height && nextDpr === dpr) return false;
    sized = true;
    width = nextWidth;
    height = nextHeight;
    dpr = nextDpr;
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    maskTarget.setSize(width, height);
    emissionTarget.setSize(width, height);
    let w = width;
    let h = height;
    for (const bloomTarget of bloomTargets) {
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
      bloomTarget.setSize(w, h);
    }
    half.set(width / height / 2, 0.5);
    darkComposite.uniforms.uResolution.value.set(width, height);
    plantKey = "";
    return true;
  };

  const readPage = (): [number, number, number] => {
    let node: HTMLElement | null = root.parentElement;
    while (node) {
      const fill = view.getComputedStyle(node).backgroundColor;
      const match = fill.match(/rgba?\(([^)]+)\)/);
      if (match) {
        const parts = match[1].split(",").map((part) => Number.parseFloat(part));
        if (parts.length < 4 || parts[3] > 0.05) return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
      }
      node = node.parentElement;
    }
    const text = view.getComputedStyle(root).color.match(/rgba?\(([^)]+)\)/);
    if (text) {
      const parts = text[1].split(",").map((part) => Number.parseFloat(part));
      return parts[0] + parts[1] + parts[2] > 382 ? [0.04, 0.04, 0.04] : [1, 1, 1];
    }
    return [1, 1, 1];
  };

  const refreshPage = () => {
    page = parseColor(settingsRef.current.backgroundColor) ?? readPage();
  };

  const syncColors = () => {
    const settings = settingsRef.current;
    const key = [page.join(","), settings.lightColor, settings.shadowColor].join("|");
    if (key === colorKey) return;
    colorKey = key;
    lightMode = 0.2126 * page[0] + 0.7152 * page[1] + 0.0722 * page[2] > 0.5;
    background.set(page[0], page[1], page[2]);
    const shadow = parseColor(settings.shadowColor) ?? (lightMode ? [0.71, 0.69, 0.82] : [0.24, 0.18, 0.5]);
    const light = parseColor(settings.lightColor) ?? (lightMode ? [1, 0.96, 0.9] : [0.56, 0.49, 1]);
    shadowTint.set(shadow[0], shadow[1], shadow[2]);
    lightColor.set(toLinear(light[0]), toLinear(light[1]), toLinear(light[2]));
    shadowColor.set(toLinear(shadow[0]), toLinear(shadow[1]), toLinear(shadow[2]));
  };

  const fitScale = () => clamp(width / height / 1.5, 0.48, 1);

  const ensurePlant = () => {
    const settings = settingsRef.current;
    const aspect = width / height;
    const key = [settings.plant, settings.placement, settings.scale, settings.density, settings.seed, aspect.toFixed(3)].join("|");
    if (key === plantKey) return;
    plantKey = key;
    plant = buildPlant(
      settings.plant,
      settings.placement,
      aspect,
      clamp(settings.scale, 0.3, 2.5) * fitScale(),
      clamp(settings.density, 0.2, 1.6),
      Math.round(settings.seed),
    );
    let weight = 0;
    centroid.x = 0;
    centroid.y = 0;
    for (const branch of plant) {
      const w = branch.length;
      centroid.x += (branch.base[0] + Math.cos(branch.angle) * branch.length * 0.55) * w;
      centroid.y += (branch.base[1] + Math.sin(branch.angle) * branch.length * 0.55) * w;
      weight += w;
    }
    if (weight > 0) {
      centroid.x /= weight;
      centroid.y /= weight;
    }
  };

  const schedule = () => {
    if (destroyed || lost || !visible || raf) return;
    raf = requestAnimationFrame(frame);
  };

  const gust = (strength = 1) => {
    if (settingsRef.current.reduced) return;
    const s = clamp(strength, 0, 3);
    const now = clock();
    plant.forEach((branch, index) => {
      branch.kick = Math.min(branch.kick + s * (0.75 + 0.2 * Math.sin(index * 2.3)), 2.2);
      branch.kickAt = now + 0.05 + 0.09 * index + branch.depth * 0.08;
    });
    windBoost = Math.min(windBoost + 0.6 * s, 1.5);
    schedule();
  };

  const replay = () => {
    introAt = -1;
    introDone = false;
    schedule();
  };

  const turbulence = (t: number, phase: number) =>
    0.55 * Math.sin(0.71 * t + phase) + 0.3 * Math.sin(1.37 * t + phase * 2.1) + 0.15 * Math.sin(2.93 * t + phase * 0.7);

  const updatePlant = (dt: number, reduced: boolean, blurScale: number) => {
    const settings = settingsRef.current;
    const windAmount = reduced ? 0 : clamp(settings.wind, 0, 2);
    const softness = clamp(settings.softness, 0, 3);
    const depthSpread = clamp(settings.depth, 0, 1.5);
    const gustEnvelope = 0.55 + 0.45 * Math.sin(windClock * 0.21) * Math.sin(windClock * 0.13 + 1.1);
    let leafIndex = 0;
    let stemIndex = 0;
    for (const branch of plant) {
      const normalX = -Math.sin(branch.angle);
      const normalY = Math.cos(branch.angle);
      const push = breeze.x * normalX + breeze.y * normalY;
      const torque = windAmount * turbulence(windClock, branch.phase) * gustEnvelope * 0.16 + push * 0.3;
      if (branch.kick > 0 && clock() >= branch.kickAt && !reduced) {
        branch.velocity += branch.kick * (branch.angle > -Math.PI / 2 && branch.angle < Math.PI / 2 ? 1 : -1) * 0.55;
        branch.kick = 0;
      }
      const omega = TAU / (1.5 + branch.depth * 0.9 + branch.length * 0.4);
      if (reduced) {
        branch.bend = 0;
        branch.velocity = 0;
      } else {
        const steps = Math.max(1, Math.ceil(dt * 120));
        const h = dt / steps;
        for (let s = 0; s < steps; s++) {
          branch.velocity += (omega * omega * (torque - branch.bend) - 2 * 0.3 * omega * branch.velocity) * h;
          branch.bend += branch.velocity * h;
        }
      }
      const depth = branch.depth * depthSpread;
      const blur = (0.0016 + 0.028 * depth * depth + 0.004 * depth) * (0.3 + softness * 0.7) * blurScale;
      const opacity = clamp(0.98 - 0.36 * depth, 0.3, 1);
      const segment = branch.length / branch.segments;
      let x = branch.base[0];
      let y = branch.base[1];
      let angle = branch.angle;
      const joints: number[][] = [[x, y, angle]];
      for (let k = 1; k <= branch.segments; k++) {
        const progress = k / branch.segments;
        const flex = Math.pow(progress, 1.4);
        angle += branch.curl / branch.segments * 2;
        angle += wrapAngle(-Math.PI / 2 - angle) * branch.droop * 0.5;
        const local = angle + branch.bend * flex * 0.9 + (reduced ? 0 : 0.012 * windAmount * Math.sin(3.1 * windClock + k + branch.phase));
        const nx = x + Math.cos(local) * segment;
        const ny = y + Math.sin(local) * segment;
        if (stemIndex < MAX_STEMS) {
          stemData.set([x, y, nx, ny], stemIndex * 4);
          stemShape.set([branch.thickness * (1.25 - progress * 0.8) * clamp(settings.scale, 0.3, 2.5) * fitScale(), blur, opacity, 0], stemIndex * 4);
          stemIndex++;
        }
        x = nx;
        y = ny;
        joints.push([x, y, local]);
      }
      for (const leaf of branch.leaves) {
        if (leafIndex >= MAX_LEAVES) break;
        const joint = joints[Math.min(leaf.at, joints.length - 1)];
        const flutter = reduced ? 0 : Math.sin(windClock * leaf.rate + leaf.flutter) * (0.05 + 0.22 * Math.abs(torque) * 6) * windAmount;
        let leafAngle = joint[2] + (leaf.side === 0 ? leaf.tilt + flutter * 0.6 : leaf.side * (leaf.tilt + flutter));
        leafAngle += wrapAngle(-Math.PI / 2 - leafAngle) * leaf.droop * 0.35;
        const reach = leaf.length * 0.55;
        const cx = joint[0] + Math.cos(leafAngle) * reach;
        const cy = joint[1] + Math.sin(leafAngle) * reach;
        leafData.set([cx, cy, leafAngle, leaf.length], leafIndex * 4);
        leafShape.set([leaf.width, blur, opacity, leaf.kind], leafIndex * 4);
        leafIndex++;
      }
    }
    leafGeometry.instanceCount = leafIndex;
    stemGeometry.instanceCount = stemIndex;
    leafAttribute.needsUpdate = true;
    leafShapeAttribute.needsUpdate = true;
    stemAttribute.needsUpdate = true;
    stemShapeAttribute.needsUpdate = true;
  };

  const updateWindow = (softnessScale: number) => {
    const settings = settingsRef.current;
    const mode = settings.window;
    const on = mode === "on" || (mode === "auto" && !lightMode);
    windowUniforms.uWindowOn.value = on ? 1 : lightMode ? 0 : 2;
    const anchor = ANCHORS[settings.placement] ?? ANCHORS["top-right"];
    const aspect = width / height;
    const size = clamp(settings.windowSize, 0.2, 2) * fitScale() * (on ? 1 : 1.25);
    const limitX = aspect * 0.5 - size * 0.35;
    windowUniforms.uWindow.value.set(
      clamp(centroid.x * 0.68, -Math.max(limitX, 0), Math.max(limitX, 0)),
      clamp(centroid.y * 0.62, -0.32, 0.32),
      size,
      (0.018 + 0.03 * clamp(settings.softness, 0, 3)) * softnessScale,
    );
    windowUniforms.uWindowAngle.value = (clamp(settings.windowAngle, -90, 90) * Math.PI * anchor.x * (anchor.y < 0 ? -1 : 1)) / 180;
  };

  const render = (sunLevel: number) => {
    const settings = settingsRef.current;
    renderer.setRenderTarget(maskTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(maskScene, camera);

    if (lightMode) {
      lightComposite.uniforms.uSun.value = sunLevel;
      lightComposite.uniforms.uStrength.value = clamp(settings.shadowStrength, 0, 1.5);
      lightComposite.uniforms.uGrain.value = clamp(settings.grain, 0, 1);
      lightComposite.uniforms.uTime.value = time;
      quad.material = lightComposite;
      renderer.setRenderTarget(null);
      renderer.render(quadScene, camera);
      return;
    }

    emissionMaterial.uniforms.uSun.value = sunLevel;
    emissionMaterial.uniforms.uIntensity.value = clamp(settings.intensity, 0, 4);
    quad.material = emissionMaterial;
    renderer.setRenderTarget(emissionTarget);
    renderer.render(quadScene, camera);

    const bloomStrength = clamp(settings.bloom, 0, 2);
    if (bloomStrength > 0) {
      quad.material = downMaterial;
      let source: THREE.WebGLRenderTarget = emissionTarget;
      for (const bloomTarget of bloomTargets) {
        downMaterial.uniforms.uSource.value = source.texture;
        downMaterial.uniforms.uTexel.value.set(1 / source.width, 1 / source.height);
        renderer.setRenderTarget(bloomTarget);
        renderer.render(quadScene, camera);
        source = bloomTarget;
      }
      quad.material = upMaterial;
      for (let i = bloomTargets.length - 1; i > 0; i--) {
        const from = bloomTargets[i];
        upMaterial.uniforms.uSource.value = from.texture;
        upMaterial.uniforms.uTexel.value.set(1 / from.width, 1 / from.height);
        renderer.setRenderTarget(bloomTargets[i - 1]);
        renderer.render(quadScene, camera);
      }
    }
    darkComposite.uniforms.uBloomStrength.value = bloomStrength * 0.6;
    darkComposite.uniforms.uGrain.value = clamp(settings.grain, 0, 1);
    darkComposite.uniforms.uTime.value = time;
    quad.material = darkComposite;
    renderer.setRenderTarget(null);
    renderer.render(quadScene, camera);
  };

  function frame(now: number) {
    raf = 0;
    if (destroyed || lost) return;
    if (!sized) {
      readSize();
      if (!sized) return;
    }
    const settings = settingsRef.current;
    const dt = last && now - last < 100 ? Math.min(Math.max((now - last) / 1000, 0), 0.05) : 1 / 60;
    last = now;
    const seconds = clock();
    const reduced = settings.reduced;

    readSize();
    if (seconds - backgroundAt > 1.2) {
      backgroundAt = seconds;
      refreshPage();
    }
    syncColors();
    ensurePlant();

    const running = !settings.paused && !reduced;
    if (running) {
      time += dt;
      windClock += dt * clamp(settings.windSpeed, 0, 4) * (1 + 0.8 * Math.min(Math.hypot(breeze.x, breeze.y), 1.5) + windBoost);
    }
    const decay = Math.exp(-dt / 1.3);
    breeze.x *= decay;
    breeze.y *= decay;
    windBoost *= Math.exp(-dt / 1.6);
    if (windBoost < 1e-3) windBoost = 0;

    if (introAt < 0) {
      introAt = seconds;
      introDone = reduced || !settings.intro;
    }
    let introLevel = 1;
    if (!introDone) {
      introLevel = smoother((seconds - introAt) / 2.4);
      if (introLevel >= 1) introDone = true;
    }
    const cloudAmount = reduced ? 0 : clamp(settings.clouds, 0, 1);
    const cover = cloudAmount > 0 ? smoother((Math.sin(time * 0.037 + 1.3) * Math.sin(time * 0.023) - 0.25) / 0.45) : 0;
    const sunLevel = introLevel * (1 - 0.6 * cloudAmount * cover);
    const blurScale = (1 + 1.6 * cloudAmount * cover) * (1 + 2.6 * (1 - introLevel));

    updatePlant(dt, reduced, blurScale);
    updateWindow(1 + 0.8 * cloudAmount * cover + 1.5 * (1 - introLevel));
    render(sunLevel);

    const settling =
      Math.abs(breeze.x) + Math.abs(breeze.y) > 1e-3 ||
      windBoost > 0 ||
      plant.some((b) => Math.abs(b.velocity) > 1e-4 || Math.abs(b.bend) > 1e-4 || b.kick > 0);
    if (running || !introDone || settling) schedule();
  }

  const onMove = (event: PointerEvent) => {
    const settings = settingsRef.current;
    if (!settings.breeze || settings.reduced) return;
    const rect = root.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const t = performance.now();
    if (pointerLast) {
      const elapsed = Math.max((t - pointerLast.t) / 1000, 1 / 240);
      const scale = 1 / Math.max(height, 1);
      const vx = ((x - pointerLast.x) * scale) / elapsed;
      const vy = (-(y - pointerLast.y) * scale) / elapsed;
      const gain = clamp(elapsed / 0.12, 0, 1) * 0.35;
      breeze.x += (clamp(vx, -4, 4) - breeze.x) * gain;
      breeze.y += (clamp(vy, -4, 4) - breeze.y) * gain;
      const magnitude = Math.hypot(breeze.x, breeze.y);
      if (magnitude > 2) {
        breeze.x *= 2 / magnitude;
        breeze.y *= 2 / magnitude;
      }
    }
    pointerLast = { x, y, t };
    schedule();
  };

  const onLeave = () => {
    pointerLast = null;
  };

  const onDown = (event: PointerEvent) => {
    const settings = settingsRef.current;
    if (!settings.breeze || !event.isPrimary || event.button > 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest("a,button,input,textarea,select,label,[role=button]")) return;
    gust(0.9);
  };

  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerleave", onLeave);
  root.addEventListener("pointerdown", onDown);

  const resizer = new ResizeObserver(() => {
    if (readSize()) schedule();
  });
  resizer.observe(root);

  const observer =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          ([entry]) => {
            visible = entry.isIntersecting;
            if (visible) {
              last = 0;
              schedule();
            } else {
              if (raf) cancelAnimationFrame(raf);
              raf = 0;
            }
          },
          { rootMargin: "80px" },
        );
  if (observer) observer.observe(root);
  else visible = true;

  const onLost = (event: Event) => {
    event.preventDefault();
    lost = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
  const onRestored = () => {
    lost = false;
    colorKey = "";
    schedule();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  readSize();
  refreshPage();
  syncColors();
  schedule();

  return {
    sync: () => {
      readSize();
      refreshPage();
      schedule();
    },
    gust,
    replay,
    destroy: () => {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      observer?.disconnect();
      resizer.disconnect();
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      maskTarget.dispose();
      emissionTarget.dispose();
      bloomTargets.forEach((bloomTarget) => bloomTarget.dispose());
      [leafMaterial, stemMaterial, lightComposite, emissionMaterial, downMaterial, upMaterial, darkComposite].forEach((material) => material.dispose());
      leafGeometry.dispose();
      stemGeometry.dispose();
      quadGeometry.dispose();
      renderer.dispose();
      if (!renderer.getContext().isContextLost()) renderer.forceContextLoss();
      canvas.remove();
    },
  };
};

export const DappledLight = forwardRef<DappledLightHandle, DappledLightProps>(function DappledLight(
  {
    plant = "ficus",
    placement = "top-right",
    scale = 1,
    density = 1,
    depth = 0.7,
    softness = 1,
    shadowStrength = 1,
    lightColor = "auto",
    shadowColor = "auto",
    backgroundColor = "transparent",
    window: windowMode = "auto",
    windowAngle = 28,
    windowSize = 0.52,
    intensity = 0.9,
    bloom = 0.6,
    wind = 0.6,
    windSpeed = 1,
    clouds = 0.25,
    breeze = true,
    grain = 0.25,
    seed = 1,
    intro = true,
    paused = false,
    dpr = 2,
    children,
    className,
    style,
  },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<Controller | null>(null);
  const reduced = useSyncExternalStore(subscribeToMotion, readMotion, () => false);

  const settings: Settings = {
    plant,
    placement,
    scale,
    density,
    depth,
    softness,
    shadowStrength,
    lightColor,
    shadowColor,
    backgroundColor,
    window: windowMode,
    windowAngle,
    windowSize,
    intensity,
    bloom,
    wind,
    windSpeed,
    clouds,
    breeze,
    grain,
    seed,
    intro,
    paused,
    dpr,
    reduced,
  };
  const settingsRef = useRef(settings);

  useEffect(() => {
    settingsRef.current = settings;
    controllerRef.current?.sync();
  });

  useEffect(() => {
    const root = rootRef.current;
    const stage = stageRef.current;
    if (!root || !stage) return;
    const controller = createLight(root, stage, settingsRef);
    controllerRef.current = controller;
    return () => {
      controller?.destroy();
      controllerRef.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      gust: (strength?: number) => controllerRef.current?.gust(strength),
      replay: () => controllerRef.current?.replay(),
    }),
    [],
  );

  const backgroundValue = backgroundColor.trim().toLowerCase();
  const transparent = backgroundValue === "transparent" || backgroundValue === "";

  return (
    <div
      ref={rootRef}
      className={cn("relative isolate h-full min-h-[320px] w-full overflow-hidden", className)}
      style={{ backgroundColor: transparent ? undefined : backgroundColor, ...style }}
    >
      <div ref={stageRef} aria-hidden="true" style={{ position: "absolute", inset: 0, zIndex: 0 }} />
      {children ? <div style={{ position: "relative", zIndex: 1, height: "100%" }}>{children}</div> : null}
    </div>
  );
});

DappledLight.displayName = "DappledLight";

export default DappledLight;
