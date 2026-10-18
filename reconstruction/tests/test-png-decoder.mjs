import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import { decodePng, pngCrc32 } from "../png-decoder.mjs";

function chunk(type, payload) {
  const body = Buffer.concat([Buffer.from(type), payload]);
  const result = Buffer.alloc(body.length + 8);
  result.writeUInt32BE(payload.length); body.copy(result, 4);
  result.writeUInt32BE(pngCrc32(body), result.length - 4);
  return result;
}

function png(rows, { width = 2, height = 2, colorType = 2, depth = 8, interlace = 0 } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = depth; header[9] = colorType; header[12] = interlace;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]);
}

test("CRC-32 matches the standard check vector", () => {
  assert.equal(pngCrc32(Buffer.from("123456789")), 0xcbf43926);
});

// The same two RGB rows, manually encoded with all five standard row filters.
const firstRow = [0, 10, 20, 30, 40, 50, 60];
const expected = [10, 20, 30, 255, 40, 50, 60, 255, 20, 40, 60, 255, 60, 80, 100, 255];
for (const [filter, encoded] of [
  [0, [20, 40, 60, 60, 80, 100]],
  [1, [20, 40, 60, 40, 40, 40]],
  [2, [10, 20, 30, 20, 30, 40]],
  [3, [15, 30, 45, 30, 35, 40]],
  [4, [10, 20, 30, 20, 30, 40]],
]) {
  test("decodes RGB row filter " + filter + " to actual pixels", () => {
    const decoded = decodePng(png([...firstRow, filter, ...encoded]));
    assert.equal(decoded.width, 2); assert.equal(decoded.height, 2);
    assert.deepEqual([...decoded.data], expected);
  });
}

test("preserves RGBA without premultiplying transparent color", () => {
  const decoded = decodePng(png([0, 255, 0, 3, 0, 80, 90, 100, 128], { height: 1, colorType: 6 }));
  assert.deepEqual([...decoded.data], [255, 0, 3, 0, 80, 90, 100, 128]);
});

test("rejects corrupted CRC, truncated payloads, and trailing bytes", () => {
  const valid = png([...firstRow, 0, 20, 40, 60, 60, 80, 100]);
  const corrupt = Buffer.from(valid); corrupt[50] ^= 1;
  assert.throws(() => decodePng(corrupt), /CRC/);
  assert.throws(() => decodePng(valid.subarray(0, valid.length - 1)), /truncated/);
  assert.throws(() => decodePng(Buffer.concat([valid, Buffer.from([0])])), /trailing/);
});

test("rejects unsupported encodings, huge dimensions, invalid filter, and excess output", () => {
  assert.throws(() => decodePng(png([], { width: 8193 })), /dimensions/);
  assert.throws(() => decodePng(png([], { width: 8192, height: 8192 })), /dimensions/);
  assert.throws(() => decodePng(png([], { depth: 16 })), /RGB\/RGBA/);
  assert.throws(() => decodePng(png([], { colorType: 3 })), /RGB\/RGBA/);
  assert.throws(() => decodePng(png([], { interlace: 1 })), /interlace/);
  assert.throws(() => decodePng(png([5, 0, 0, 0, 0, 0, 0], { height: 1 })), /row filter/);
  assert.throws(() => decodePng(png([0, 1], { height: 1 })), /size mismatch/);
  assert.throws(() => decodePng(png(new Array(100).fill(0), { height: 1 })), /larger than|output length|buffer/i);
});
