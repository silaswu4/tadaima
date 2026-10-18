import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

// One decoder for every loader on the page. The wasm comes from Google's CDN so
// nothing extra ships in public/; it is only fetched when a GLB is Draco compressed.
let shared: DRACOLoader | null = null;

export function dracoLoader(): DRACOLoader {
  if (!shared) shared = new DRACOLoader().setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
  return shared;
}
