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
  CapturePhoto,
  CaptureWall,
  MobileCaptureManifest,
} from "../contracts";
// Namespaced styles preserve isolation under the repository's all-CSS Tailwind loader.
import "./CaptureDemo.css";

const walls: CaptureWall[] = ["a", "b", "c", "d"];
const steps = ["Photographs", "Review"];
type PhotoState = { photo: CapturePhoto; bytes: Uint8Array; preview: string };

export default function CaptureDemo() {
  const [step, setStep] = useState(0);
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
        track.addEventListener(
          "ended",
          () => {
            if (alive.current && stream.current === acquired) {
              closeCamera();
              setNotice(
                "The camera paused. Your saved photos are still here; reopen the camera to continue.",
              );
            }
          },
          { once: true },
        );
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

  const photoCount = walls.filter((key) => photos[key]).length;

  function navigate(next: number) {
    if (next === 1 && photoCount !== 4) return;
    closeCamera();
    setError("");
    setNotice("");
    setStep(next);
  }

  async function download() {
    if (photoCount !== 4 || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const now = new Date().toISOString();
      const items = walls.flatMap((key) => (photos[key] ? [photos[key]!] : []));
      const manifest: MobileCaptureManifest = {
        schemaVersion: "mobile-capture/1.0",
        projectId: "mobile-capture",
        jobId: `capture-${crypto.randomUUID().slice(0, 16)}`,
        inputRevision: 0,
        capturedAt: now,
        captureMode: "photo_inference",
        room: {
          id: "room-1",
          label: label.trim() || "My room",
          shape: "rectangle",
          clearWidth: null,
          clearDepth: null,
          height: null,
          wallThickness: null,
          confirmedRectangularAt: null,
        },
        photos: items.map((item) => item.photo),
        openings: [],
      };
      const archive = await buildCaptureZip(
        manifest,
        new Map(items.map((item) => [item.photo.fileName, item.bytes])),
      );
      if (!alive.current) return;
      const url = URL.createObjectURL(archive);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${manifest.jobId}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setNotice(
        "Capture downloaded. Process this ZIP with the reconstruction worker, then open its room JSON and optional matching GLB from Your rooms.",
      );
    } catch (failure) {
      if (alive.current)
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
        <Link href="/rooms" className="capture-brand">Back to rooms</Link>
      </header>
      <section className="capture-intro">
        <p className="capture-eyebrow">mobile room capture</p>
        <h1>
          Start with the room
          <br />
          you already have.
        </h1>
        <p>Capture four views for an AI room draft. No measurements needed.</p>
      </section>
      <nav className="capture-steps" aria-label="Capture steps">
        {steps.map((name, index) => (
          <button
            key={name}
            type="button"
            aria-current={step === index ? "step" : undefined}
            onClick={() => navigate(index)}
            disabled={busy || (index === 1 && photoCount !== 4)}
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
              Start at wall A and work clockwise. Step sideways between views.
              Include both corners, the floor, ceiling, and any doors or
              windows.
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
              Use sharp, well-lit views and move around the room rather than
              only turning in place. This first capture supports one rectangular
              room.
            </p>
            <p className="capture-help">
              Four wall photos are the starting point for a vision draft. They
              do not provide a measured scan.
            </p>
            <div className="capture-actions">
              <button
                type="button"
                className="capture-primary"
                disabled={photoCount !== 4 || busy}
                onClick={() => navigate(1)}
              >
                Review capture
              </button>
            </div>
          </aside>
        </section>
      ) : null}
      {step === 1 ? (
        <section className="capture-reviewGrid">
          <div>
            <h2>Your room, ready for a draft.</h2>
            <label className="capture-roomName">
              Room name
              <input
                value={label}
                maxLength={100}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <dl className="capture-summary">
              <div>
                <dt>Reference photos</dt>
                <dd>{photoCount} / 4</dd>
              </div>
              <div>
                <dt>Room baseline</dt>
                <dd>One rectangular room</dd>
              </div>
              <div>
                <dt>Dimensions</dt>
                <dd>AI estimate</dd>
              </div>
            </dl>
            <p className="capture-help">
              Reconstruction processing can estimate layout and scale from these photos.
              Dimensions will be approximate; review the resulting model.
            </p>
            <p className="capture-help">
              This page prepares a photo ZIP; it does not generate a room automatically.
              Download it for reconstruction processing. Already have a processed room?
              {" "}<Link href="/rooms">Open a processed room</Link> from Your rooms.
            </p>
            <div className="capture-actions">
              <button
                type="button"
                className="capture-primary"
                disabled={busy || photoCount !== 4}
                onClick={download}
              >
                {busy ? "Preparing…" : "Download capture"}
              </button>
              <button type="button" disabled={busy} onClick={() => navigate(0)}>
                Edit photos
              </button>
            </div>
          </div>
          <div>
            <h2>Check all four views.</h2>
            <div className="capture-photoGrid capture-reviewPhotos">
              {walls.map((key) =>
                photos[key] ? (
                  <button
                    type="button"
                    key={key}
                    className="capture-photo"
                    aria-label={`Replace wall ${key.toUpperCase()} photo`}
                    disabled={busy}
                    onClick={() => {
                      setWall(key);
                      navigate(0);
                    }}
                  >
                    <Image
                      src={photos[key]!.preview}
                      alt={`Your wall ${key.toUpperCase()}`}
                      width={320}
                      height={240}
                      unoptimized
                    />
                    <strong>Wall {key.toUpperCase()}</strong>
                    <small>tap to replace</small>
                  </button>
                ) : null,
              )}
            </div>
          </div>
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
