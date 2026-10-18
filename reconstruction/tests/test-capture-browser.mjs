/** Pure browser-helper protocol tests; no claim of physical iPhone testing. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCaptureZip, captureFrame, normalizePhoto, qualityWarnings, startCamera, stopCamera } from "../capture/browser.ts";

// JPEG-signature bytes are sufficient for archive protocol tests, not a decoded
// photographic fixture. Real image processing needs browser/device verification.
const image = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const measurement = (valueMeters) => ({ valueMeters, method: "tape", observedAt: "2026-10-18T01:00:00Z" });
function photo(id = "photo001") {
  return { id, fileName: `photos/${id}.jpg`, sha256: digest(image), mediaType: "image/jpeg", width: 800, height: 600,
    wall: "a", capturedAt: "2026-10-18T01:00:00Z", quality: { meanLuminance: 120, edgeEnergy: 20 } };
}
function fixture() {
  const manifest = { schemaVersion: "mobile-capture/1.0", projectId: "synthetic-capture", jobId: "capture001", inputRevision: 1,
    capturedAt: "2026-10-18T01:00:00Z", captureMode: "guided_photos",
    room: { id: "room001", label: "Synthetic room", shape: "rectangle", clearWidth: measurement(4), clearDepth: measurement(3),
      height: measurement(2.7), wallThickness: measurement(0.12), confirmedRectangularAt: "2026-10-18T01:00:00Z" },
    photos: [photo()], openings: [] };
  return { manifest, files: new Map([[manifest.photos[0].fileName, image.slice()]]) };
}

test("store-only ZIP interoperates with Python zipfile and exact file SHA", async () => {
  const { manifest, files } = fixture();
  const blob = await buildCaptureZip(manifest, files);
  assert.equal(blob.type, "application/zip");
  const directory = mkdtempSync(join(tmpdir(), "tadaima-capture-browser-"));
  try {
    const path = join(directory, "capture.zip");
    writeFileSync(path, new Uint8Array(await blob.arrayBuffer()));
    const result = JSON.parse(execFileSync("python3", ["-c", `
import hashlib,json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 assert len(z.infolist())==2
 assert all(i.compress_type==zipfile.ZIP_STORED for i in z.infolist())
 assert all(not i.is_dir() for i in z.infolist())
 print(json.dumps({'names':z.namelist(),'manifest':json.loads(z.read('capture.json')),'sha256':hashlib.sha256(z.read('photos/photo001.jpg')).hexdigest()}))
`, path], { encoding: "utf8" }));
    assert.deepEqual(result.names, ["capture.json", "photos/photo001.jpg"]);
    assert.deepEqual(result.manifest, manifest);
    assert.equal(result.sha256, manifest.photos[0].sha256);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("changed bytes cannot be packaged under a stale SHA", async () => {
  const { manifest, files } = fixture();
  files.get("photos/photo001.jpg")[3] = 0xe1;
  await assert.rejects(buildCaptureZip(manifest, files), /SHA-256/);
});

test("missing or additional photo files fail exact manifest matching", async () => {
  for (const extra of [false, true]) {
    const { manifest, files } = fixture();
    if (extra) files.set("photos/extra.jpg", image);
    else files.clear();
    await assert.rejects(buildCaptureZip(manifest, files));
  }
});

test("unsafe photo paths, IDs and duplicate names are rejected", async () => {
  for (const path of ["../escape.jpg", "photos/../escape.jpg", "/absolute.jpg", "capture.json", "photos/nested/file.jpg", "photos/photo001.svg", "photos\\escape.jpg"]) {
    const { manifest } = fixture();
    manifest.photos[0].fileName = path;
    await assert.rejects(buildCaptureZip(manifest, new Map([[path, image]])));
  }
  for (const id of ["../escape", "", "x".repeat(65), "contains spaces"]) {
    const { manifest, files } = fixture();
    manifest.photos[0].id = id;
    await assert.rejects(buildCaptureZip(manifest, files));
  }
  const { manifest, files } = fixture();
  manifest.photos.push(structuredClone(manifest.photos[0]));
  await assert.rejects(buildCaptureZip(manifest, files));
});

test("manifest limits and normalized image dimensions are enforced", async () => {
  for (const change of [
    (m) => { m.projectId = undefined; }, (m) => { m.jobId = "../escape"; },
    (m) => { m.inputRevision = -1; }, (m) => { m.inputRevision = 2 ** 53; },
    (m) => { m.photos = Array.from({ length: 17 }, (_, i) => photo(`p${i}`)); },
    (m) => { m.openings = Array(33).fill({}); },
    (m) => { m.room.label = "x".repeat(256 * 1024); },
    (m) => { m.photos[0].width = 1601; }, (m) => { m.photos[0].height = 319; },
    (m) => { m.photos[0].quality.meanLuminance = Number.NaN; },
  ]) {
    const { manifest, files } = fixture();
    change(manifest);
    await assert.rejects(buildCaptureZip(manifest, files));
  }
});

test("JPEG signature and per-photo size limits are checked", async () => {
  for (const bytes of [new Uint8Array(), Uint8Array.of(1, 2, 3), new Uint8Array(4 * 1024 * 1024 + 1)]) {
    const { manifest, files } = fixture();
    files.set("photos/photo001.jpg", bytes);
    manifest.photos[0].sha256 = digest(bytes);
    await assert.rejects(buildCaptureZip(manifest, files));
  }
});

test("aggregate photo bytes are capped before ZIP allocation", async () => {
  const { manifest } = fixture();
  const large = new Uint8Array(4 * 1024 * 1024);
  large.set([0xff, 0xd8]);
  const hash = digest(large);
  manifest.photos = Array.from({ length: 7 }, (_, i) => ({ ...photo(`p${i}`), sha256: hash }));
  const files = new Map(manifest.photos.map((p) => [p.fileName, large]));
  await assert.rejects(buildCaptureZip(manifest, files), /24 MiB/);
});

test("quality observations produce cautions, without rejecting blank walls", () => {
  assert.deepEqual(qualityWarnings(photo()), []);
  const dark = photo(); dark.quality.meanLuminance = 20;
  assert.match(qualityWarnings(dark).join(" "), /dark/);
  const bright = photo(); bright.quality.meanLuminance = 240;
  assert.match(qualityWarnings(bright).join(" "), /washed out/);
  const plain = photo(); plain.quality.edgeEnergy = 0;
  assert.match(qualityWarnings(plain).join(" "), /Plain walls/);
  const unknown = photo(); unknown.quality.meanLuminance = NaN;
  assert.match(qualityWarnings(unknown).join(" "), /unavailable/);
});

test("capture rejects invalid IDs and unready video before DOM processing", async () => {
  await assert.rejects(normalizePhoto(new Blob([image]), "../bad", "a"), /ID/);
  await assert.rejects(normalizePhoto(new Blob([]), "valid", "a"), /nonempty/);
  await assert.rejects(normalizePhoto(new Blob(["<svg/>"], { type: "image/svg+xml" }), "valid", "a"), /photo/);
  await assert.rejects(captureFrame({ readyState: 0, videoWidth: 0, videoHeight: 0 }, "valid", "a"), /preview/);
});

test("interrupted camera tracks cannot export a stale ready video frame", async () => {
  for (const tracks of [[],
    [{ readyState: "ended", muted: false, enabled: true }],
    [{ readyState: "live", muted: true, enabled: true }],
    [{ readyState: "live", muted: false, enabled: false }],
  ]) {
    const video = { readyState: 2, videoWidth: 800, videoHeight: 600, srcObject: { getVideoTracks: () => tracks } };
    await assert.rejects(captureFrame(video, "valid", "a"), /paused or interrupted/);
  }
});

function globals(values, action) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true });
  return Promise.resolve().then(action).finally(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
}

test("camera mock requests rear video without audio and cleans tracks", async () => {
  let stopped = 0, constraints;
  const stream = { getTracks: () => [{ stop: () => stopped++ }] };
  const video = { srcObject: null, paused: false, pause() { this.paused = true; }, async play() {} };
  await globals({ window: { isSecureContext: true, location: { protocol: "https:", hostname: "example.test" } },
    navigator: { mediaDevices: { async getUserMedia(value) { constraints = value; return stream; } } } }, async () => {
    assert.equal(await startCamera(video), stream);
    assert.equal(constraints.audio, false);
    assert.equal(constraints.video.facingMode.ideal, "environment");
    assert.equal(video.muted, true);
    assert.equal(video.playsInline, true);
    stopCamera(stream, video);
    assert.equal(stopped, 1);
    assert.equal(video.srcObject, null);
  });
});

test("camera mock playback failure stops newly acquired tracks", async () => {
  let stopped = 0;
  const stream = { getTracks: () => [{ stop: () => stopped++ }] };
  const video = { srcObject: null, pause() {}, async play() { throw new Error("blocked"); } };
  await globals({ window: { isSecureContext: true, location: { protocol: "https:", hostname: "example.test" } },
    navigator: { mediaDevices: { async getUserMedia() { return stream; } } } }, async () => {
    await assert.rejects(startCamera(video), /could not start/);
    assert.equal(stopped, 1);
    assert.equal(video.srcObject, null);
  });
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("cancelled earlier camera success cannot replace or stop a newer stream", async () => {
  const first = deferred(), second = deferred();
  let firstStopped = 0, secondStopped = 0, calls = 0, firstCurrent = true;
  const firstStream = { getTracks: () => [{ stop: () => firstStopped++ }] };
  const secondStream = { getTracks: () => [{ stop: () => secondStopped++ }] };
  const video = { srcObject: null, pause() {}, async play() {} };
  await globals({ window: { isSecureContext: true, location: { protocol: "https:", hostname: "example.test" } },
    navigator: { mediaDevices: { getUserMedia() { return ++calls === 1 ? first.promise : second.promise; } } } }, async () => {
    const stale = startCamera(video, () => firstCurrent);
    const rejected = assert.rejects(stale);
    firstCurrent = false;
    const active = startCamera(video);
    second.resolve(secondStream);
    assert.equal(await active, secondStream);
    first.resolve(firstStream);
    await rejected;
    assert.equal(video.srcObject, secondStream);
    assert.equal(firstStopped, 1);
    assert.equal(secondStopped, 0);
  });
});

test("cancelled earlier camera rejection cannot stop a newer stream", async () => {
  const first = deferred(), second = deferred();
  let stopped = 0, calls = 0, firstCurrent = true;
  const activeStream = { getTracks: () => [{ stop: () => stopped++ }] };
  const video = { srcObject: null, pause() {}, async play() {} };
  await globals({ window: { isSecureContext: true, location: { protocol: "https:", hostname: "example.test" } },
    navigator: { mediaDevices: { getUserMedia() { return ++calls === 1 ? first.promise : second.promise; } } } }, async () => {
    const stale = startCamera(video, () => firstCurrent);
    const rejected = assert.rejects(stale);
    firstCurrent = false;
    const active = startCamera(video);
    second.resolve(activeStream);
    await active;
    first.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
    await rejected;
    assert.equal(video.srcObject, activeStream);
    assert.equal(stopped, 0);
  });
});

test("cancellation during playback cleans only the request's own stream", async () => {
  const playing = deferred();
  let current = true, firstStopped = 0, newerStopped = 0;
  const ownStream = { getTracks: () => [{ stop: () => firstStopped++ }] };
  const newerStream = { getTracks: () => [{ stop: () => newerStopped++ }] };
  const video = { srcObject: null, pause() {}, play() { return playing.promise; } };
  await globals({ window: { isSecureContext: true, location: { protocol: "https:", hostname: "example.test" } },
    navigator: { mediaDevices: { async getUserMedia() { return ownStream; } } } }, async () => {
    const pending = startCamera(video, () => current);
    const rejected = assert.rejects(pending);
    await Promise.resolve();
    assert.equal(video.srcObject, ownStream);
    current = false;
    video.srcObject = newerStream;
    playing.resolve();
    await rejected;
    assert.equal(video.srcObject, newerStream);
    assert.equal(firstStopped, 1);
    assert.equal(newerStopped, 0);
  });
});

test("insecure origins fail before requesting the camera", async () => {
  let requested = false;
  await globals({ window: { isSecureContext: false, location: { protocol: "http:", hostname: "192.168.1.10" } },
    navigator: { mediaDevices: { getUserMedia() { requested = true; } } } }, async () => {
    await assert.rejects(startCamera({}), /HTTPS/);
    assert.equal(requested, false);
  });
});
