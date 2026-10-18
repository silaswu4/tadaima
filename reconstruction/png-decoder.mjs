/** Bounded PNG pixel decoding for the Node-only GLB verifier.
 * This is CPU image validation, not an ImageBitmap/WebGL implementation.
 * Blender exports non-interlaced 8-bit RGB/RGBA PNGs; other formats fail closed.
 */
import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

export function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function requirePng(condition, message) {
  if (!condition) throw new Error("PNG: " + message);
}

function paeth(left, up, upperLeft) {
  const prediction = left + up - upperLeft;
  const a = Math.abs(prediction - left), b = Math.abs(prediction - up), c = Math.abs(prediction - upperLeft);
  return a <= b && a <= c ? left : b <= c ? up : upperLeft;
}

export function decodePng(input) {
  const bytes = Buffer.from(input);
  requirePng(bytes.length <= MAX_BYTES, "encoded image exceeds 64 MiB");
  requirePng(bytes.subarray(0, 8).equals(SIGNATURE), "invalid signature");
  let width, height, channels, offset = 8, seenHeader = false, seenData = false, dataEnded = false, ended = false;
  const compressed = [];
  while (offset < bytes.length) {
    requirePng(offset + 12 <= bytes.length, "truncated chunk");
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    requirePng(end <= bytes.length, "truncated chunk payload");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    requirePng(/^[A-Za-z]{4}$/.test(type), "invalid chunk type");
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    requirePng(pngCrc32(bytes.subarray(offset + 4, offset + 8 + length)) === bytes.readUInt32BE(end - 4), "CRC mismatch in " + type);
    requirePng(seenHeader || type === "IHDR", "IHDR must be first");
    if (type === "IHDR") {
      requirePng(!seenHeader && length === 13, "invalid or repeated IHDR");
      width = payload.readUInt32BE(0); height = payload.readUInt32BE(4);
      requirePng(width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= MAX_PIXELS, "unsupported image dimensions");
      requirePng(payload[8] === 8 && (payload[9] === 2 || payload[9] === 6), "only 8-bit RGB/RGBA is supported");
      requirePng(payload[10] === 0 && payload[11] === 0 && payload[12] === 0, "unsupported compression, filter method, or interlace");
      channels = payload[9] === 2 ? 3 : 4;
      seenHeader = true;
    } else if (type === "IDAT") {
      requirePng(!dataEnded, "IDAT chunks must be consecutive");
      seenData = true; compressed.push(payload);
    } else if (type === "IEND") {
      requirePng(length === 0 && seenData && end === bytes.length, "invalid IEND or trailing bytes");
      ended = true; offset = end; break;
    } else {
      if (seenData) dataEnded = true;
      // PLTE is an optional suggested palette for truecolor; it does not alter RGB pixels.
      requirePng(type === "PLTE" || type[0] === type[0].toLowerCase(), "unsupported critical chunk " + type);
      requirePng(type !== "tRNS", "RGB transparency chunks are unsupported; export RGBA instead");
      requirePng(!["acTL", "fcTL", "fdAT"].includes(type), "animated PNG is unsupported");
      if (type === "PLTE") requirePng(!seenData && length > 0 && length <= 768 && length % 3 === 0, "invalid palette");
    }
    offset = end;
  }
  requirePng(ended, "missing IEND");
  const stride = width * channels, expected = (stride + 1) * height;
  const packed = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  requirePng(packed.length === expected, "decompressed size mismatch");
  const scanlines = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = packed[y * (stride + 1)];
    requirePng(filter <= 4, "unsupported row filter");
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const left = x >= channels ? scanlines[i - channels] : 0;
      const up = y ? scanlines[i - stride] : 0;
      const corner = y && x >= channels ? scanlines[i - stride - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, corner);
      scanlines[i] = (packed[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let source = 0, target = 0; source < scanlines.length; source += channels, target += 4) {
    data[target] = scanlines[source]; data[target + 1] = scanlines[source + 1]; data[target + 2] = scanlines[source + 2];
    data[target + 3] = channels === 4 ? scanlines[source + 3] : 255;
  }
  return { width, height, data };
}

/** GLTFLoader only needs decoded image objects for CPU geometry/material checks. */
export function installNodePngDecoder() {
  const decoded = [];
  if (typeof globalThis.createImageBitmap !== "undefined") throw new Error("Expected Node without native createImageBitmap");
  globalThis.self = globalThis;
  globalThis.createImageBitmap = async (blob, options = {}) => {
    requirePng(blob.size <= MAX_BYTES, "encoded image exceeds 64 MiB");
    requirePng(!options.imageOrientation || options.imageOrientation === "none", "image flipping is unsupported");
    requirePng(!options.premultiplyAlpha || options.premultiplyAlpha === "none", "alpha premultiplication is unsupported");
    requirePng(!options.resizeWidth && !options.resizeHeight, "resizing is unsupported");
    const image = decodePng(await blob.arrayBuffer());
    decoded.push({ width: image.width, height: image.height, pixelCount: image.width * image.height });
    return { ...image, close() { this.data = null; } };
  };
  return decoded;
}
