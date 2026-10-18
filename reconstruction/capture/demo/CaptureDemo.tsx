"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildCaptureZip,
  captureFrame,
  normalizePhoto,
  qualityWarnings,
  startCamera,
  stopCamera,
} from "../browser";
import type {
  CaptureMeasurement,
  CaptureOpening,
  CapturePhoto,
  CaptureWall,
  MobileCaptureManifest,
} from "../contracts";
// Namespaced styles preserve isolation under the repository's all-CSS Tailwind loader.
import "./CaptureDemo.css";

const walls: CaptureWall[] = ["a", "b", "c", "d"];
const steps = ["Photographs", "Measurements", "Review"];
type PhotoState = { photo: CapturePhoto; bytes: Uint8Array; preview: string };
type OpeningDraft = {
  id: string;
  wall: CaptureWall;
  kind: "door" | "window";
  offset: string;
  width: string;
  height: string;
  sillHeight: string;
};
const meters = (text: string) =>
  text.trim() ? Number(text.replace(",", ".")) : NaN;

export default function CaptureDemo() {
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<"guided_photos" | "manual">("guided_photos");
  const [wall, setWall] = useState<CaptureWall>("a");
  const [photos, setPhotos] = useState<
    Partial<Record<CaptureWall, PhotoState>>
  >({});
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [label, setLabel] = useState("Living room");
  const [width, setWidth] = useState("");
  const [depth, setDepth] = useState("");
  const [height, setHeight] = useState("");
  const [method, setMethod] = useState<CaptureMeasurement["method"]>("tape");
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);
  const [openings, setOpenings] = useState<OpeningDraft[]>([]);
  const video = useRef<HTMLVideoElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const cameraEpoch = useRef(0);
  const photoRef = useRef(photos);
  const alive = useRef(true);

  const closeCamera = useCallback(() => {
    cameraEpoch.current++;
    stopCamera(stream.current, video.current ?? undefined);
    stream.current = null;
    setCameraOn(false);
    setCameraStarting(false);
  }, []);

  useEffect(() => {
    alive.current = true;
    const pause = () => {
      if (document.hidden) closeCamera();
    };
    document.addEventListener("visibilitychange", pause);
    return () => {
      alive.current = false;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Invalidate a pending permission request, not a DOM-node ref.
      cameraEpoch.current++;
      stopCamera(stream.current);
      document.removeEventListener("visibilitychange", pause);
      Object.values(photoRef.current).forEach((item) => {
        if (item) URL.revokeObjectURL(item.preview);
      });
    };
  }, [closeCamera]);

  async function openCamera() {
    if (!video.current) return;
    const epoch = ++cameraEpoch.current;
    setCameraStarting(true);
    setError("");
    try {
      const acquired = await startCamera(
        video.current,
        () => alive.current && epoch === cameraEpoch.current,
      );
      if (!alive.current || epoch !== cameraEpoch.current) {
        stopCamera(acquired);
        return;
      }
      stream.current = acquired;
      acquired.getVideoTracks().forEach((track) => {
        track.addEventListener("ended", () => {
          if (alive.current && stream.current === acquired) {
            closeCamera();
            setNotice("The camera paused. Your saved photos are still here; reopen the camera to continue.");
          }
        }, { once: true });
      });
      setCameraOn(true);
    } catch (failure) {
      if (alive.current && epoch === cameraEpoch.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "Camera unavailable. Choose a photo instead.",
        );
    } finally {
      if (alive.current && epoch === cameraEpoch.current)
        setCameraStarting(false);
    }
  }

  function retainPhoto(
    result: { photo: CapturePhoto; bytes: Uint8Array },
    targetWall: CaptureWall,
  ) {
    if (!alive.current) return;
    const duplicate = Object.entries(photoRef.current).find(
      ([key, item]) =>
        key !== targetWall && item?.photo.sha256 === result.photo.sha256,
    );
    if (duplicate)
      throw new Error(
        `This photo is already assigned to wall ${duplicate[0].toUpperCase()}. Take a different view.`,
      );
    const previous = photoRef.current[targetWall];
    if (previous) URL.revokeObjectURL(previous.preview);
    const next = {
      ...photoRef.current,
      [targetWall]: {
        ...result,
        preview: URL.createObjectURL(
          new Blob([new Uint8Array(result.bytes)], { type: "image/jpeg" }),
        ),
      },
    };
    photoRef.current = next;
    setPhotos(next);
    setNotice(
      `Wall ${targetWall.toUpperCase()} saved. ${qualityWarnings(result.photo).join(" ")}`,
    );
    const following = walls.find((key) => !next[key]);
    if (following) setWall(following);
  }

  async function takePhoto() {
    if (!video.current) return;
    const targetWall = wall;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      retainPhoto(
        await captureFrame(video.current, `photo-${targetWall}`, targetWall),
        targetWall,
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Photo could not be captured.",
      );
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function choosePhoto(file: File | undefined) {
    if (!file) return;
    const targetWall = wall;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      retainPhoto(
        await normalizePhoto(file, `photo-${targetWall}`, targetWall),
        targetWall,
      );
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Photo could not be read.",
      );
    } finally {
      if (alive.current) setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function navigate(next: number) {
    closeCamera();
    setError("");
    setNotice("");
    setStep(next);
  }
  const W = meters(width),
    D = meters(depth),
    H = meters(height);
  const dimensionsValid =
    Number.isFinite(W) &&
    W >= 0.2 &&
    W <= 100 &&
    Number.isFinite(D) &&
    D >= 0.2 &&
    D <= 100 &&
    Number.isFinite(H) &&
    H >= 0.5 &&
    H <= 20;
  const photoCount = walls.filter((key) => photos[key]).length;

  function addOpening(kind: "door" | "window") {
    setOpenings((previous) => [
      ...previous,
      {
        id: `opening-${crypto.randomUUID().slice(0, 8)}`,
        wall: "a",
        kind,
        offset: "",
        width: "",
        height: "",
        sillHeight: kind === "door" ? "0" : "",
      },
    ]);
  }
  function editOpening(id: string, patch: Partial<OpeningDraft>) {
    setOpenings((previous) =>
      previous.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }
  function openingError(item: OpeningDraft): string | null {
    const values = [item.offset, item.width, item.height, item.sillHeight].map(
      meters,
    );
    if (values.some((value) => !Number.isFinite(value)))
      return "Complete every door/window measurement.";
    const [offset, openingWidth, openingHeight, sill] = values;
    const length = item.wall === "a" || item.wall === "c" ? W : D;
    if (
      offset < 0 ||
      openingWidth < 0.01 ||
      openingHeight < 0.01 ||
      sill < 0 ||
      offset + openingWidth > length ||
      sill + openingHeight > H
    )
      return "A door or window falls outside its wall. Check its measurements.";
    return null;
  }
  const overlappingOpenings = openings.some((item, index) =>
    openings.slice(0, index).some((other) => {
      if (item.wall !== other.wall) return false;
      const horizontal =
        Math.min(
          meters(item.offset) + meters(item.width),
          meters(other.offset) + meters(other.width),
        ) - Math.max(meters(item.offset), meters(other.offset));
      const vertical =
        Math.min(
          meters(item.sillHeight) + meters(item.height),
          meters(other.sillHeight) + meters(other.height),
        ) - Math.max(meters(item.sillHeight), meters(other.sillHeight));
      return (
        (horizontal > 0 && vertical > 0) ||
        (Math.abs(horizontal) < 1e-8 && Math.abs(vertical) < 1e-8)
      );
    }),
  );
  const geometryError =
    openings.map(openingError).find(Boolean) ||
    (overlappingOpenings
      ? "Two openings overlap or meet only at a corner. Check their positions."
      : null);

  async function download() {
    if (
      !dimensionsValid ||
      !confirmedAt ||
      geometryError ||
      (mode === "guided_photos" && photoCount !== 4)
    )
      return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const now = new Date().toISOString();
      const measurement = (value: string): CaptureMeasurement => ({
        valueMeters: meters(value),
        method,
        observedAt: now,
      });
      const mappedOpenings: CaptureOpening[] = openings.map((item) => ({
        id: item.id,
        wall: item.wall,
        kind: item.kind,
        offset: measurement(item.offset),
        width: measurement(item.width),
        height: measurement(item.height),
        sillHeight: measurement(item.sillHeight),
      }));
      const items = walls.flatMap((key) => (photos[key] ? [photos[key]!] : []));
      const manifest: MobileCaptureManifest = {
        schemaVersion: "mobile-capture/1.0",
        projectId: "mobile-capture",
        jobId: `capture-${crypto.randomUUID().slice(0, 16)}`,
        inputRevision: 0,
        capturedAt: now,
        captureMode: mode,
        room: {
          id: "room-1",
          label: label.trim() || "My room",
          shape: "rectangle",
          clearWidth: measurement(width),
          clearDepth: measurement(depth),
          height: measurement(height),
          wallThickness: null,
          confirmedRectangularAt: confirmedAt,
        },
        photos: items.map((item) => item.photo),
        openings: mappedOpenings,
      };
      const archive = await buildCaptureZip(
        manifest,
        new Map(items.map((item) => [item.photo.fileName, item.bytes])),
      );
      const url = URL.createObjectURL(archive);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${manifest.jobId}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setNotice(
        "Capture downloaded. Your photos and measurements are ready for reconstruction processing.",
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Capture could not be exported.",
      );
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <main className="capture-page">
      <header className="capture-header">
        <Link href="/" className="capture-brand">
          tadaima / capture
        </Link>
        <span>one room at a time</span>
      </header>
      <section className="capture-intro">
        <p className="capture-eyebrow">mobile room capture</p>
        <h1>
          Start with the room
          <br />
          you already have.
        </h1>
        <p>
          Photograph each wall. Add your measurements. Make a room plan with a
          scale you can check.
        </p>
      </section>
      <nav className="capture-steps" aria-label="Capture steps">
        {steps.map((name, index) => (
          <button
            key={name}
            type="button"
            aria-current={step === index ? "step" : undefined}
            onClick={() => navigate(index)}
            disabled={busy}
          >
            <span>0{index + 1}</span>
            {name}
          </button>
        ))}
      </nav>
      <div className="capture-localNote">
        Photos stay in this tab. Nothing is uploaded. Download your capture
        before closing it.
      </div>
      {step === 0 ? (
        <section className="capture-captureGrid">
          <div>
            <div className="capture-sectionTitle">
              <h2>Wall {wall.toUpperCase()}</h2>
              <span>{photoCount}/4 views saved</span>
            </div>
            <p className="capture-help">
              Start at wall A and work clockwise. Include both corners, the
              floor, and the ceiling. Step back if you can.
            </p>
            <div className="capture-camera">
              <video
                ref={video}
                muted
                playsInline
                aria-label="Rear camera preview"
                className={
                  cameraOn ? "capture-liveVideo" : "capture-inactiveVideo"
                }
              />
              {!cameraOn ? (
                <div className="capture-cameraPlaceholder">
                  <span>{wall.toUpperCase()}</span>
                  <p>
                    Face this wall.
                    <br />
                    Get the full picture.
                  </p>
                </div>
              ) : null}
            </div>
            <div className="capture-actions">
              {cameraOn ? (
                <>
                  <button
                    type="button"
                    className="capture-primary"
                    disabled={busy}
                    onClick={takePhoto}
                  >
                    Take photo
                  </button>
                  <button type="button" disabled={busy} onClick={closeCamera}>
                    Stop camera
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="capture-primary"
                  disabled={busy || cameraStarting}
                  onClick={openCamera}
                >
                  {cameraStarting ? "Waiting for camera…" : "Open camera"}
                </button>
              )}
              {cameraStarting ? (
                <button type="button" onClick={closeCamera}>
                  Cancel camera
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  closeCamera();
                  fileInput.current?.click();
                }}
              >
                Choose photo
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => void choosePhoto(event.target.files?.[0])}
              />
            </div>
          </div>
          <aside>
            <h2>Four walls. One room.</h2>
            <div className="capture-photoGrid">
              {walls.map((key) => (
                <button
                  type="button"
                  key={key}
                  className={
                    wall === key ? "capture-selectedPhoto" : "capture-photo"
                  }
                  aria-label={`Capture wall ${key.toUpperCase()}${photos[key] ? ", photo saved" : ""}`}
                  disabled={busy}
                  onClick={() => setWall(key)}
                >
                  {photos[key] ? (
                    <Image
                      src={photos[key]!.preview}
                      alt={`Your wall ${key.toUpperCase()}`}
                      width={320}
                      height={240}
                      unoptimized
                    />
                  ) : (
                    <span>+</span>
                  )}
                  <strong>Wall {key.toUpperCase()}</strong>
                  <small>
                    {photos[key] ? "saved · tap to replace" : "not captured"}
                  </small>
                </button>
              ))}
            </div>
            <p className="capture-help">
              Use sharp, well-lit views. Avoid mirrors and moving people. Photos
              help document the room; measurements set its size.
            </p>
            <div className="capture-actions">
              <button
                type="button"
                className="capture-primary"
                disabled={photoCount < 4 || busy}
                onClick={() => {
                  setMode("guided_photos");
                  navigate(1);
                }}
              >
                Add measurements
              </button>
            </div>
            <button
              type="button"
              className="capture-textButton"
              disabled={busy}
              onClick={() => {
                setMode("manual");
                navigate(1);
              }}
            >
              Use manual dimensions instead
            </button>
          </aside>
        </section>
      ) : null}
      {step === 1 ? (
        <section className="capture-measureGrid">
          <div>
            <h2>Measure the inside edges.</h2>
            <p className="capture-help">
              Enter meters, from finished wall to finished wall. Wall A is your
              starting wall; B, C and D follow clockwise.
            </p>
            <div className="capture-fields">
              <label>
                Room name
                <input
                  value={label}
                  maxLength={100}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <label>
                Measured with
                <select
                  value={method}
                  onChange={(event) =>
                    setMethod(
                      event.target.value as CaptureMeasurement["method"],
                    )
                  }
                >
                  <option value="tape">Tape measure</option>
                  <option value="laser">Laser measure</option>
                  <option value="estimate">Estimate — needs checking</option>
                </select>
              </label>
              <label>
                Width — walls A / C (m)
                <input
                  inputMode="decimal"
                  placeholder="e.g. 4.20"
                  value={width}
                  onChange={(event) => setWidth(event.target.value)}
                />
              </label>
              <label>
                Depth — walls B / D (m)
                <input
                  inputMode="decimal"
                  placeholder="e.g. 3.50"
                  value={depth}
                  onChange={(event) => setDepth(event.target.value)}
                />
              </label>
              <label>
                Floor to ceiling (m)
                <input
                  inputMode="decimal"
                  placeholder="e.g. 2.70"
                  value={height}
                  onChange={(event) => setHeight(event.target.value)}
                />
              </label>
            </div>
            <label className="capture-check">
              <input
                type="checkbox"
                checked={!!confirmedAt}
                onChange={(event) =>
                  setConfirmedAt(
                    event.target.checked ? new Date().toISOString() : null,
                  )
                }
              />
              This is one rectangular room.
            </label>
            <div className="capture-sectionTitle">
              <h2>Doors &amp; windows</h2>
              <span>optional</span>
            </div>
            <p className="capture-help">
              Offsets start at the inside corner where that wall begins. Follow
              the arrows on the plan.
            </p>
            {openings.map((item, index) => (
              <fieldset key={item.id} className="capture-opening">
                <legend>
                  {item.kind === "door" ? "Door" : "Window"} {index + 1}
                </legend>
                <div className="capture-fields">
                  <label>
                    Wall
                    <select
                      value={item.wall}
                      onChange={(event) =>
                        editOpening(item.id, {
                          wall: event.target.value as CaptureWall,
                        })
                      }
                    >
                      {walls.map((key) => (
                        <option key={key} value={key}>
                          {key.toUpperCase()}
                        </option>
                      ))}
                    </select>
                  </label>
                  {(
                    [
                      ["offset", "Offset (m)"],
                      ["width", "Width (m)"],
                      ["height", "Height (m)"],
                      ...(item.kind === "window"
                        ? [["sillHeight", "Sill above floor (m)"]]
                        : []),
                    ] as const
                  ).map(([field, title]) => (
                    <label key={field}>
                      {title}
                      <input
                        inputMode="decimal"
                        value={item[field as keyof OpeningDraft]}
                        onChange={(event) =>
                          editOpening(item.id, { [field]: event.target.value })
                        }
                      />
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  className="capture-textButton"
                  onClick={() =>
                    setOpenings((previous) =>
                      previous.filter((opening) => opening.id !== item.id),
                    )
                  }
                >
                  Remove {item.kind}
                </button>
              </fieldset>
            ))}
            <div className="capture-actions">
              <button
                type="button"
                disabled={openings.length >= 32}
                onClick={() => addOpening("door")}
              >
                Add door
              </button>
              <button
                type="button"
                disabled={openings.length >= 32}
                onClick={() => addOpening("window")}
              >
                Add window
              </button>
            </div>
            <div className="capture-actions">
              <button
                type="button"
                className="capture-primary"
                disabled={!dimensionsValid || !confirmedAt || !!geometryError}
                onClick={() => navigate(2)}
              >
                Review room
              </button>
            </div>
            {geometryError ? (
              <p className="capture-error">{geometryError}</p>
            ) : null}
          </div>
          <aside>
            <RoomDiagram width={W} depth={D} openings={openings} />
            <p className="capture-help">
              The outline comes from your dimensions. It isn’t an automatic
              depth scan.
            </p>
          </aside>
        </section>
      ) : null}
      {step === 2 ? (
        <section className="capture-measureGrid">
          <div>
            <h2>{label.trim() || "Your room"}</h2>
            <p className="capture-roomSize">
              {dimensionsValid
                ? `${W.toFixed(2)} × ${D.toFixed(2)} × ${H.toFixed(2)} m`
                : "Add your measurements first."}
            </p>
            <dl className="capture-summary">
              <div>
                <dt>Reference photos</dt>
                <dd>{photoCount} / 4</dd>
              </div>
              <div>
                <dt>Dimensions</dt>
                <dd>
                  {method === "estimate"
                    ? "Estimated"
                    : `User-reported ${method} measurements`}
                </dd>
              </div>
              <div>
                <dt>Doors / windows</dt>
                <dd>{openings.length}</dd>
              </div>
              <div>
                <dt>Capture mode</dt>
                <dd>{mode === "manual" ? "Manual room" : "Guided photos"}</dd>
              </div>
            </dl>
            <p className="capture-help">
              Wall thickness is estimated. Review the resulting model before
              relying on tight clearances.
            </p>
            <p className="capture-help">
              Download a capture bundle for the reconstruction worker. It
              contains the reference photos, dimensions and opening locations;
              no automatic photo reconstruction is claimed.
            </p>
            <div className="capture-actions">
              <button
                type="button"
                className="capture-primary"
                disabled={
                  busy ||
                  !dimensionsValid ||
                  !confirmedAt ||
                  !!geometryError ||
                  (mode === "guided_photos" && photoCount !== 4)
                }
                onClick={download}
              >
                {busy ? "Preparing…" : "Download capture"}
              </button>
              <button type="button" disabled={busy} onClick={() => navigate(1)}>
                Edit dimensions
              </button>
            </div>
          </div>
          <RoomDiagram width={W} depth={D} openings={openings} />
        </section>
      ) : null}
      {error ? (
        <p className="capture-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="capture-notice" role="status">
          {notice}
        </p>
      ) : null}
    </main>
  );
}

function RoomDiagram({
  width,
  depth,
  openings,
}: {
  width: number;
  depth: number;
  openings: OpeningDraft[];
}) {
  const valid =
    Number.isFinite(width) && Number.isFinite(depth) && width > 0 && depth > 0;
  const scale = valid ? Math.min(240 / width, 170 / depth) : 1;
  const w = valid ? width * scale : 200,
    d = valid ? depth * scale : 150;
  const x = (360 - w) / 2,
    y = (280 - d) / 2;
  const marks = valid
    ? openings.flatMap((item, index) => {
        const offset = meters(item.offset),
          length = meters(item.width);
        const wallLength =
          item.wall === "a" || item.wall === "c" ? width : depth;
        if (
          !Number.isFinite(offset) ||
          !Number.isFinite(length) ||
          offset < 0 ||
          length <= 0 ||
          offset + length > wallLength
        )
          return [];
        const positions = {
          a: [x + offset * scale, y, x + (offset + length) * scale, y],
          b: [x + w, y + offset * scale, x + w, y + (offset + length) * scale],
          c: [
            x + w - offset * scale,
            y + d,
            x + w - (offset + length) * scale,
            y + d,
          ],
          d: [x, y + d - offset * scale, x, y + d - (offset + length) * scale],
        }[item.wall];
        return [{ item, positions, index }];
      })
    : [];
  return (
    <div className="capture-diagram">
      <svg
        viewBox="0 0 360 280"
        role="img"
        aria-label={
          valid
            ? `Rectangular room ${width} by ${depth} meters. Wall A at top, B right, C bottom, D left.`
            : "Rectangular room diagram. Add dimensions to set its proportions."
        }
      >
        <rect x={x} y={y} width={w} height={d} />
        {marks.map(({ item, positions, index }) => (
          <g key={item.id}>
            <title>
              {item.kind} {index + 1} on wall {item.wall.toUpperCase()}
            </title>
            <line
              x1={positions[0]}
              y1={positions[1]}
              x2={positions[2]}
              y2={positions[3]}
              className={
                item.kind === "door" ? "capture-doorMark" : "capture-windowMark"
              }
            />
          </g>
        ))}
        <text x={180} y={y - 15} textAnchor="middle">
          A →
        </text>
        <text x={x + w + 16} y={140} textAnchor="middle">
          B ↓
        </text>
        <text x={180} y={y + d + 25} textAnchor="middle">
          ← C
        </text>
        <text x={x - 16} y={140} textAnchor="middle">
          D ↑
        </text>
        <text x={180} y={140} textAnchor="middle">
          {valid ? `${width.toFixed(2)} × ${depth.toFixed(2)} m` : "your room"}
        </text>
      </svg>
    </div>
  );
}
