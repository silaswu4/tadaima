import * as THREE from "three";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";

/** Fit a single shadow atlas to metric room bounds, rather than a huge default frustum. */
export function fitRoomShadow(key: THREE.DirectionalLight, bounds: THREE.Box3) {
  key.target.updateMatrixWorld();
  key.updateMatrixWorld();
  key.shadow.updateMatrices(key);
  const box = bounds.clone().expandByScalar(.35).applyMatrix4(key.shadow.camera.matrixWorldInverse);
  const camera = key.shadow.camera;
  camera.left = box.min.x; camera.right = box.max.x;
  camera.bottom = box.min.y; camera.top = box.max.y;
  camera.near = Math.max(.1, -box.max.z - 1);
  camera.far = Math.max(camera.near + 1, -box.min.z + 1);
  camera.updateProjectionMatrix();
  key.shadow.needsUpdate = true;
}

/** Real-time approximation of the Blender indoor area/HDR rig, not a Cycles bake.
 * One shadowed key supplies contact depth; broad, unshadowed fills avoid six-face
 * point-light shadow maps. No screen-space or stereo postprocessing is needed. */
export function createIndoorLighting(scene: THREE.Scene, key: THREE.DirectionalLight,
  hemisphere: THREE.HemisphereLight, bounds: THREE.Box3, lite = false) {
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const group = new THREE.Group(); group.name = "Indoor soft fill";
  // Modest reflected fixture light lifts the ceiling/undersides. It never
  // allocates a six-face point shadow, including on Quest.
  const bounce = new THREE.PointLight("#ffebcf", 9, 0, 2);
  bounce.name = "Indoor bounce approximation";
  bounce.position.set(center.x, bounds.min.y + size.y * .58, center.z);
  scene.add(bounce);
  RectAreaLightUniformsLib.init();
  for (const sign of [-1, 1]) {
    const fill = new THREE.RectAreaLight("#fff0db", 1.3, Math.min(4, size.x * .7), Math.min(4, size.z * .7));
    fill.position.set(center.x + sign * size.x * .2, bounds.max.y - .12, center.z + sign * size.z * .2);
    fill.lookAt(fill.position.x, bounds.min.y, fill.position.z);
    group.add(fill);
  }
  scene.add(group);
  key.name = "Indoor shadow key";
  key.color.set("#fff2df"); key.intensity = 2.6; key.castShadow = true;
  key.target.position.copy(center); key.target.position.y = bounds.min.y + .4;
  key.position.copy(key.target.position).addScaledVector(new THREE.Vector3(-.18, 1, .26).normalize(), Math.max(12, size.length() * 1.5));
  key.shadow.normalBias = .008; key.shadow.bias = -.00008;
  key.shadow.intensity = .85;
  // Ceiling receives light, but cannot eclipse the downward fixture proxy.
  // This is an indoor rig, not sunlight outside a closed roof.
  fitRoomShadow(key, bounds);
  hemisphere.color.set("#fff4e5"); hemisphere.groundColor.set("#8c775e");

  let immersive = false;
  const setImmersive = (active: boolean) => {
    immersive = active;
    const economy = lite || active;
    group.visible = !economy;
    scene.environmentIntensity = economy ? .4 : .35;
    hemisphere.intensity = economy ? .45 : .35;
    const resolution = economy ? 1024 : 2048;
    key.shadow.radius = economy ? 4 : 8;
    if (key.shadow.mapSize.x !== resolution) {
      key.shadow.map?.dispose(); key.shadow.map = null;
      key.shadow.mapSize.setScalar(resolution);
    }
    key.shadow.needsUpdate = true;
  };
  setImmersive(false);
  return {
    setImmersive,
    get immersive() { return immersive; },
    dispose() { group.removeFromParent(); bounce.removeFromParent(); },
  };
}
