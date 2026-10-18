import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { block, place, rug, standingLamp } from "./parts";

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
  fill: THREE.MeshBasicMaterial;
  line: THREE.LineBasicMaterial;
};

// drawing palette: white paper, graphite edges
const PAPER = "#ffffff";
const INK = "#141414";
const PICKED_FILL = "#e9e9e7";

// flat white, unlit, pushed back a touch so the ink edges never z-fight
function sheet(color = PAPER) {
  return new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

// back-face hull pushed out along the normal in view space, so the contour is
// the same pencil weight at any distance
const contour = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });
contour.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader.replace(
    "#include <project_vertex>",
    `vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
    mvPosition.xyz += normalize( normalMatrix * normal ) * ( -mvPosition.z ) * 0.0017;
    gl_Position = projectionMatrix * mvPosition;`,
  );
};

function contours(root: THREE.Object3D) {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh && o.geometry.attributes.normal) meshes.push(o);
  });
  for (const m of meshes) {
    const hull = new THREE.Mesh(m.geometry, contour);
    hull.raycast = () => {};
    hull.userData.noEdges = true;
    m.add(hull);
  }
}

// outline every mesh under root with its hard edges
function inkEdges(root: THREE.Object3D, line: THREE.LineBasicMaterial, angle = 30) {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh && !o.userData.noEdges) meshes.push(o);
  });
  for (const m of meshes) {
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, angle), line);
    edges.raycast = () => {};
    m.add(edges);
  }
}

// room interior, metres. x right, y up, z toward the viewer.
const X0 = -3;
const X1 = 3;
const Z0 = -2.4;
const Z1 = 3.8;
const H = 2.7;
const WIN = { z0: -1.75, z1: 0.15, y0: 0.72, y1: 2.28 };

function buildShell(scene: THREE.Scene) {
  const wall = sheet();
  const trim = sheet();
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
  const floor = new THREE.Mesh(floorGeo, sheet());
  floor.userData.noEdges = true;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(12, 48, INK, INK);
  const gm = grid.material as THREE.LineBasicMaterial;
  gm.transparent = true;
  gm.opacity = 0.1;
  grid.position.set(0, 0.002, 0.7);
  scene.add(grid);

  // ceiling
  solid(X1 - X0 + 2 * t, t, Z1 - Z0 + t, 0, H, (Z0 + Z1) / 2);
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
  const frame = sheet();
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
    new THREE.MeshBasicMaterial({ color: PAPER }),
  );
  sky.userData.noEdges = true;
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
  { name: "Rug", make: () => rug(3.0, 2.1, "#d6cab6"), at: [0, 0, -0.95], casts: false },
  { name: "Sofa", model: "sofa_02", at: [0, 0, -1.94] },
  { name: "Coffee table", model: "modern_coffee_table_01", at: [0, 0, -0.75], rot: Math.PI / 2 },
  { name: "Lounge chair", model: "mid_century_lounge_chair", at: [-1.85, 0, -0.45], rot: Math.PI / 2 + 0.45 },
  { name: "Cabinet", model: "modern_wooden_cabinet", at: [2.72, 0, -0.35], rot: -Math.PI / 2 },
  { name: "Shelves", model: "wooden_display_shelves_01", at: [2.15, 0, -2.2], rot: Math.PI / 2 },
  { name: "Side table", model: "side_table_01", at: [1.38, 0, -2.08] },
  { name: "Vase", model: "ceramic_vase_01", at: [1.38, 0, -2.08], on: "Side table" },
  { name: "Floor lamp", make: () => standingLamp(), at: [-1.2, 0, -2.08] },
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
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = false;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;

  let shadowFrames = 3;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PAPER);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.35;

  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 40);
  const eye = new THREE.Vector3(0, 1.45, 3.2);
  const look = new THREE.Vector3(0, 1.2, Z0);
  camera.position.copy(eye);
  camera.lookAt(look);

  buildShell(scene);
  inkEdges(scene, new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.5 }), 20);

  // soft, even daylight so the drawing reads, with quiet shadows for depth
  const sun = new THREE.DirectionalLight("#fffaf2", 1.5);
  sun.position.set(X0 - 5, 3.4, -2.2);
  sun.target.position.set(-0.6, 0, 0.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 16 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 6;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight("#ffffff", "#d8d1c4", 1.5));
  const bounce = new THREE.PointLight("#fffaf2", 0.6, 8, 1.2);
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
      const fill = sheet();
      const line = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.72 });
      const lights: THREE.Light[] = [];
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = s.casts !== false;
          o.receiveShadow = true;
          o.material = fill;
        }
        if (o instanceof THREE.PointLight) lights.push(o);
      });
      for (const l of lights) l.removeFromParent();
      inkEdges(root, line, s.name === "Sofa" ? 70 : 45);
      contours(root);
      scene.add(root);
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      const v = box.getSize(new THREE.Vector3());
      items.push({ name: s.name, root, box, size: [v.x, v.y, v.z], fill, line });
      roots.push(root);
    }
    shadowFrames = 3;
  })();

  const outline = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(INK));
  const outlineMat = outline.material as THREE.LineBasicMaterial;
  outlineMat.transparent = true;
  outlineMat.opacity = 0.9;
  outlineMat.depthTest = false;
  outline.renderOrder = 10;
  outline.visible = false;
  scene.add(outline);

  // post: multisampled target and ambient occlusion for depth
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  let gtao: GTAOPass | null = null;
  if (!lite) {
    gtao = new GTAOPass(scene, camera, 1, 1);
    gtao.updateGtaoMaterial({ radius: 0.32, distanceExponent: 1.6, thickness: 1.0, scale: 1.0, samples: 24 });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 10, rings: 3, samples: 24 });
    gtao.blendIntensity = 0.55;
    composer.addPass(gtao);
  }
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

  // pointer: hover picking only, the camera stays put
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let pointerDirty = false;
  let hovered: Item | null = null;

  const toNdc = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    toNdc(e);
    pointerDirty = true;
  };
  const onLeave = () => {
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
    if (hovered) {
      hovered.fill.color.set(PAPER);
      hovered.line.opacity = 0.72;
    }
    hovered = next;
    canvas.style.cursor = next ? "pointer" : "";
    if (next) {
      next.fill.color.set(PICKED_FILL);
      next.line.opacity = 1;
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
    if (pointerDirty) {
      pointerDirty = false;
      setHover(pick());
    }
    if (hovered) {
      const b = hovered.box;
      anchor.set(b.max.x, b.max.y, b.max.z).project(camera);
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
        if (o instanceof THREE.LineSegments) o.geometry.dispose();
        if (o.userData.noEdges && o instanceof THREE.Mesh && o.material === contour) return;
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
