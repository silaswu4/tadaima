import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { dracoLoader } from "./draco";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import type { RoomPlan } from "../../backend/contracts";
import { block } from "./parts";
import { createRoomLighting, setMetricSurfaceUVs } from "./lighting";
import { createFurnitureProxy, placeFurnitureModel } from "./furniture-model";
import { galleryPart } from "./gallery-parts";
import { LIBRARY, assetTransform, type LibraryModel } from "../../backend/shopping/assets";
import type { WalkOptions } from "./walk-api";
import { bindTexturedRoom, validateLocalTexturedGlb } from "./textured-model";
import { applyBakedIndirect, bakedPoseMatches, ownBakedIndirectMaterials, setBakedIndirectEnabled } from "./baked-indirect";
import { prepareWindowGlass } from "./window-glass";

export type IsoGallery = {
  ready: Promise<void>;
  /** Build in the room at `index`, sliding from the side given by `direction`. Resolves when settled. */
  showRoom(index: number, direction?: 1 | -1): Promise<void>;
  dispose(): void;
};

type Options = { initial?: number; reducedMotion?: boolean; lite?: boolean };

/** A pre-built room: one node of a GLB whose surfaces use baked color textures. */
export type BakedRoom = {
  glbUrl: string;
  node: string;
  /** Material-name substring to baked texture URL; the first match wins. */
  textures: { match: string; url: string }[];
  fallbackTexture: string;
  /** Longest floor side in meters after scaling, so baked rooms sit at the same size as plan rooms. */
  footprint?: number;
};
export type GallerySource = { plan?: RoomPlan; baked?: BakedRoom; reconstruction?: WalkOptions["reconstruction"] };

const BACKGROUND = "#f5f2eb";
const CLAY = "#e4ddd1";
// Long lens from far away: reads close to isometric while keeping real depth.
const FOV = 14;
const VIEW = new THREE.Vector3(1, 0.92, 1.18).normalize();

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
const easeInOutQuart = (t: number) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2);

type Tween = { start: number; duration: number; ease: (t: number) => number; step: (v: number) => void; done?: () => void };
type Uniforms = { uReveal: { value: number }; uClay: { value: THREE.Color }; uOrigin: { value: THREE.Vector2 }; uSpan: { value: number } };

/** Patch a standard material so it fades from flat clay to its real finish, rippling out from the room center. */
function withReveal(material: THREE.Material, uniforms: Uniforms) {
  if (!(material instanceof THREE.MeshStandardMaterial) || material.userData.isoReveal) return;
  material.userData.isoReveal = true;
  const before = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vIsoLocal;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvIsoLocal = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vIsoLocal;
uniform float uReveal;
uniform vec3 uClay;
uniform vec2 uOrigin;
uniform float uSpan;
float isoHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }
float isoNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(isoHash(i), isoHash(i + vec2(1, 0)), u.x), mix(isoHash(i + vec2(0, 1)), isoHash(i + vec2(1, 1)), u.x), u.y);
}`,
      )
      .replace(
        "#include <opaque_fragment>",
        `float isoDist = length(vIsoLocal.xz - uOrigin) / uSpan + vIsoLocal.y * 0.08;
float isoMask = smoothstep(0.0, 0.18, uReveal * 1.35 - isoDist - isoNoise(vIsoLocal.xz * 2.2) * 0.22);
outgoingLight = mix(uClay, outgoingLight, isoMask);
#include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => `${previousKey}:iso-reveal-v1`;
  material.needsUpdate = true;
}

const libraryModels = Object.values(LIBRARY).flat();
const libraryByUrl = (url: string) => libraryModels.find((m) => m.url === url) ?? null;

function releaseAll(roots: Iterable<THREE.Object3D>) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  for (const root of roots) root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    geometries.add(node.geometry);
    for (const m of Array.isArray(node.material) ? node.material : [node.material]) {
      materials.add(m);
      for (const value of Object.values(m)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  const images = new Set<ImageBitmap>();
  for (const texture of textures) {
    if (typeof ImageBitmap !== "undefined" && texture.image instanceof ImageBitmap) images.add(texture.image);
    texture.dispose();
  }
  for (const image of images) image.close();
  for (const material of materials) material.dispose();
}

const release = (root: THREE.Object3D) => releaseAll([root]);

type RoomView = {
  pivot: THREE.Group;
  floor: THREE.Group;
  walls: { root: THREE.Group; height: number }[];
  furniture: { root: THREE.Group; rest: THREE.Vector3; order: number }[];
  uniforms: Uniforms;
  bounds: THREE.Box3;
};

export function createIsoGallery(canvas: HTMLCanvasElement, sources: GallerySource[], options: Options = {}): IsoGallery {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, options.lite ? 1.5 : 2));
  renderer.setClearColor(BACKGROUND);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const lighting = createRoomLighting(renderer, scene, options.lite);
  scene.add(new THREE.HemisphereLight("#eef2ff", "#b6a48c", 0.5));
  const sun = new THREE.DirectionalLight("#fff3e0", 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(options.lite ? 1024 : 2048);
  sun.shadow.radius = 4;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.ShadowMaterial({ opacity: 0.12 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.141;
  ground.receiveShadow = true;
  scene.add(ground);

  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 400);
  // Every room sits centered on the origin inside its own pivot; the stage tilts under the cursor.
  const stage = new THREE.Group();
  scene.add(stage);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setDRACOLoader(dracoLoader());
  // Binding reparents source entities. Keep resource owners even if an item is
  // removed/stored or binding fails partway through the private reconstruction.
  const retained = new Set<THREE.Object3D>();
  let disposed = false;

  function buildRoom(plan: RoomPlan, reconstruction?: WalkOptions["reconstruction"]): { view: RoomView; loaded: Promise<void> } {
    const pivot = new THREE.Group();
    const content = new THREE.Group();
    pivot.add(content);
    pivot.visible = false;
    stage.add(pivot);
    const floorPlan = plan.geometry.rooms[0];
    const xs = plan.geometry.rooms.flatMap((room) => room.floorPolygon.map((p) => p[0]));
    const zs = plan.geometry.rooms.flatMap((room) => room.floorPolygon.map((p) => p[1]));
    const center = new THREE.Vector3((Math.min(...xs) + Math.max(...xs)) / 2, 0, (Math.min(...zs) + Math.max(...zs)) / 2);
    content.position.copy(center).negate();
    const uniforms: Uniforms = {
      uReveal: { value: 0 },
      uClay: { value: new THREE.Color(CLAY) },
      uOrigin: { value: new THREE.Vector2(center.x, center.z) },
      uSpan: { value: Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2 },
    };

    const floor = new THREE.Group();
    if (!reconstruction) {
      const shape = new THREE.Shape(floorPlan.floorPolygon.map(([x, z]) => new THREE.Vector2(x - center.x, -(z - center.z))));
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.14, bevelEnabled: false });
      geometry.rotateX(-Math.PI / 2);
      setMetricSurfaceUVs(geometry, 1.2);
      const floorMesh = new THREE.Mesh(geometry, lighting.makeSurface("floor"));
      floorMesh.receiveShadow = true;
      floor.position.set(center.x, -0.14, center.z);
      floor.add(floorMesh);
    }
    content.add(floor);

    // Cutaway: keep only the walls facing away from the camera, with real openings.
    const walls: RoomView["walls"] = [];
    for (const wall of reconstruction ? [] : plan.geometry.walls) {
      const dx = wall.end[0] - wall.start[0];
      const dz = wall.end[1] - wall.start[1];
      const length = Math.hypot(dx, dz);
      if (length <= 0) continue;
      const mid = new THREE.Vector3((wall.start[0] + wall.end[0]) / 2, 0, (wall.start[1] + wall.end[1]) / 2);
      if (new THREE.Vector3(VIEW.x, 0, VIEW.z).dot(mid.sub(center)) > 0) continue;
      const material = lighting.makeSurface("wall");
      const root = new THREE.Group();
      const openings = plan.geometry.openings.filter((o) => o.wallId === wall.id);
      const cuts = [...new Set([0, length, ...openings.flatMap((o) => [o.offset, o.offset + o.width].map((v) => THREE.MathUtils.clamp(v, 0, length)))])].sort(
        (a, b) => a - b,
      );
      for (let i = 0; i < cuts.length - 1; i++) {
        const a = cuts[i];
        const b = cuts[i + 1];
        const middle = (a + b) / 2;
        const holes = openings
          .filter((o) => middle > o.offset && middle < o.offset + o.width)
          .map((o) => [Math.max(0, o.sillHeight), Math.min(wall.height, o.sillHeight + o.height)])
          .sort((p, q) => p[0] - q[0]);
        let bottom = 0;
        const spans: number[][] = [];
        for (const [low, high] of holes) {
          if (low > bottom) spans.push([bottom, low]);
          bottom = Math.max(bottom, high);
        }
        if (bottom < wall.height) spans.push([bottom, wall.height]);
        for (const [low, high] of spans) {
          const mesh = block(b - a, high - low, wall.thickness, material, 0);
          setMetricSurfaceUVs(mesh.geometry, 1, undefined, [middle, low]);
          mesh.position.set(wall.start[0] + (dx * middle) / length, low, wall.start[1] + (dz * middle) / length);
          mesh.rotation.y = -Math.atan2(dz, dx);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          root.add(mesh);
        }
      }
      content.add(root);
      walls.push({ root, height: wall.height });
    }

    const sourceReady = reconstruction ? (async () => {
      validateLocalTexturedGlb(reconstruction.texturedModel);
      // Never bind against an edited shopping revision or accept shell edits.
      if (plan.projectId !== reconstruction.plan.projectId || JSON.stringify(plan.geometry) !== JSON.stringify(reconstruction.plan.geometry)) {
        throw new Error("Gallery room geometry does not match its reconstruction source.");
      }
      const gltf = await loader.parseAsync(reconstruction.texturedModel, "");
      if (disposed) { release(gltf.scene); return null; }
      gltf.scene.traverse((node) => { if (node instanceof THREE.Mesh) retained.add(node); });
      prepareWindowGlass(gltf.scene);
      applyBakedIndirect(gltf.scene);
      const bound = bindTexturedRoom(gltf.scene, reconstruction.plan, reconstruction.binding);
      prepareWindowGlass(bound.shell);
      for (const room of reconstruction.plan.geometry.rooms) {
        const node = bound.shell.children.find((child) => child.userData.entityId === room.id);
        if (node) floor.add(node);
      }
      for (const wall of reconstruction.plan.geometry.walls) {
        const node = bound.shell.children.find((child) => child.userData.entityId === wall.id);
        if (!node) continue;
        const root = new THREE.Group();
        root.add(node);
        for (const opening of reconstruction.plan.geometry.openings.filter((entry) => entry.wallId === wall.id)) {
          const trim = bound.shell.children.find((child) => child.userData.entityId === opening.id);
          if (trim) root.add(trim);
        }
        const midpoint = new THREE.Vector3((wall.start[0] + wall.end[0]) / 2, 0, (wall.start[1] + wall.end[1]) / 2);
        root.visible = new THREE.Vector3(VIEW.x, 0, VIEW.z).dot(midpoint.sub(center)) <= 0;
        content.add(root);
        if (root.visible) walls.push({ root, height: wall.height });
      }
      return bound;
    })() : Promise.resolve(null);

    const furniture: RoomView["furniture"] = [];
    const loaded = Promise.all(
      plan.items.filter((item) => !item.stored).map(async (item) => {
        const bound = await sourceReady;
        if (disposed) return;
        const captured = bound?.furniture.get(item.id);
        if (captured) {
          const original = reconstruction!.plan.items.find((entry) => entry.id === item.id)!;
          ownBakedIndirectMaterials(captured);
          if (JSON.stringify(item.dimensions) !== JSON.stringify(original.dimensions)) throw new Error("Captured furniture dimensions cannot change in the gallery.");
          // The bound wrapper already owns the canonical pose and its children
          // are local. Apply the editable pose once, without mesh recentering.
          captured.position.fromArray(item.position);
          captured.rotation.y = item.rotationY;
          setBakedIndirectEnabled(captured, bakedPoseMatches(original, captured.position, captured.rotation.y));
          content.add(captured);
          furniture.push({ root: captured, rest: captured.position.clone(), order: Math.hypot(captured.position.x - center.x, captured.position.z - center.z) });
          return;
        }
        const size = item.dimensions;
        let model: THREE.Object3D | null = galleryPart(item.id, size, { category: item.category, assetUrl: item.assetUrl });
        let library: LibraryModel | null = null;
        if (!model) {
          try {
            if (!item.assetUrl) throw new Error("No asset");
            library = libraryByUrl(item.assetUrl);
            model = (await loader.loadAsync(item.assetUrl)).scene;
          } catch {
            library = null;
            model = createFurnitureProxy(size ?? [0.8, 0.8, 0.8]);
          }
        }
        if (disposed) {
          release(model);
          return;
        }
        // Draw every piece at its listed real-world size, in the shared width-on-X frame.
        const turn = new THREE.Group();
        if (library && (size || item.productId)) turn.rotation.y = library.yaw;
        turn.add(model);
        const scaler = new THREE.Group();
        scaler.add(turn);
        if (size) {
          if (library) scaler.scale.fromArray(assetTransform(library, size).scale);
          else {
            const measured = new THREE.Box3().setFromObject(scaler, true).getSize(new THREE.Vector3());
            scaler.scale.set(
              measured.x > 1e-4 ? size[0] / measured.x : 1,
              measured.y > 1e-4 ? size[1] / measured.y : 1,
              measured.z > 1e-4 ? size[2] / measured.z : 1,
            );
          }
        }
        model = scaler;
        const { root } = placeFurnitureModel(item, model);
        root.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            node.castShadow = true;
            node.receiveShadow = true;
          }
        });
        content.add(root);
        furniture.push({ root, rest: root.position.clone(), order: Math.hypot(root.position.x - center.x, root.position.z - center.z) });
      }),
    ).then(async () => {
      // Empty/stored-only rooms must still validate and load their shell.
      await sourceReady;
      if (disposed) return;
      furniture.sort((a, b) => a.order - b.order);
      content.traverse((node) => {
        if (node instanceof THREE.Mesh) for (const m of Array.isArray(node.material) ? node.material : [node.material]) withReveal(m, uniforms);
      });
      view.bounds.setFromObject(pivot);
    });
    const view: RoomView = { pivot, floor, walls, furniture, uniforms, bounds: new THREE.Box3() };
    return { view, loaded };
  }

  const bakedFragment = `varying vec2 vUv;
varying vec3 vIsoLocal;
uniform sampler2D uMap;
uniform float uReveal;
uniform vec3 uClay;
uniform vec2 uOrigin;
uniform float uSpan;
float isoHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }
float isoNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(isoHash(i), isoHash(i + vec2(1, 0)), u.x), mix(isoHash(i + vec2(0, 1)), isoHash(i + vec2(1, 1)), u.x), u.y);
}
void main() {
  float isoDist = length(vIsoLocal.xz - uOrigin) / uSpan + vIsoLocal.y * 0.08;
  float isoMask = smoothstep(0.0, 0.18, uReveal * 1.35 - isoDist - isoNoise(vIsoLocal.xz * 2.2) * 0.22);
  gl_FragColor = vec4(mix(uClay, texture2D(uMap, vUv).rgb, isoMask), 1.0);
}`;
  const bakedVertex = `varying vec2 vUv;
varying vec3 vIsoLocal;
void main() {
  vUv = uv;
  vIsoLocal = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
  const textureLoader = new THREE.TextureLoader();
  const textureCache = new Map<string, Promise<THREE.Texture>>();
  const bakedTexture = (url: string) => {
    if (!textureCache.has(url))
      textureCache.set(
        url,
        textureLoader.loadAsync(url).then((t) => {
          t.colorSpace = THREE.LinearSRGBColorSpace;
          return t;
        }),
      );
    return textureCache.get(url)!;
  };

  // Baked rooms already carry their lighting in the textures, so they render unlit.
  function buildBaked(spec: BakedRoom): { view: RoomView; loaded: Promise<void> } {
    const pivot = new THREE.Group();
    const content = new THREE.Group();
    pivot.add(content);
    pivot.visible = false;
    stage.add(pivot);
    const floor = new THREE.Group();
    content.add(floor);
    const uniforms: Uniforms = { uReveal: { value: 0 }, uClay: { value: new THREE.Color(CLAY) }, uOrigin: { value: new THREE.Vector2() }, uSpan: { value: 3 } };
    const furniture: RoomView["furniture"] = [];
    const view: RoomView = { pivot, floor, walls: [], furniture, uniforms, bounds: new THREE.Box3() };
    const loaded = loader.loadAsync(spec.glbUrl).then(async (gltf) => {
      const node = gltf.scene.getObjectByName(spec.node);
      if (!node || disposed) return;
      const room = node.clone(true);
      room.position.set(0, 0, 0);
      room.rotation.set(0, 0, 0);
      // The baked ground plane is far wider than the building; drop it so the fit
      // and the reveal frame the room itself.
      const ground: THREE.Mesh[] = [];
      room.traverse((n) => {
        if (!(n instanceof THREE.Mesh)) return;
        const name = (Array.isArray(n.material) ? n.material[0] : n.material)?.name ?? "";
        if (!spec.textures.some((t) => name.includes(t.match))) ground.push(n);
      });
      for (const mesh of ground) mesh.removeFromParent();
      room.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(room);
      const size = box.getSize(new THREE.Vector3());
      const scale = (spec.footprint ?? 6) / Math.max(size.x, size.z);
      room.scale.setScalar(scale);
      room.position.set(-((box.min.x + box.max.x) / 2) * scale, -box.min.y * scale, -((box.min.z + box.max.z) / 2) * scale);
      floor.add(room);
      uniforms.uSpan.value = (Math.hypot(size.x, size.z) * scale) / 2;
      const meshes: THREE.Mesh[] = [];
      room.traverse((n) => {
        if (n instanceof THREE.Mesh) meshes.push(n);
      });
      await Promise.all(
        meshes.map(async (mesh) => {
          const name = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)?.name ?? "";
          const url = spec.textures.find((t) => name.includes(t.match))?.url ?? spec.fallbackTexture;
          const map = await bakedTexture(url);
          mesh.material = new THREE.ShaderMaterial({
            uniforms: { ...uniforms, uMap: { value: map } },
            vertexShader: bakedVertex,
            fragmentShader: bakedFragment,
          });
          mesh.castShadow = true;
        }),
      );
      // Top-level parts drop in like furniture, nearest the center first.
      for (const child of [...room.children]) {
        const g = new THREE.Group();
        g.position.copy(child.position);
        room.add(g);
        g.add(child);
        child.position.set(0, 0, 0);
        furniture.push({ root: g, rest: g.position.clone(), order: Math.hypot(g.position.x, g.position.z) });
      }
      furniture.sort((a, b) => a.order - b.order);
      view.bounds.setFromObject(pivot);
    });
    return { view, loaded };
  }

  const built = sources.map((src) => (src.baked ? buildBaked(src.baked) : buildRoom(src.plan!, src.reconstruction)));
  const rooms = built.map((b) => b.view);
  let current = Math.min(Math.max(options.initial ?? 0, 0), Math.max(0, rooms.length - 1));
  let step = 12;

  // Frame the largest room along the fixed view direction.
  function fit() {
    const bounds = new THREE.Box3();
    for (const r of rooms) bounds.union(r.bounds);
    if (bounds.isEmpty()) return;
    const target = new THREE.Vector3(0, bounds.max.y * 0.3, 0);
    const right = new THREE.Vector3().crossVectors(camera.up, VIEW).normalize();
    const up = new THREE.Vector3().crossVectors(VIEW, right);
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const tanH = tanV * camera.aspect;
    let distance = 1;
    for (const x of [bounds.min.x, bounds.max.x])
      for (const y of [bounds.min.y, bounds.max.y])
        for (const z of [bounds.min.z, bounds.max.z]) {
          const corner = new THREE.Vector3(x, y, z).sub(target);
          distance = Math.max(distance, corner.dot(VIEW) + Math.abs(corner.dot(right)) / tanH, corner.dot(VIEW) + Math.abs(corner.dot(up)) / tanV);
        }
    camera.position.copy(target).addScaledVector(VIEW, distance * 1.6);
    camera.lookAt(target);
    // Lift the room into the upper part of the frame, clear of the caption.
    const { width, height } = canvas.getBoundingClientRect();
    camera.setViewOffset(width, height, 0, height * 0.09, width, height);
    camera.near = Math.max(0.5, distance * 0.3);
    camera.far = distance * 5;
    camera.updateProjectionMatrix();
    const span = bounds.getSize(new THREE.Vector3()).length();
    step = span * 1.6;
    sun.position.set(-6, 12, 8);
    sun.target.position.set(0, 0, 0);
    const cam = sun.shadow.camera;
    cam.left = -step * 1.2;
    cam.right = step * 1.2;
    cam.top = span;
    cam.bottom = -span;
    cam.far = span * 6;
    cam.updateProjectionMatrix();
  }

  function resize() {
    if (disposed) return;
    const { width, height } = canvas.getBoundingClientRect();
    renderer.setSize(Math.max(1, width), Math.max(1, height), false);
    camera.aspect = Math.max(1, width) / Math.max(1, height);
    fit();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  const pointer = new THREE.Vector2();
  const tilt = new THREE.Vector2();
  const onPointer = (event: PointerEvent) => {
    pointer.set((event.clientX / window.innerWidth) * 2 - 1, (event.clientY / window.innerHeight) * 2 - 1);
  };
  window.addEventListener("pointermove", onPointer, { passive: true });

  let tweens: Tween[] = [];
  const tween = (start: number, duration: number, ease: Tween["ease"], stepFn: Tween["step"], done?: () => void) =>
    tweens.push({ start, duration, ease, step: stepFn, done });
  const clear = (view: RoomView) => {
    tweens = tweens.filter((t) => !(t as Tween & { view?: RoomView }).view || (t as Tween & { view?: RoomView }).view !== view);
  };

  function settle(view: RoomView) {
    view.floor.scale.set(1, 1, 1);
    for (const w of view.walls) w.root.position.y = 0;
    for (const f of view.furniture) {
      f.root.position.copy(f.rest);
      f.root.scale.setScalar(1);
    }
    view.uniforms.uReveal.value = 1.6;
  }

  // Floor, walls, then furniture from the center out, then the finishes wash in.
  function buildIn(view: RoomView, t0: number) {
    const own = (start: number, duration: number, ease: Tween["ease"], stepFn: Tween["step"]) => {
      tween(start, duration, ease, stepFn);
      (tweens[tweens.length - 1] as Tween & { view?: RoomView }).view = view;
    };
    view.floor.scale.set(0.3, 1, 0.3);
    for (const w of view.walls) w.root.position.y = -w.height - 0.2;
    for (const f of view.furniture) {
      f.root.position.copy(f.rest).add(new THREE.Vector3(0, 1.4, 0));
      f.root.scale.setScalar(0.001);
    }
    view.uniforms.uReveal.value = 0;
    own(t0, 900, easeOutBack, (v) => view.floor.scale.set(0.3 + 0.7 * v, 1, 0.3 + 0.7 * v));
    view.walls.forEach((w, i) => {
      const from = -w.height - 0.2;
      own(t0 + 120 + i * 90, 1300, easeOutCubic, (v) => (w.root.position.y = from * (1 - v)));
    });
    view.furniture.forEach((f, i) => {
      own(t0 + 520 + i * 75, 1100, easeOutCubic, (v) => {
        f.root.position.y = f.rest.y + 1.4 * (1 - v);
        f.root.scale.setScalar(Math.max(0.001, (0.85 + 0.15 * v) * Math.min(1, v * 4)));
      });
    });
    own(t0 + 700, 2600, easeInOutCubic, (v) => (view.uniforms.uReveal.value = 1.6 * v));
  }

  let busy = false;
  function showRoom(index: number, direction: 1 | -1 = 1): Promise<void> {
    const next = ((index % rooms.length) + rooms.length) % rooms.length;
    if (busy || next === current) return Promise.resolve();
    const out = rooms[current];
    const into = rooms[next];
    current = next;
    if (options.reducedMotion) {
      out.pivot.visible = false;
      into.pivot.visible = true;
      into.pivot.position.set(0, 0, 0);
      into.pivot.rotation.set(0, 0, 0);
      settle(into);
      return Promise.resolve();
    }
    busy = true;
    clear(out);
    clear(into);
    const t0 = performance.now();
    const d = direction;
    // Outgoing room turns and slides away while its finishes fall back to clay.
    const revealFrom = out.uniforms.uReveal.value;
    tween(t0, 1200, easeInOutCubic, (v) => (out.uniforms.uReveal.value = revealFrom * (1 - v)));
    tween(t0, 2000, easeInOutQuart, (v) => (out.pivot.rotation.y = 0.6 * d * v));
    tween(t0 + 150, 1800, easeInOutQuart, (v) => (out.pivot.position.x = -step * d * v), () => (out.pivot.visible = false));
    // Incoming room swings in from the other side and builds itself as it lands.
    into.pivot.visible = true;
    into.pivot.position.x = step * d;
    into.pivot.rotation.y = -0.8 * d;
    tween(t0 + 150, 1800, easeInOutQuart, (v) => (into.pivot.position.x = step * d * (1 - v)));
    tween(t0 + 350, 1800, easeInOutQuart, (v) => (into.pivot.rotation.y = -0.8 * d * (1 - v)));
    buildIn(into, t0 + 450);
    return new Promise((resolve) =>
      setTimeout(() => {
        busy = false;
        resolve();
      }, 2350),
    );
  }

  let raf = 0;
  let last = performance.now();
  function frame(now: number) {
    if (disposed) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    tweens = tweens.filter((t) => {
      const p = (now - t.start) / t.duration;
      if (p < 0) return true;
      t.step(t.ease(Math.min(1, p)));
      if (p >= 1) t.done?.();
      return p < 1;
    });
    if (!options.reducedMotion) {
      tilt.x = THREE.MathUtils.damp(tilt.x, pointer.x, 2.5, dt);
      tilt.y = THREE.MathUtils.damp(tilt.y, pointer.y, 2.5, dt);
      stage.rotation.y = -tilt.x * 0.06;
      stage.rotation.x = tilt.y * 0.012;
      stage.rotation.z = tilt.y * 0.012;
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }

  const ready = Promise.all([...built.map((b) => b.loaded), lighting.ready]).then(() => {
    if (disposed) return;
    resize();
    const first = rooms[current];
    if (!first) return;
    first.pivot.visible = true;
    if (options.reducedMotion) settle(first);
    else buildIn(first, performance.now() + 200);
    raf = requestAnimationFrame(frame);
  });

  return {
    ready,
    showRoom,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("pointermove", onPointer);
      lighting.dispose();
      releaseAll([scene, ...retained]);
      retained.clear();
      sun.shadow.dispose();
      renderer.dispose();
    },
  };
}
