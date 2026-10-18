/** Browser-only capture helpers. No uploads, provider keys, or native AR claims. */
import type { CapturePhoto, CaptureWall, MobileCaptureManifest } from "./contracts";

const MiB = 1024 * 1024;
const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const safePhotoPath = /^photos\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.jpg$/;
const walls = new Set(["a", "b", "c", "d", "overview"]);
type NormalizedPhoto = { photo: CapturePhoto; bytes: Uint8Array };

function identity(id: string, wall: CaptureWall | "overview"): void {
  if (typeof id !== "string" || !safeId.test(id) || !walls.has(wall)) {
    throw new Error("Choose a valid photo ID and wall before capturing.");
  }
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Secure image hashing requires HTTPS or localhost.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer(bytes));
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}

function dimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 320 || height < 320) {
    throw new Error("Use a photo with both dimensions at least 320 pixels.");
  }
  if (width * height > 100_000_000) throw new Error("This image exceeds the 100 megapixel processing limit.");
}

function jpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (!blob || blob.type !== "image/jpeg") reject(new Error("This browser could not create a JPEG. Try another photo."));
    else resolve(blob);
  }, "image/jpeg", quality));
}

function observations(canvas: HTMLCanvasElement): CapturePhoto["quality"] {
  const sample = document.createElement("canvas");
  const scale = Math.min(96 / canvas.width, 96 / canvas.height);
  sample.width = Math.max(1, Math.round(canvas.width * scale));
  sample.height = Math.max(1, Math.round(canvas.height * scale));
  const context = sample.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Image quality sampling is unavailable in this browser.");
  context.drawImage(canvas, 0, 0, sample.width, sample.height);
  const data = context.getImageData(0, 0, sample.width, sample.height).data;
  const luminance = new Float64Array(sample.width * sample.height);
  let sum = 0, edgeSum = 0, edges = 0;
  for (let i = 0; i < luminance.length; i++) {
    const value = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
    luminance[i] = value;
    sum += value;
    if (i % sample.width > 0) { edgeSum += Math.abs(value - luminance[i - 1]); edges++; }
    if (i >= sample.width) { edgeSum += Math.abs(value - luminance[i - sample.width]); edges++; }
  }
  return { meanLuminance: Math.min(255, Math.max(0, sum / luminance.length)),
    edgeEnergy: Math.min(255, Math.max(0, edgeSum / Math.max(1, edges))) };
}

async function normalizeSource(source: CanvasImageSource, width: number, height: number,
  id: string, wall: CaptureWall | "overview"): Promise<NormalizedPhoto> {
  identity(id, wall);
  dimensions(width, height);
  const scale = Math.min(1, 1600 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  dimensions(canvas.width, canvas.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Photo processing is unavailable in this browser.");
  // Re-encoding pixels drops source EXIF/GPS; no metadata is copied into JPEG.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const quality = observations(canvas);
  let blob = await jpeg(canvas, 0.85);
  if (blob.size > 4 * MiB) blob = await jpeg(canvas, 0.65);
  if (blob.size > 4 * MiB) throw new Error("The processed photo exceeds 4 MiB. Use a smaller photo.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { photo: { id, fileName: `photos/${id}.jpg`, sha256: await sha256(bytes), mediaType: "image/jpeg",
    width: canvas.width, height: canvas.height, wall, capturedAt: new Date().toISOString(), quality }, bytes };
}

export async function normalizePhoto(input: Blob, id: string, wall: CaptureWall | "overview"): Promise<NormalizedPhoto> {
  identity(id, wall);
  if (!(input instanceof Blob) || input.size === 0 || input.size > 20 * MiB) {
    throw new Error("Choose a nonempty image no larger than 20 MiB.");
  }
  if (input.type && (!input.type.startsWith("image/") || /svg/i.test(input.type))) {
    throw new Error("Choose a camera photo or a JPEG, PNG, or WebP image.");
  }
  if (typeof document === "undefined" || typeof Image === "undefined") throw new Error("Photo processing requires a browser.");
  const url = URL.createObjectURL(input);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("This browser cannot decode that image. For HEIC/HEIF, export a JPEG or take a new camera photo."));
      image.src = url;
    });
    return await normalizeSource(image, image.naturalWidth, image.naturalHeight, id, wall);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function captureFrame(video: HTMLVideoElement, id: string, wall: CaptureWall | "overview"): Promise<NormalizedPhoto> {
  identity(id, wall);
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) throw new Error("Wait for the camera preview before taking a photo.");
  const source = video.srcObject;
  if (source && "getVideoTracks" in source && typeof source.getVideoTracks === "function") {
    const tracks = source.getVideoTracks();
    if (!tracks.length || tracks.some((track) => track.readyState !== "live" || track.muted || !track.enabled)) {
      throw new Error("The camera is paused or interrupted. Reopen it before taking a photo.");
    }
  }
  return normalizeSource(video, video.videoWidth, video.videoHeight, id, wall);
}

export async function startCamera(video: HTMLVideoElement, isCurrent: () => boolean = () => true): Promise<MediaStream> {
  if (typeof window === "undefined" || !window.isSecureContext ||
      !(window.location.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname))) {
    throw new Error("Camera access requires HTTPS or localhost. You can also choose an existing photo.");
  }
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Live camera access is unavailable. Choose an existing photo instead.");
  stopCamera(null, video);
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1600 }, height: { ideal: 1200 } } });
    if (!isCurrent()) throw new Error("Camera request cancelled.");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    if (!isCurrent()) throw new Error("Camera request cancelled.");
    return stream;
  } catch (error) {
    // A rejected earlier permission request must not stop a newer attachment.
    // stopCamera only clears video when this request owns that exact stream.
    if (stream) stopCamera(stream, video);
    if (error instanceof Error && error.name === "NotAllowedError") throw new Error("Camera permission was denied. Allow access in browser settings or choose an existing photo.");
    throw new Error("The camera could not start. Close other camera apps or choose an existing photo.");
  }
}

export function stopCamera(stream: MediaStream | null, video?: HTMLVideoElement): void {
  const attached = video?.srcObject;
  const active = stream ?? (attached && "getTracks" in attached ? attached as MediaStream : null);
  active?.getTracks().forEach((track) => track.stop());
  if (video && (!stream || video.srcObject === stream)) {
    video.pause();
    video.srcObject = null;
  }
}

export function qualityWarnings(photo: CapturePhoto): string[] {
  const { meanLuminance, edgeEnergy } = photo.quality;
  const warnings: string[] = [];
  if (!Number.isFinite(meanLuminance) || !Number.isFinite(edgeEnergy) ||
      meanLuminance < 0 || meanLuminance > 255 || edgeEnergy < 0 || edgeEnergy > 255) {
    return ["Image quality observations are unavailable. Check the photo visually."];
  }
  if (meanLuminance < 45) warnings.push("This photo may be dark. Consider improving the lighting.");
  if (meanLuminance > 220) warnings.push("This photo may be washed out. Check that room details are visible.");
  if (edgeEnergy < 4) warnings.push("This photo has little visible edge detail; check focus. Plain walls can also cause this warning.");
  return warnings;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntry(name: string, bytes: Uint8Array, offset: number): { local: Uint8Array; central: Uint8Array } {
  const encoded = new TextEncoder().encode(name), crc = crc32(bytes);
  const local = new Uint8Array(30 + encoded.length + bytes.length), ld = new DataView(local.buffer);
  ld.setUint32(0, 0x04034b50, true); ld.setUint16(4, 20, true); ld.setUint16(6, 0x0800, true);
  ld.setUint16(12, 0x0021, true); ld.setUint32(14, crc, true);
  ld.setUint32(18, bytes.length, true); ld.setUint32(22, bytes.length, true); ld.setUint16(26, encoded.length, true);
  local.set(encoded, 30); local.set(bytes, 30 + encoded.length);
  const central = new Uint8Array(46 + encoded.length), cd = new DataView(central.buffer);
  cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
  cd.setUint16(14, 0x0021, true); cd.setUint32(16, crc, true);
  cd.setUint32(20, bytes.length, true); cd.setUint32(24, bytes.length, true); cd.setUint16(28, encoded.length, true);
  cd.setUint32(42, offset, true); central.set(encoded, 46);
  return { local, central };
}

/** Store-only standard ZIP. Verification completes before a downloadable Blob exists. */
export async function buildCaptureZip(manifest: MobileCaptureManifest, files: Map<string, Uint8Array>): Promise<Blob> {
  if (!manifest || manifest.schemaVersion !== "mobile-capture/1.0" ||
      typeof manifest.jobId !== "string" || typeof manifest.projectId !== "string" ||
      !safeId.test(manifest.jobId) || !safeId.test(manifest.projectId) ||
      !Number.isSafeInteger(manifest.inputRevision) || manifest.inputRevision < 0 ||
      !Array.isArray(manifest.photos) || manifest.photos.length > 16 ||
      !Array.isArray(manifest.openings) || manifest.openings.length > 32 || !(files instanceof Map)) {
    throw new Error("The capture manifest is invalid or exceeds its limits.");
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  if (manifestBytes.length > 256 * 1024) throw new Error("The capture manifest exceeds 256 KiB.");
  // Freeze the serialized metadata across asynchronous digest operations.
  manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as MobileCaptureManifest;
  const names = new Set<string>(), ids = new Set<string>();
  const verified = new Map<string, Uint8Array>();
  let total = 0;
  for (const photo of manifest.photos) {
    identity(photo.id, photo.wall);
    if (!safePhotoPath.test(photo.fileName) || names.has(photo.fileName) || ids.has(photo.id) ||
        photo.mediaType !== "image/jpeg" || typeof photo.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(photo.sha256)) {
      throw new Error("Capture photos require unique IDs, safe JPEG paths, and SHA-256 hashes.");
    }
    names.add(photo.fileName); ids.add(photo.id);
    dimensions(photo.width, photo.height);
    if (Math.max(photo.width, photo.height) > 1600) throw new Error("Capture photos must be normalized to at most 1600 pixels.");
    if (!photo.quality || [photo.quality.meanLuminance, photo.quality.edgeEnergy].some(
      (value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 255)) {
      throw new Error("Capture image observations must be finite values from 0 to 255.");
    }
    const bytes = files.get(photo.fileName);
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 4 * MiB || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      throw new Error("Each capture photo needs actual JPEG bytes no larger than 4 MiB.");
    }
    total += bytes.length;
    if (total > 24 * MiB) throw new Error("Capture photos exceed 24 MiB in total.");
    const snapshot = Uint8Array.from(bytes);
    if (await sha256(snapshot) !== photo.sha256.toLowerCase()) throw new Error("Capture photo bytes changed; its SHA-256 no longer matches.");
    verified.set(photo.fileName, snapshot);
  }
  if (files.size !== names.size || Array.from(files.keys()).some((name) => !names.has(name))) {
    throw new Error("The ZIP photo files must exactly match the manifest.");
  }
  const entries = [["capture.json", manifestBytes] as const,
    ...manifest.photos.map((photo) => [photo.fileName, verified.get(photo.fileName)!] as const)];
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const entry = zipEntry(name, bytes, offset);
    locals.push(entry.local); centrals.push(entry.central); offset += entry.local.length;
  }
  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0);
  const end = new Uint8Array(22), view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, entries.length, true); view.setUint16(10, entries.length, true);
  view.setUint32(12, centralSize, true); view.setUint32(16, offset, true);
  if (offset + centralSize + end.length > 32 * MiB) throw new Error("The capture ZIP exceeds 32 MiB.");
  return new Blob([...locals, ...centrals, end].map(buffer), { type: "application/zip" });
}
