import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { block, place, rug, standingLamp, surface } from "./parts";

export type Picked = {
  name: string;
  size: [number, number, number]; // x, y, z in metres
  screen: { x: number; y: number };
};

type Item = {
  name: string;
  root: THREE.Group;
  box: THREE.Box3;
  size: [number, number, number];
  mats: { m: THREE.MeshStandardMaterial; emissive: THREE.Color; intensity: number }[];
};

// room interior, metres. x right, y up, z toward the viewer.
const X0 = -3;
const X1 = 3;
const Z0 = -2.4;
const Z1 = 3.8;
const H = 2.7;
const WIN = { z0: -1.75, z1: 0.15, y0: 0.72, y1: 2.28 };

function buildShell(scene: THREE.Scene) {
  const wall = surface("#ebe5da", 0.95);
  const trim = surface("#f2eee7", 0.7);
  const t = 0.12;
  const solid = (w: number, h: number, d: number, x: number, y: number, z: number, m = wall) => {
    const mesh = place(block(w, h, d, m, 0), x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  };

  // floor, uv in metres so the planks keep their scale
  const floorGeo = new THREE.PlaneGeometry(X1 - X0, Z1 - Z0);
  floorGeo.rotateX(-Math.PI / 2);
  floorGeo.translate((X0 + X1) / 2, 0, (Z0 + Z1) / 2);
  const uv = floorGeo.attributes.uv;
  const pos = floorGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / 2.2, pos.getZ(i) / 2.2);
  const tex = new THREE.TextureLoader();
  const load = (name: string, color = false) => {
    const t = tex.load(`/textures/wood_floor_${name}.jpg`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const floor = new THREE.Mesh(
    floorGeo,
    new THREE.MeshStandardMaterial({
      map: load("diff", true),
      normalMap: load("nor_gl"),
      roughnessMap: load("rough"),
      color: "#f2e6d6",
    }),
  );
  floor.receiveShadow = true;
  scene.add(floor);

  // ceiling
  solid(X1 - X0 + 2 * t, t, Z1 - Z0 + t, 0, H, (Z0 + Z1) / 2, surface("#f1ede6", 1));
  // back and right walls
  solid(X1 - X0 + 2 * t, H, t, 0, 0, Z0 - t / 2);
  solid(t, H, Z1 - Z0, X1 + t / 2, 0, (Z0 + Z1) / 2);
  // left wall, cut around the window
  const lx = X0 - t / 2;
  solid(t, WIN.y0, WIN.z1 - WIN.z0, lx, 0, (WIN.z0 + WIN.z1) / 2);
  solid(t, H - WIN.y1, WIN.z1 - WIN.z0, lx, WIN.y1, (WIN.z0 + WIN.z1) / 2);
  solid(t, H, WIN.z0 - Z0 + t, lx, 0, (Z0 - t + WIN.z0) / 2);
  solid(t, H, Z1 - WIN.z1, lx, 0, (WIN.z1 + Z1) / 2);

  // window frame and mullion
  const frame = surface("#f4f1eb", 0.5);
  const fw = 0.05;
  const zc = (WIN.z0 + WIN.z1) / 2;
  solid(0.08, fw, WIN.z1 - WIN.z0, X0 + 0.0, WIN.y0, zc, frame);
  solid(0.08, fw, WIN.z1 - WIN.z0, X0 + 0.0, WIN.y1 - fw, zc, frame);
  solid(0.08, WIN.y1 - WIN.y0, fw, X0, WIN.y0, WIN.z0 + fw / 2, frame);
  solid(0.08, WIN.y1 - WIN.y0, fw, X0, WIN.y0, WIN.z1 - fw / 2, frame);
  solid(0.06, WIN.y1 - WIN.y0, 0.035, X0, WIN.y0, zc, frame);
  solid(0.06, 0.035, WIN.z1 - WIN.z0, X0, (WIN.y0 + WIN.y1) / 2 + 0.2, zc, frame);
  solid(0.2, 0.03, WIN.z1 - WIN.z0 + 0.1, X0 + 0.06, WIN.y0 - 0.03, zc, trim);

  // bright daylight behind the glass
  const sky = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 4),
    new THREE.MeshBasicMaterial({ color: new THREE.Color("#fff6e8").multiplyScalar(1.15), toneMapped: true }),
  );
  sky.rotation.y = Math.PI / 2;
  sky.position.set(X0 - 1.2, 1.5, zc);
  scene.add(sky);

  // skirting
  solid(X1 - X0, 0.08, 0.015, 0, 0, Z0 + 0.008, trim);
  solid(0.015, 0.08, Z1 - Z0, X1 - 0.008, 0, (Z0 + Z1) / 2, trim);
}

type Spec = {
  name: string;
  at: [number, number, number];
  rot?: number;
  model?: string; // glb in /public/models
  make?: () => THREE.Group;
  on?: string; // sits on top of another item
  wall?: boolean; // hangs flat against the back wall
  casts?: boolean;
};

const SPECS: Spec[] = [
  { name: "Rug", make: () => rug(3.0, 2.1, "#d6cab6"), at: [0.1, 0, -0.95], casts: false },
  { name: "Sofa", model: "sofa_02", at: [0.1, 0, -1.94] },
  { name: "Coffee table", model: "modern_coffee_table_01", at: [0.1, 0, -0.75], rot: Math.PI / 2 },
  { name: "Lounge chair", model: "mid_century_lounge_chair", at: [-1.85, 0, -0.45], rot: Math.PI / 2 + 0.45 },
  { name: "Cabinet", model: "modern_wooden_cabinet", at: [2.72, 0, -0.35], rot: -Math.PI / 2 },
  { name: "Shelves", model: "wooden_display_shelves_01", at: [2.15, 0, -2.2], rot: Math.PI / 2 },
  { name: "Plant", model: "potted_plant_01", at: [-2.42, 0, -1.85] },
  { name: "Side table", model: "side_table_01", at: [1.38, 0, -2.08] },
  { name: "Vase", model: "ceramic_vase_01", at: [1.38, 0, -2.08], on: "Side table" },
  { name: "Floor lamp", make: () => standingLamp(), at: [-1.2, 0, -2.08] },
  { name: "Picture frame", model: "hanging_picture_frame_02", at: [0.1, 1.2, Z0], wall: true, casts: false },
];

const gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

// glb origins vary, so recentre each model on its footprint with its base at y = 0
async function loadModel(name: string) {
  const { scene } = await gltf.loadAsync(`/models/${name}.glb`);
  const box = new THREE.Box3().setFromObject(scene);
  const c = box.getCenter(new THREE.Vector3());
  scene.position.set(-c.x, -box.min.y, -c.z);
  const out = new THREE.Group();
  out.add(scene);
  return out;
}

export function createRoom(
  canvas: HTMLCanvasElement,
  onPick: (p: Picked | null) => void,
  { lite = false }: { lite?: boolean } = {},
) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lite ? 1.5 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;

  let shadowFrames = 3;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#e9e3d8");
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.2;

  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 40);
  const eye = new THREE.Vector3(0.35, 1.52, 3.0);
  const look = new THREE.Vector3(-0.15, 0.82, -1.3);
  camera.position.copy(eye);
  camera.lookAt(look);

  buildShell(scene);

  // daylight through the window: warm sun plus a cool sky fill
  const sun = new THREE.DirectionalLight("#ffd6a0", 4.2);
  sun.position.set(X0 - 5, 3.4, -2.2);
  sun.target.position.set(-0.6, 0, 0.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 16 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 4;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight("#f3ebdf", "#6f604f", 0.32));
  const bounce = new THREE.PointLight("#fff1dd", 0.45, 7, 1.4);
  bounce.position.set(0.6, 2.3, 1.2);
  scene.add(bounce);

  const items: Item[] = [];
  const roots: THREE.Group[] = [];
  let disposed = false;

  const ready = (async () => {
    const built = await Promise.all(SPECS.map(async (s) => ({ s, root: s.model ? await loadModel(s.model) : s.make!() })));
    if (disposed) return;
    for (const { s, root } of built) {
      root.rotation.y = s.rot ?? 0;
      root.position.set(...s.at);
      if (s.on) {
        const base = items.find((i) => i.name === s.on);
        if (base) root.position.y = base.box.max.y;
      }
      if (s.wall) {
        root.updateMatrixWorld(true);
        const b = new THREE.Box3().setFromObject(root);
        root.position.z += Z0 - b.min.z + 0.005;
      }
      const mats: Item["mats"] = [];
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = s.casts !== false;
          o.receiveShadow = true;
          for (const m of (Array.isArray(o.material) ? o.material : [o.material]) as THREE.MeshStandardMaterial[]) {
            if (!m.emissive || mats.some((e) => e.m === m)) continue;
            mats.push({ m, emissive: m.emissive.clone(), intensity: m.emissiveIntensity });
          }
        }
        if (o instanceof THREE.PointLight) {
          o.castShadow = true;
          o.shadow.mapSize.set(512, 512);
          o.shadow.bias = -0.002;
          o.shadow.normalBias = 0.03;
          o.shadow.radius = 5;
        }
      });
      scene.add(root);
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      const v = box.getSize(new THREE.Vector3());
      items.push({ name: s.name, root, box, size: [v.x, v.y, v.z], mats });
      roots.push(root);
    }
    shadowFrames = 3;
  })();

  const outline = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color("#1f1d1a"));
  const outlineMat = outline.material as THREE.LineBasicMaterial;
  outlineMat.transparent = true;
  outlineMat.opacity = 0.75;
  outlineMat.depthTest = false;
  outline.renderOrder = 10;
  outline.visible = false;
  scene.add(outline);

  // post: multisampled target, ambient occlusion, a touch of bloom on the bright window
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  let gtao: GTAOPass | null = null;
  if (!lite) {
    gtao = new GTAOPass(scene, camera, 1, 1);
    gtao.updateGtaoMaterial({ radius: 0.32, distanceExponent: 1.6, thickness: 1.0, scale: 1.0, samples: 24 });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 10, rings: 3, samples: 24 });
    gtao.blendIntensity = 1;
    composer.addPass(gtao);
  }
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.16, 0.25, 1.0);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
    camera.aspect = w / h;
    // keep the sofa wall in frame on tall screens
    camera.fov = camera.aspect < 1 ? 68 : 50;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  // pointer: gentle look-around plus hover picking
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const aim = new THREE.Vector2();
  const lookNow = new THREE.Vector2();
  let pointerDirty = false;
  let hovered: Item | null = null;

  const toNdc = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    toNdc(e);
    aim.copy(ndc);
    pointerDirty = true;
  };
  const onLeave = () => {
    aim.set(0, 0);
    setHover(null);
  };
  const onTap = (e: PointerEvent) => {
    if (e.pointerType === "mouse") return;
    toNdc(e);
    const hit = pick();
    setHover(hit === hovered ? null : hit);
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointerup", onTap);

  function pick(): Item | null {
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(roots, true)[0];
    if (!hit) return null;
    let o: THREE.Object3D | null = hit.object;
    while (o && !roots.includes(o as THREE.Group)) o = o.parent;
    return items.find((i) => i.root === o) ?? null;
  }

  function setHover(next: Item | null) {
    if (next === hovered) return;
    if (hovered) for (const e of hovered.mats) {
      e.m.emissive.copy(e.emissive);
      e.m.emissiveIntensity = e.intensity;
    }
    hovered = next;
    canvas.style.cursor = next ? "pointer" : "";
    if (next) {
      for (const e of next.mats) {
        if (e.intensity > 1) continue; // leave the glowing lamp shade alone
        e.m.emissive.set("#ffe9cc");
        e.m.emissiveIntensity = 0.05;
      }
      outline.box.copy(next.box).expandByScalar(0.015);
      outline.visible = true;
    } else {
      outline.visible = false;
      onPick(null);
    }
  }

  const anchor = new THREE.Vector3();
  let raf = 0;
  const tick = () => {
    lookNow.lerp(aim, 0.06);
    camera.position.set(eye.x + lookNow.x * 0.18, eye.y + lookNow.y * 0.06, eye.z);
    camera.lookAt(look.x + lookNow.x * 0.9, look.y + lookNow.y * 0.45, look.z);

    if (pointerDirty) {
      pointerDirty = false;
      setHover(pick());
    }
    if (hovered) {
      const b = hovered.box;
      anchor.set((b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2).project(camera);
      onPick({
        name: hovered.name,
        size: hovered.size,
        screen: { x: (anchor.x * 0.5 + 0.5) * canvas.clientWidth, y: (-anchor.y * 0.5 + 0.5) * canvas.clientHeight },
      });
    }

    if (shadowFrames > 0) {
      renderer.shadowMap.needsUpdate = true;
      shadowFrames--;
    }
    composer.render();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    count: SPECS.length,
    ready,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerup", onTap);
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          const m = o.material as THREE.MeshStandardMaterial;
          m.map?.dispose();
          m.dispose();
        }
      });
      gtao?.dispose();
      composer.dispose();
      target.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
