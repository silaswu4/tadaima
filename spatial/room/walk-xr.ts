import * as THREE from "three";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";
import type { WalkCore, WalkItem, WalkXR } from "./walk-api";
import { CHANGE, INK } from "./pencil";

// headset layer for the walkable room. attach once; the engine calls update(dt)
// from renderer.setAnimationLoop. everything per frame lives in update, and the
// hot path reuses vectors, arrays and materials so the Quest 3S stays smooth.
//
// controls:
//   left stick      smooth move, relative to where the head faces
//   right stick x   snap turn 30 degrees
//   right stick up  hold to aim a teleport arc at the floor, release to go
//   trigger         select a piece, press a panel button, drop a moved piece
//   grip (hold)     grab the piece under the ray, it follows the ray's floor hit,
//                   that hand's stick x turns it, release to drop

export type WalkXROptions = { onRequestAdd?: () => void };

type Handedness = "left" | "right" | "none";
type ButtonId = "move" | "rotate" | "remove";
type Target = "none" | "floor" | "item" | "panel" | "wrist";

interface Ctl {
  ray: THREE.XRTargetRaySpace;
  grip: THREE.XRGripSpace;
  model: THREE.Object3D;
  laser: THREE.Line;
  reticle: THREE.Mesh;
  handedness: Handedness;
  target: Target;
  itemId: string | null;
  button: ButtonId | null;
  wristAdd: boolean;
  floorHit: THREE.Vector3;
  hasFloor: boolean;
  onConnected: (e: { data: XRInputSource }) => void;
  onDisconnected: () => void;
  onSelect: () => void;
  onSqueezeStart: () => void;
  onSqueezeEnd: () => void;
}

interface Grab {
  id: string;
  ctl: Ctl;
  kind: "squeeze" | "button";
  root: THREE.Object3D;
  startPos: THREE.Vector3; // root local position when the grab began
  startRotY: number;
  offset: THREE.Vector3; // root local minus floor hit local, set on the first floor hit
  offsetSet: boolean;
  turn: number; // radians added by the stick
  info: WalkItem;
}

const MOVE_SPEED = 1.4; // m/s at full stick
const SNAP = THREE.MathUtils.degToRad(30);
const SNAP_COOLDOWN = 0.28;
const DEADZONE = 0.15;
const GRAB_TURN_SPEED = 1.6; // rad/s at full stick
const LASER_MAX = 6;
const ARC_STEPS = 30;
const ARC_DT = 0.045;
const ARC_SPEED = 7;
const GRAVITY = 9.8;
const ROTATE_STEP = Math.PI / 4;

const PANEL_W = 0.5;
const PANEL_H = 0.31;
const PANEL_PX = 1600;
const WRIST_W = 0.24;
const WRIST_H = 0.15;
const WRIST_PX = 2000;

const BUTTONS: ButtonId[] = ["move", "rotate", "remove"];
const BUTTON_TEXT: Record<ButtonId, string> = { move: "Move", rotate: "Rotate", remove: "Remove" };

const UP = new THREE.Vector3(0, 1, 0);
const ACCENT = new THREE.Color(CHANGE);
const DIM = new THREE.Color(INK);
const FORWARD_Z = new THREE.Vector3(0, 0, 1);

function noRaycast() {}

function fontFamily() {
  if (typeof document === "undefined") return "ui-sans-serif, system-ui, sans-serif";
  return getComputedStyle(document.body).fontFamily || "ui-sans-serif, system-ui, sans-serif";
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

function fitText(g: CanvasRenderingContext2D, text: string, max: number) {
  if (g.measureText(text).width <= max) return text;
  let out = text;
  while (out.length > 1 && g.measureText(`${out}...`).width > max) out = out.slice(0, -1);
  return `${out}...`;
}

function drawPadlock(g: CanvasRenderingContext2D, x: number, y: number, s: number) {
  g.strokeStyle = "#fafafa";
  g.fillStyle = "#fafafa";
  g.lineWidth = s * 0.14;
  g.beginPath();
  g.arc(x + s / 2, y + s * 0.42, s * 0.24, Math.PI, 0);
  g.stroke();
  g.fillRect(x + s * 0.16, y + s * 0.42, s * 0.68, s * 0.52);
}

const cm = (m: number) => Math.round(m * 100);
const inch = (m: number) => Math.round((m / 0.0254) * 10) / 10;

function sourceNote(item: WalkItem) {
  if (item.dimensionSource === "product") return "Listed product size";
  if (item.dimensionSource === "plan") return "Size from the room plan";
  return "Model bounds, not a listed size";
}

function itemIdOf(o: THREE.Object3D | null): string | null {
  while (o) {
    const id = o.userData.walkItemId;
    if (typeof id === "string") return id;
    o = o.parent;
  }
  return null;
}

/** A canvas-textured plane that can be hit by a ray (unlike labels.createPanel). */
function canvasPlane(widthM: number, heightM: number, pxPerM: number) {
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
  mesh.visible = false;
  return { canvas, ctx, texture, material, mesh };
}

export function attachWalkXR(core: WalkCore, options: WalkXROptions = {}): WalkXR {
  const { renderer, rig, scene } = core;
  const xr = renderer.xr;
  const family = fontFamily();

  // ------------------------------------------------------------ shared resources

  const laserGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const laserIdle = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.55 });
  const laserActive = new THREE.LineBasicMaterial({ color: CHANGE, transparent: true, opacity: 0.95 });
  const reticleGeometry = new THREE.RingGeometry(0.012, 0.02, 24);
  const reticleMaterial = new THREE.MeshBasicMaterial({ color: CHANGE, depthTest: false, transparent: true, side: THREE.DoubleSide });
  const ringGeometry = new THREE.RingGeometry(0.94, 1, 48).rotateX(-Math.PI / 2);
  const hoverRingMaterial = new THREE.MeshBasicMaterial({ color: INK, transparent: true, opacity: 0.35, depthWrite: false });
  const selectRingMaterial = new THREE.MeshBasicMaterial({ color: CHANGE, transparent: true, opacity: 0.9, depthWrite: false });

  const hoverRing = new THREE.Mesh(ringGeometry, hoverRingMaterial);
  const selectRing = new THREE.Mesh(ringGeometry, selectRingMaterial);
  for (const r of [hoverRing, selectRing]) {
    r.raycast = noRaycast;
    r.visible = false;
    r.renderOrder = 11;
    scene.add(r);
  }

  // teleport arc and its landing ring, in world space
  const arcPositions = new Float32Array((ARC_STEPS + 1) * 3);
  const arcGeometry = new THREE.BufferGeometry();
  arcGeometry.setAttribute("position", new THREE.BufferAttribute(arcPositions, 3));
  const arcMaterial = new THREE.LineBasicMaterial({ color: CHANGE, transparent: true, opacity: 0.9 });
  const arc = new THREE.Line(arcGeometry, arcMaterial);
  arc.frustumCulled = false;
  arc.raycast = noRaycast;
  arc.visible = false;
  arc.renderOrder = 12;
  scene.add(arc);
  const landing = new THREE.Mesh(ringGeometry, selectRingMaterial);
  landing.scale.setScalar(0.25);
  landing.raycast = noRaycast;
  landing.visible = false;
  scene.add(landing);

  // ------------------------------------------------------------ panels

  const panel = canvasPlane(PANEL_W, PANEL_H, PANEL_PX);
  scene.add(panel.mesh);
  const pad = 34;
  const btnGap = 20;
  const btnH = 112;
  const btnY = panel.canvas.height - pad - btnH;
  const btnW = (panel.canvas.width - pad * 2 - btnGap * 2) / 3;
  const btnX = (i: number) => pad + i * (btnW + btnGap);

  const wrist = canvasPlane(WRIST_W, WRIST_H, WRIST_PX);
  wrist.mesh.position.set(0, 0.11, -0.04);
  const addBtn = { x: 24, y: wrist.canvas.height - 24 - 96, w: wrist.canvas.width - 48, h: 96 };

  let panelItem: WalkItem | null = null;
  let panelKey = "";
  let panelInfoAge = 0;
  let wristKey = "";

  function drawPanel(item: WalkItem, hover: ButtonId | null) {
    const key = `${item.id}|${item.label}|${item.locked}|${item.dimensions.join(",")}|${item.dimensionSource}|${hover}`;
    if (key === panelKey) return;
    panelKey = key;
    const g = panel.ctx;
    const { width, height } = panel.canvas;
    g.clearRect(0, 0, width, height);
    g.fillStyle = INK;
    roundRect(g, 0, 0, width, height, 28);
    g.fill();
    g.textBaseline = "top";
    const max = width - pad * 2;
    let y = pad;
    g.font = `600 46px ${family}`;
    g.fillStyle = "#fafafa";
    g.fillText(fitText(g, item.label, max), pad, y);
    y += 66;
    const [w, h, d] = item.dimensions;
    g.font = `500 34px ${family}`;
    g.fillText(fitText(g, `W ${cm(w)}  D ${cm(d)}  H ${cm(h)} cm`, max), pad, y);
    y += 48;
    g.fillStyle = "rgba(250,250,250,0.72)";
    g.font = `500 30px ${family}`;
    g.fillText(fitText(g, `W ${inch(w)}  D ${inch(d)}  H ${inch(h)} in`, max), pad, y);
    y += 44;
    g.fillStyle = "rgba(250,250,250,0.55)";
    g.font = `500 26px ${family}`;
    g.fillText(fitText(g, sourceNote(item), max), pad, y);
    y += 40;
    if (item.locked) {
      drawPadlock(g, pad, y, 30);
      g.fillStyle = "rgba(250,250,250,0.8)";
      g.fillText(fitText(g, "Locked in place. Move and Remove are off.", max - 44), pad + 44, y + 2);
    }
    for (let i = 0; i < BUTTONS.length; i++) {
      const b = BUTTONS[i];
      const disabled = item.locked && b !== "rotate";
      const hot = !disabled && hover === b;
      roundRect(g, btnX(i), btnY, btnW, btnH, 22);
      g.fillStyle = hot ? CHANGE : disabled ? "rgba(250,250,250,0.06)" : "rgba(250,250,250,0.14)";
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = disabled ? "rgba(250,250,250,0.18)" : "rgba(250,250,250,0.55)";
      g.stroke();
      g.font = `600 38px ${family}`;
      g.fillStyle = disabled ? "rgba(250,250,250,0.32)" : "#fafafa";
      g.textBaseline = "middle";
      g.textAlign = "center";
      g.fillText(BUTTON_TEXT[b], btnX(i) + btnW / 2, btnY + btnH / 2);
      g.textAlign = "left";
      g.textBaseline = "top";
    }
    panel.texture.needsUpdate = true;
  }

  function drawWrist(hover: boolean, grabbing: boolean) {
    const key = `${hover}|${grabbing}`;
    if (key === wristKey) return;
    wristKey = key;
    const g = wrist.ctx;
    const { width, height } = wrist.canvas;
    g.clearRect(0, 0, width, height);
    g.fillStyle = INK;
    roundRect(g, 0, 0, width, height, 24);
    g.fill();
    g.textBaseline = "top";
    g.fillStyle = "rgba(250,250,250,0.7)";
    g.font = `500 22px ${family}`;
    const lines = grabbing
      ? ["Point at the floor to place", "Stick left or right turns it", "Let go to drop"]
      : ["Left stick: walk", "Right stick: turn, push up to teleport", "Trigger: select   Grip: grab"];
    let y = 22;
    for (const line of lines) {
      g.fillText(fitText(g, line, width - 48), 24, y);
      y += 32;
    }
    if (options.onRequestAdd) {
      roundRect(g, addBtn.x, addBtn.y, addBtn.w, addBtn.h, 20);
      g.fillStyle = hover ? CHANGE : "rgba(250,250,250,0.14)";
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = "rgba(250,250,250,0.55)";
      g.stroke();
      g.fillStyle = "#fafafa";
      g.font = `600 36px ${family}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("Add furniture", addBtn.x + addBtn.w / 2, addBtn.y + addBtn.h / 2);
      g.textAlign = "left";
    }
    wrist.texture.needsUpdate = true;
  }

  // ------------------------------------------------------------ controllers

  const modelFactory = new XRControllerModelFactory();
  let grab: Grab | null = null;

  const ctls: Ctl[] = [0, 1].map((i) => {
    const ray = xr.getController(i);
    const grip = xr.getControllerGrip(i);
    const model = modelFactory.createControllerModel(grip);
    grip.add(model);
    const laser = new THREE.Line(laserGeometry, laserIdle);
    laser.raycast = noRaycast;
    laser.scale.z = LASER_MAX;
    laser.renderOrder = 10;
    ray.add(laser);
    const reticle = new THREE.Mesh(reticleGeometry, reticleMaterial);
    reticle.raycast = noRaycast;
    reticle.renderOrder = 13;
    reticle.visible = false;
    scene.add(reticle);
    rig.add(ray);
    rig.add(grip);

    const ctl: Ctl = {
      ray,
      grip,
      model,
      laser,
      reticle,
      handedness: "none",
      target: "none",
      itemId: null,
      button: null,
      wristAdd: false,
      floorHit: new THREE.Vector3(),
      hasFloor: false,
      onConnected: (e) => {
        ctl.handedness = e.data.handedness;
        attachWrist();
      },
      onDisconnected: () => {
        ctl.handedness = "none";
        if (grab?.ctl === ctl) cancelGrab();
        attachWrist();
      },
      onSelect: () => onSelect(ctl),
      onSqueezeStart: () => onSqueezeStart(ctl),
      onSqueezeEnd: () => onSqueezeEnd(ctl),
    };
    ray.addEventListener("connected", ctl.onConnected);
    ray.addEventListener("disconnected", ctl.onDisconnected);
    ray.addEventListener("select", ctl.onSelect);
    ray.addEventListener("squeezestart", ctl.onSqueezeStart);
    ray.addEventListener("squeezeend", ctl.onSqueezeEnd);
    return ctl;
  });

  function ctlFor(hand: Handedness) {
    for (const c of ctls) if (c.handedness === hand) return c;
    return null;
  }

  function attachWrist() {
    wrist.mesh.removeFromParent();
    // the left hand holds the menu so the right can point at it
    const host = ctlFor("left") ?? ctlFor("right");
    if (host) host.ray.add(wrist.mesh);
  }

  // ------------------------------------------------------------ scratch (no per-frame allocation)

  const raycaster = new THREE.Raycaster();
  raycaster.far = LASER_MAX;
  const arcCaster = new THREE.Raycaster();
  const hits: THREE.Intersection[] = [];
  const boxes: THREE.Box3[] = [];
  const headPos = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const from = new THREE.Vector3();
  const to = new THREE.Vector3();
  const arcPrev = new THREE.Vector3();
  const arcNext = new THREE.Vector3();
  const arcVel = new THREE.Vector3();
  const teleportHit = new THREE.Vector3();
  const pickedHit = new THREE.Vector3();
  const pickedNormal = new THREE.Vector3();
  const quat = new THREE.Quaternion();

  let pickables: THREE.Object3D[] = [];
  let floors: THREE.Object3D[] = [];
  let snapCooldown = 0;
  let snapArmed = true;
  let aiming = false;
  let teleportValid = false;
  let hoverInfoId: string | null = null;
  let hoverInfo: WalkItem | null = null;

  function rootFor(id: string) {
    for (const r of pickables) if (r.userData.walkItemId === id || itemIdOf(r) === id) return r;
    return null;
  }

  function footprintRadius(item: WalkItem | null) {
    if (!item) return 0.4;
    return Math.max(item.dimensions[0], item.dimensions[2]) * 0.5 + 0.08;
  }

  // ------------------------------------------------------------ aiming

  function setReticle(ctl: Ctl, point: THREE.Vector3, n: THREE.Vector3) {
    ctl.reticle.position.copy(point).addScaledVector(n, 0.004);
    ctl.reticle.quaternion.setFromUnitVectors(FORWARD_Z, n);
    ctl.reticle.visible = true;
  }

  function aim(ctl: Ctl) {
    ctl.target = "none";
    ctl.itemId = null;
    ctl.button = null;
    ctl.wristAdd = false;
    ctl.hasFloor = false;
    ctl.reticle.visible = false;
    const live = ctl.handedness !== "none" && ctl.ray.visible;
    ctl.laser.visible = live;
    if (!live) return;

    raycaster.setFromXRController(ctl.ray);
    let best = LASER_MAX;
    const grabbing = grab?.ctl === ctl;

    // floor first, since grab and teleport both want it regardless of what is in front
    hits.length = 0;
    raycaster.intersectObjects(floors, true, hits);
    if (hits.length) {
      ctl.floorHit.copy(hits[0].point);
      ctl.hasFloor = true;
      best = hits[0].distance;
      ctl.target = "floor";
      pickedHit.copy(hits[0].point);
      pickedNormal.copy(UP);
    }

    if (!grabbing) {
      // items: box broadphase, then a precise test only on boxes nearer than the best hit
      for (let i = 0; i < pickables.length; i++) {
        if (!raycaster.ray.intersectBox(boxes[i], tmp)) continue;
        if (raycaster.ray.origin.distanceTo(tmp) >= best) continue;
        hits.length = 0;
        raycaster.intersectObject(pickables[i], true, hits);
        for (const h of hits) {
          if (h.distance >= best) break;
          const id = itemIdOf(h.object);
          if (!id) continue;
          best = h.distance;
          ctl.target = "item";
          ctl.itemId = id;
          pickedHit.copy(h.point);
          if (h.face) pickedNormal.copy(h.face.normal).transformDirection(h.object.matrixWorld);
          else pickedNormal.copy(UP);
          break;
        }
      }

      if (panel.mesh.visible) {
        hits.length = 0;
        raycaster.intersectObject(panel.mesh, false, hits);
        const h = hits[0];
        if (h && h.distance < best && h.uv) {
          best = h.distance;
          ctl.target = "panel";
          const px = h.uv.x * panel.canvas.width;
          const py = (1 - h.uv.y) * panel.canvas.height;
          if (py >= btnY && py <= btnY + btnH) {
            for (let i = 0; i < BUTTONS.length; i++) {
              if (px >= btnX(i) && px <= btnX(i) + btnW) ctl.button = BUTTONS[i];
            }
          }
          pickedHit.copy(h.point);
          pickedNormal.copy(FORWARD_Z).applyQuaternion(panel.mesh.getWorldQuaternion(quat));
        }
      }

      if (wrist.mesh.visible && wrist.mesh.parent !== ctl.ray) {
        hits.length = 0;
        raycaster.intersectObject(wrist.mesh, false, hits);
        const h = hits[0];
        if (h && h.distance < best && h.uv) {
          best = h.distance;
          ctl.target = "wrist";
          const px = h.uv.x * wrist.canvas.width;
          const py = (1 - h.uv.y) * wrist.canvas.height;
          ctl.wristAdd =
            !!options.onRequestAdd && px >= addBtn.x && px <= addBtn.x + addBtn.w && py >= addBtn.y && py <= addBtn.y + addBtn.h;
          pickedHit.copy(h.point);
          pickedNormal.copy(FORWARD_Z).applyQuaternion(wrist.mesh.getWorldQuaternion(quat));
        }
      }
    }

    ctl.laser.scale.z = best;
    const active = ctl.target === "item" || ctl.button !== null || ctl.wristAdd || grabbing;
    ctl.laser.material = active ? laserActive : laserIdle;
    if (ctl.target !== "none") setReticle(ctl, pickedHit, pickedNormal);
  }

  // ------------------------------------------------------------ grab

  function startGrab(ctl: Ctl, id: string, kind: Grab["kind"]) {
    const info = core.itemInfo(id);
    const root = rootFor(id);
    if (!info || !root || info.locked) return;
    if (grab) cancelGrab();
    grab = {
      id,
      ctl,
      kind,
      root,
      startPos: root.position.clone(),
      startRotY: root.rotation.y,
      offset: new THREE.Vector3(),
      offsetSet: false,
      turn: 0,
      info,
    };
  }

  function cancelGrab() {
    if (!grab) return;
    grab.root.position.copy(grab.startPos);
    grab.root.rotation.y = grab.startRotY;
    grab = null;
  }

  function dropGrab() {
    if (!grab) return;
    const g = grab;
    // moved in the root's parent space, which the engine keeps in plan meters
    const dx = g.root.position.x - g.startPos.x;
    const dz = g.root.position.z - g.startPos.z;
    g.root.position.copy(g.startPos);
    g.root.rotation.y = g.startRotY;
    grab = null;
    if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4 && Math.abs(g.turn) < 1e-4) return;
    core.setItemTransform(g.id, g.info.position[0] + dx, g.info.position[2] + dz, g.info.rotationY + g.turn);
    refreshPanel();
  }

  function updateGrab(dt: number, stickX: number) {
    if (!grab) return;
    const g = grab;
    if (Math.abs(stickX) > DEADZONE) g.turn -= stickX * GRAB_TURN_SPEED * dt;
    g.root.rotation.y = g.startRotY + g.turn;
    if (!g.ctl.hasFloor || !g.root.parent) return;
    tmp.copy(g.ctl.floorHit);
    g.root.parent.worldToLocal(tmp);
    if (!g.offsetSet) {
      g.offset.set(g.startPos.x - tmp.x, 0, g.startPos.z - tmp.z);
      g.offsetSet = true;
    }
    g.root.position.set(tmp.x + g.offset.x, g.startPos.y, tmp.z + g.offset.z);
  }

  // ------------------------------------------------------------ input events

  function refreshPanel() {
    const id = core.selectedId();
    panelItem = id ? core.itemInfo(id) : null;
    panelInfoAge = 0;
  }

  function onSelect(ctl: Ctl) {
    if (!xr.isPresenting) return;
    if (grab) {
      if (grab.ctl === ctl && grab.kind === "button") dropGrab();
      return;
    }
    if (ctl.target === "wrist") {
      if (ctl.wristAdd) options.onRequestAdd?.();
      return;
    }
    if (ctl.target === "panel") {
      const item = panelItem;
      if (!item || !ctl.button) return;
      if (ctl.button === "rotate") {
        core.rotate(item.id, ROTATE_STEP);
      } else if (item.locked) {
        return;
      } else if (ctl.button === "remove") {
        core.remove(item.id);
        if (core.selectedId() === item.id) core.select(null);
      } else if (ctl.button === "move") {
        startGrab(ctl, item.id, "button");
      }
      refreshPanel();
      return;
    }
    core.select(ctl.target === "item" ? ctl.itemId : null);
    refreshPanel();
  }

  function onSqueezeStart(ctl: Ctl) {
    if (!xr.isPresenting || grab) return;
    const id = ctl.target === "item" ? ctl.itemId : ctl.target === "panel" ? (panelItem?.id ?? null) : null;
    if (!id) return;
    if (core.selectedId() !== id) {
      core.select(id);
      refreshPanel();
    }
    startGrab(ctl, id, "squeeze");
  }

  function onSqueezeEnd(ctl: Ctl) {
    if (grab && grab.ctl === ctl && grab.kind === "squeeze") dropGrab();
  }

  function hideAll() {
    for (const c of ctls) {
      c.reticle.visible = false;
      c.target = "none";
    }
    panel.mesh.visible = false;
    wrist.mesh.visible = false;
    hoverRing.visible = false;
    selectRing.visible = false;
    arc.visible = false;
    landing.visible = false;
    aiming = false;
  }

  const onSessionStart = () => {
    attachWrist();
    refreshPanel();
    panelKey = "";
    wristKey = "";
  };
  const onSessionEnd = () => {
    cancelGrab();
    hideAll();
  };
  xr.addEventListener("sessionstart", onSessionStart);
  xr.addEventListener("sessionend", onSessionEnd);

  // ------------------------------------------------------------ locomotion

  function readStick(source: XRInputSource | undefined, out: THREE.Vector2) {
    out.set(0, 0);
    const axes = source?.gamepad?.axes;
    if (!axes) return;
    // xr-standard puts the thumbstick on axes 2 and 3; some runtimes only report 0 and 1
    if (axes.length >= 4) out.set(axes[2] ?? 0, axes[3] ?? 0);
    else if (axes.length >= 2) out.set(axes[0] ?? 0, axes[1] ?? 0);
  }

  function moveRigTo(x: number, z: number) {
    from.copy(rig.position);
    to.set(x, rig.position.y, z);
    const out = core.collide(from, to);
    rig.position.x = out.x;
    rig.position.z = out.z;
  }

  function snapTurn(angle: number) {
    // turn around the head so the wearer does not swing sideways
    tmp.set(rig.position.x - headPos.x, 0, rig.position.z - headPos.z).applyAxisAngle(UP, angle);
    rig.rotateOnWorldAxis(UP, angle);
    moveRigTo(headPos.x + tmp.x, headPos.z + tmp.z);
  }

  function traceArc(ctl: Ctl) {
    ctl.ray.getWorldPosition(arcPrev);
    ctl.ray.getWorldQuaternion(quat);
    arcVel.set(0, 0, -1).applyQuaternion(quat).multiplyScalar(ARC_SPEED);
    arcPositions[0] = arcPrev.x;
    arcPositions[1] = arcPrev.y;
    arcPositions[2] = arcPrev.z;
    let count = 1;
    teleportValid = false;
    for (let i = 1; i <= ARC_STEPS; i++) {
      arcNext.copy(arcPrev).addScaledVector(arcVel, ARC_DT);
      arcVel.y -= GRAVITY * ARC_DT;
      tmp2.subVectors(arcNext, arcPrev);
      const len = tmp2.length();
      arcCaster.set(arcPrev, tmp2.divideScalar(len || 1));
      arcCaster.far = len;
      hits.length = 0;
      arcCaster.intersectObjects(floors, true, hits);
      if (hits.length) {
        teleportHit.copy(hits[0].point);
        teleportValid = true;
        arcNext.copy(teleportHit);
      }
      arcPositions[count * 3] = arcNext.x;
      arcPositions[count * 3 + 1] = arcNext.y;
      arcPositions[count * 3 + 2] = arcNext.z;
      count++;
      arcPrev.copy(arcNext);
      if (teleportValid) break;
    }
    arcGeometry.setDrawRange(0, count);
    arcGeometry.attributes.position.needsUpdate = true;
    arcMaterial.color.copy(teleportValid ? ACCENT : DIM);
    arcMaterial.opacity = teleportValid ? 0.9 : 0.4;
    arc.visible = true;
    landing.visible = teleportValid;
    if (teleportValid) landing.position.copy(teleportHit).setY(teleportHit.y + 0.01);
  }

  const leftStick = new THREE.Vector2();
  const rightStick = new THREE.Vector2();

  function locomotion(dt: number) {
    const session = xr.getSession();
    let leftSource: XRInputSource | undefined;
    let rightSource: XRInputSource | undefined;
    if (session) {
      const sources = session.inputSources;
      for (let i = 0; i < sources.length; i++) {
        const s = sources[i];
        if (s.handedness === "left") leftSource = s;
        else if (s.handedness === "right") rightSource = s;
      }
    }
    readStick(leftSource, leftStick);
    readStick(rightSource, rightStick);

    const grabHand = grab ? grab.ctl.handedness : "none";
    if (grab) updateGrab(dt, grabHand === "left" ? leftStick.x : grabHand === "right" ? rightStick.x : 0);

    // left stick: smooth move along the head's yaw
    if (grabHand !== "left") {
      const mag = Math.hypot(leftStick.x, leftStick.y);
      if (mag > DEADZONE) {
        const e = xr.getCamera().matrixWorld.elements;
        let fx = -e[8];
        let fz = -e[10];
        const fl = Math.hypot(fx, fz) || 1;
        fx /= fl;
        fz /= fl;
        // right of forward (fx, fz) on the floor is (-fz, fx)
        const k = (MOVE_SPEED * dt * Math.min(1, (mag - DEADZONE) / (1 - DEADZONE))) / mag;
        const mx = (fx * -leftStick.y + -fz * leftStick.x) * k;
        const mz = (fz * -leftStick.y + fx * leftStick.x) * k;
        moveRigTo(rig.position.x + mx, rig.position.z + mz);
      }
    }

    // right stick: snap turn on x, teleport on push up
    snapCooldown = Math.max(0, snapCooldown - dt);
    if (grabHand === "right") {
      aiming = false;
      arc.visible = false;
      landing.visible = false;
      return;
    }
    const right = ctlFor("right");
    if (!aiming && rightStick.y < -0.6 && Math.abs(rightStick.x) < 0.6 && right) aiming = true;
    if (aiming) {
      if (rightStick.y > -0.35 || !right) {
        aiming = false;
        arc.visible = false;
        landing.visible = false;
        if (teleportValid) moveRigTo(rig.position.x + teleportHit.x - headPos.x, rig.position.z + teleportHit.z - headPos.z);
        teleportValid = false;
      } else {
        traceArc(right);
      }
      return;
    }
    if (Math.abs(rightStick.x) < 0.3) snapArmed = true;
    if (snapArmed && snapCooldown === 0 && Math.abs(rightStick.x) > 0.7) {
      snapTurn(rightStick.x > 0 ? -SNAP : SNAP);
      snapArmed = false;
      snapCooldown = SNAP_COOLDOWN;
    }
  }

  // ------------------------------------------------------------ frame

  function update(rawDt: number) {
    if (!xr.isPresenting) return;
    const dt = Math.min(Math.max(rawDt, 0), 0.1);

    pickables = core.pickables();
    floors = core.floors();
    rig.updateMatrixWorld(true);
    headPos.setFromMatrixPosition(xr.getCamera().matrixWorld);

    while (boxes.length < pickables.length) boxes.push(new THREE.Box3());
    for (let i = 0; i < pickables.length; i++) boxes[i].setFromObject(pickables[i]);

    wrist.mesh.visible = !!wrist.mesh.parent;
    if (wrist.mesh.visible) wrist.mesh.lookAt(headPos);

    for (const c of ctls) aim(c);
    locomotion(dt);
    // locomotion moved the rig; keep the controllers' world matrices in step for the next aim
    rig.updateMatrixWorld(true);

    // hover ring under whatever a free hand points at
    let hoverId: string | null = null;
    for (const c of ctls) if (c.target === "item" && c.itemId && grab?.ctl !== c) hoverId = c.itemId;
    const selected = core.selectedId();
    if (hoverId !== hoverInfoId) {
      hoverInfoId = hoverId;
      hoverInfo = hoverId ? core.itemInfo(hoverId) : null;
    }
    const hoverRoot = hoverId && hoverId !== selected ? rootFor(hoverId) : null;
    hoverRing.visible = !!hoverRoot;
    if (hoverRoot) {
      hoverRoot.getWorldPosition(tmp);
      hoverRing.position.set(tmp.x, tmp.y + 0.01, tmp.z);
      hoverRing.scale.setScalar(footprintRadius(hoverInfo));
    }

    // selection panel, refetched now and then so rotates and swaps from the HUD show up
    panelInfoAge += dt;
    if ((panelItem?.id ?? null) !== selected || panelInfoAge > 1) refreshPanel();
    const selRoot = panelItem ? rootFor(panelItem.id) : null;
    if (panelItem && selRoot) {
      selRoot.getWorldPosition(tmp);
      selectRing.visible = true;
      selectRing.position.set(tmp.x, tmp.y + 0.012, tmp.z);
      selectRing.scale.setScalar(footprintRadius(panelItem));
      panel.mesh.visible = !grab;
      panel.mesh.position.set(tmp.x, tmp.y + panelItem.dimensions[1] + 0.32, tmp.z);
      panel.mesh.lookAt(headPos.x, panel.mesh.position.y, headPos.z);
      let hot: ButtonId | null = null;
      for (const c of ctls) if (c.target === "panel" && c.button) hot = c.button;
      drawPanel(panelItem, hot);
    } else {
      selectRing.visible = false;
      panel.mesh.visible = false;
    }

    let wristHot = false;
    for (const c of ctls) if (c.wristAdd) wristHot = true;
    drawWrist(wristHot, !!grab);
  }

  // ------------------------------------------------------------ dispose

  function disposeTree(root: THREE.Object3D) {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
      const list = Array.isArray(m) ? m : m ? [m] : [];
      for (const mat of list) {
        for (const value of Object.values(mat)) if (value instanceof THREE.Texture) value.dispose();
        mat.dispose();
      }
    });
  }

  function dispose() {
    cancelGrab();
    xr.removeEventListener("sessionstart", onSessionStart);
    xr.removeEventListener("sessionend", onSessionEnd);
    for (const c of ctls) {
      c.ray.removeEventListener("connected", c.onConnected);
      c.ray.removeEventListener("disconnected", c.onDisconnected);
      c.ray.removeEventListener("select", c.onSelect);
      c.ray.removeEventListener("squeezestart", c.onSqueezeStart);
      c.ray.removeEventListener("squeezeend", c.onSqueezeEnd);
      c.laser.removeFromParent();
      c.reticle.removeFromParent();
      c.model.removeFromParent();
      disposeTree(c.model);
      c.ray.removeFromParent();
      c.grip.removeFromParent();
    }
    for (const o of [hoverRing, selectRing, arc, landing, panel.mesh, wrist.mesh]) o.removeFromParent();
    laserGeometry.dispose();
    laserIdle.dispose();
    laserActive.dispose();
    reticleGeometry.dispose();
    reticleMaterial.dispose();
    ringGeometry.dispose();
    hoverRingMaterial.dispose();
    selectRingMaterial.dispose();
    arcGeometry.dispose();
    arcMaterial.dispose();
    for (const p of [panel, wrist]) {
      p.texture.dispose();
      p.material.dispose();
      p.mesh.geometry.dispose();
    }
    pickables = [];
    floors = [];
  }

  return { update, dispose };
}
