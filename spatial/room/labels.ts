import * as THREE from "three";
import { INK, PAPER } from "./pencil";

// in-scene text. the DOM is not visible inside an immersive session, so anything
// the headset needs to read is drawn to a canvas texture.

export interface PanelLine {
  text: string;
  size?: number; // px at the panel's canvas resolution
  muted?: boolean;
}

function fontFamily() {
  if (typeof document === "undefined") return "ui-monospace, monospace";
  return getComputedStyle(document.body).fontFamily || "ui-monospace, monospace";
}

/** A flat, readable card. Sized in meters; redraw with draw(lines). */
export function createPanel(widthM: number, heightM: number, pxPerM = 2000) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(widthM * pxPerM);
  canvas.height = Math.round(heightM * pxPerM);
  const ctx = canvas.getContext("2d")!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthM, heightM), material);
  mesh.renderOrder = 20;
  mesh.raycast = () => {};
  let last = "";

  function draw(lines: PanelLine[]) {
    const key = JSON.stringify(lines);
    if (key === last) return;
    last = key;
    const { width, height } = canvas;
    const pad = Math.round(height * 0.12);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, width, height);
    const family = fontFamily();
    let y = pad;
    for (const line of lines) {
      const size = line.size ?? 30;
      ctx.font = `500 ${size}px ${family}`;
      ctx.fillStyle = line.muted ? "rgba(250,250,250,0.62)" : "#fafafa";
      ctx.textBaseline = "top";
      ctx.fillText(fit(ctx, line.text, width - pad * 2), pad, y);
      y += size * 1.45;
    }
    texture.needsUpdate = true;
  }

  return { mesh, draw, canvas };
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}...`).width > max) out = out.slice(0, -1);
  return `${out}...`;
}

let lockTexture: THREE.CanvasTexture | null = null;

/** Small padlock badge that always faces the viewer. */
export function lockBadge(sizeM = 0.16) {
  if (!lockTexture) {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    g.fillStyle = PAPER;
    g.strokeStyle = INK;
    g.lineWidth = 6;
    g.beginPath();
    g.arc(64, 64, 58, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    // shackle
    g.lineWidth = 9;
    g.beginPath();
    g.arc(64, 54, 17, Math.PI, 0);
    g.lineTo(81, 64);
    g.moveTo(47, 54);
    g.lineTo(47, 64);
    g.stroke();
    // body
    g.fillStyle = INK;
    g.fillRect(38, 62, 52, 36);
    lockTexture = new THREE.CanvasTexture(c);
    lockTexture.colorSpace = THREE.SRGBColorSpace;
  }
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: lockTexture, depthTest: false, transparent: true }));
  sprite.scale.set(sizeM, sizeM, 1);
  sprite.renderOrder = 15;
  sprite.raycast = () => {};
  sprite.userData.sharedTexture = true;
  return sprite;
}

export function disposeLockTexture() {
  lockTexture?.dispose();
  lockTexture = null;
}
