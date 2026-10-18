"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RoomPlan } from "../../backend/contracts";
import { makeWorkspaceDemo } from "../room/workspace-fixture";
import { makePhotoReferencePlan } from "../room/photo-reference";
import { MAX_ROOM_IMPORT_BYTES, parseRoomImport } from "../room/import-room";
import { planWindowDaylight } from "../room/window-daylight";
import type { WorkspaceItem, WorkspaceScene } from "../room/workspace-scene";
import "./FurnitureWorkspace.css";

function centimeters(value: number): string {
  return Number.isFinite(value) && value > 0 ? `${Math.round(value * 100)} cm` : "Unavailable";
}

export default function FurnitureWorkspace() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [imported, setImported] = useState<RoomPlan | null>(null);
  const [photoReference, setPhotoReference] = useState(true);
  const [importError, setImportError] = useState("");
  const plan = useMemo(() => imported ?? (photoReference ? makePhotoReferencePlan() : makeWorkspaceDemo()), [imported, photoReference]);
  const sceneRef = useRef<WorkspaceScene | null>(null);
  const [items, setItems] = useState<WorkspaceItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exploded, setExploded] = useState(false);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const viewRef = useRef<{ exploded: boolean; selectedId: string | null }>({ exploded: false, selectedId: null });

  useEffect(() => {
    let alive = true;
    let current: WorkspaceScene | null = null;
    import("../room/workspace-scene")
      .then(({ createFurnitureWorkspace }) => {
        if (!alive || !canvas.current) return;
        setReady(false);
        setLoading(true);
        setError("");
        current = createFurnitureWorkspace(canvas.current, {
          onReady(loadedItems) {
            if (!alive) return;
            // Next.js Activity keeps React state while destroying/reconnecting
            // effects. Reapply it when the asynchronous renderer is recreated.
            current?.setExploded(viewRef.current.exploded);
            current?.selectItem(viewRef.current.selectedId);
            setItems(loadedItems);
            setReady(true);
            setLoading(false);
          },
          onSelect(id) {
            if (alive) setSelectedId(id);
          },
          onError(message) {
            if (!alive) return;
            setError(message);
            setReady(false);
            setLoading(false);
          },
        }, {
          plan,
          lite: window.matchMedia("(max-width: 767px), (pointer: coarse)").matches,
          reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        });
        sceneRef.current = current;
        return current.ready;
      })
      .catch(() => {
        if (!alive) return;
        setError("The room view could not load. Refresh to try again.");
        setReady(false);
        setLoading(false);
      });
    return () => {
      alive = false;
      if (sceneRef.current === current) sceneRef.current = null;
      current?.dispose();
    };
  }, [plan]);

  // Synchronize React's committed preview state with the external renderer.
  // The state updater stays pure even when React checks it twice in Strict Mode.
  useEffect(() => {
    viewRef.current = { exploded, selectedId };
    sceneRef.current?.setExploded(exploded);
  }, [exploded, selectedId]);

  const selected = items.find((item) => item.id === selectedId) ?? null;

  function selectItem(id: string) {
    setSelectedId(id);
    if (ready) sceneRef.current?.selectItem(id);
  }

  function resetPresentation() {
    viewRef.current = { exploded: false, selectedId: null };
    setExploded(false); setSelectedId(null); setItems([]); setReady(false); setLoading(true);
  }
  async function importRoom(file?: File) {
    if (!file) return;
    try {
      if (file.size > MAX_ROOM_IMPORT_BYTES) throw new Error("Choose a room file smaller than 2 MiB.");
      const next = parseRoomImport(await file.text());
      resetPresentation(); setImported(next); setImportError("");
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : "The room file could not be opened.");
    }
  }
  const hasWindowDaylight = planWindowDaylight(plan.geometry).length > 0;
  const appearance = plan.appearance?.surfaces.length ? plan.appearance : undefined;
  const photoSource = appearance?.sources.map((source) => plan.evidence.find((entry) => entry.id === source.evidenceId)?.sourceUrl)
    .find((url) => url && /^https?:\/\//i.test(url));
  const photoScope = appearance?.scope === "building_reference" ? "Building gallery reference — not verified for your unit."
    : appearance?.scope === "captured_room" ? "Estimated from room photos — review the finishes."
    : appearance?.scope === "exact_unit" ? "Photos labeled for this unit — finishes still need review."
    : "Photo source scope is unverified — review the finishes.";

  return (
    <main className="furniture-workspace">
      <header className="furniture-header">
        <Link href="/" className="furniture-brand">tadaima</Link>
        <span className="furniture-headerLabel">furniture workspace</span>
        <Link href="/capture" className="furniture-captureLink">Capture a room <span aria-hidden="true">↗</span></Link>
      </header>

      <section className="furniture-intro">
        <p className="furniture-eyebrow">{imported ? "imported room / geometry draft" : "demo room / 9 pieces"}</p>
        <h1>Your room, piece by piece.</h1>
        <p>{imported ? "Explore your reconstruction draft. Its geometry and photo estimates still need review." : "Take the furniture apart, inspect each piece, then bring the room back together."}</p>
        <div className="furniture-roomInputs">
          <button type="button" onClick={() => fileInput.current?.click()}>Open room file</button>
          <input ref={fileInput} type="file" accept="application/json,.json" aria-label="Open reconstruction JSON file"
            onChange={(event) => { void importRoom(event.target.files?.[0]); event.target.value = ""; }} />
          <button type="button" aria-pressed={imported ? undefined : photoReference} onClick={() => { resetPresentation(); setImported(null); setPhotoReference((value) => imported ? true : !value); }}>
            {imported ? "Back to demo" : "Photo reference finishes"}
          </button>
        </div>
        <p className="furniture-fileHelp">Open a reconstruction.request.json or scene.json file (up to 2 MiB). It stays in this browser. Captured furniture appears as selectable size proxies.</p>
        {importError ? <p className="furniture-importError" role="alert">{importError}</p> : null}
      </section>

      <div className="furniture-workspaceGrid">
        <section className="furniture-viewer" aria-label="Interactive room preview">
          <div className="furniture-toolbar">
            <div className="furniture-viewState" aria-live="polite">
              <span className={exploded ? "furniture-stateDot furniture-stateDotExploded" : "furniture-stateDot"} aria-hidden="true" />
              {exploded ? "Inventory layout" : "Room layout"}
            </div>
            <div className="furniture-viewActions">
              <button type="button" className="furniture-reset" disabled={!ready}
                onClick={() => sceneRef.current?.resetCamera()}>Reset view</button>
              <button type="button" className="furniture-explode" disabled={!ready || !items.length}
                aria-pressed={exploded} onClick={() => setExploded((value) => !value)}>
                {exploded ? "Return furniture" : "Explode furniture"}
              </button>
            </div>
          </div>

          <div className="furniture-viewport" aria-busy={loading}>
            <canvas ref={canvas} className="furniture-canvas" role="img"
              aria-label={imported ? "Interactive imported room and captured furniture draft. Select an item in the list to inspect it." : "Isometric demo room with nine furniture pieces. Select a piece in the item list for its details."}
              aria-describedby="furniture-cameraHelp" />
            {loading ? <p className="furniture-loading" role="status">Loading room and furniture…</p> : null}
            {error ? <div className="furniture-error" role="alert"><strong>Room preview unavailable</strong><p>{error}</p></div> : null}
            <div className="furniture-viewBadge" aria-hidden="true">{exploded ? "02 / pieces" : "01 / together"}</div>
          </div>
          <div className="furniture-appearanceNote" aria-live="polite">
            <strong>{appearance ? "Photo-estimated finishes" : "Sample finishes"}</strong>
            <span>{appearance ? photoScope : "Generic oak and plaster, unrelated to the room photos."} {photoSource ? <a href={photoSource} target="_blank" rel="noreferrer">View reference photo</a> : null}</span>
            {appearance ? <span>Only cited surfaces use photo estimates; other finishes use sample materials.</span> : null}
            <span>{hasWindowDaylight ? "Daylight follows exterior windows in the model. Light strength and downward shadow angle are approximations; sun direction and weather are unknown." : "No exterior windows are established in this draft. A generic studio light keeps it visible; daylight is not reconstructed."}</span>
          </div>
          <p id="furniture-cameraHelp" className="furniture-cameraHelp">Drag to orbit. Scroll or pinch to zoom. Right-drag or use two fingers to pan. Select an exploded piece for a closer view; Reset view restores the overview.</p>
        </section>

        <aside className="furniture-sidebar" aria-label="Furniture inventory">
          <section className="furniture-selection" aria-labelledby="furniture-selectedHeading" aria-live="polite">
            <p id="furniture-selectedHeading" className="furniture-sectionLabel">selected piece</p>
            {selected ? <>
              <h2>{selected.label}</h2>
              <p className="furniture-modelLabel">{selected.representation === "detected_size_proxy" ? "Detected size proxy" : selected.modelAvailable ? "Demo model" : "Demo proxy"}</p>
              <dl className="furniture-dimensions">
                <div><dt>Width / X</dt><dd>{centimeters(selected.size[0])}</dd></div>
                <div><dt>Height / Y</dt><dd>{centimeters(selected.size[1])}</dd></div>
                <div><dt>Depth / Z</dt><dd>{centimeters(selected.size[2])}</dd></div>
              </dl>
              {selected.representation === "detected_size_proxy" ? <>
                <p className="furniture-selectionHelp">Sensor-estimated dimensions and placement. This box approximates the detected extent; the furniture’s shape, fabric and identity have not been recovered.</p>
                <p className="furniture-selectionHelp">{selected.locked ? "Placement preserved for planning." : "Placement is not locked."} Explode only changes the preview.</p>
                {selected.evidence.map((claim, index) => <p key={index} className="furniture-selectionHelp">{claim}</p>)}
              </> : null}
            </> : <><h2>A closer look.</h2><p className="furniture-selectionHelp">Select furniture in the room or choose a piece below.</p></>}
          </section>

          <section className="furniture-inventory" aria-labelledby="furniture-inventoryHeading">
            <div className="furniture-inventoryTitle"><h2 id="furniture-inventoryHeading">In this room</h2><span>{items.length ? `${items.length} pieces` : imported ? "room shell" : "demo collection"}</span></div>
            {items.length ? <ol className="furniture-itemList">{items.map((item, index) => (
              <li key={item.id}><button type="button" className="furniture-item"
                aria-pressed={selectedId === item.id} onClick={() => selectItem(item.id)}>
                <span className="furniture-itemNumber" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                <span className="furniture-itemText"><span>{item.label}</span>{!item.modelAvailable ? <small>{item.representation === "detected_size_proxy" ? "Detected size proxy" : "Demo proxy"}</small> : null}</span>
                <span className="furniture-itemMark" aria-hidden="true">{selectedId === item.id ? "−" : "+"}</span>
              </button></li>
            ))}</ol> : <p className="furniture-emptyInventory">{error ? "The item list will be available when the room loads." : imported && ready ? "This reconstruction contains room geometry only. No furniture was imported." : "Preparing the collection…"}</p>}
          </section>
          <p className="furniture-disclosure">{imported ? "Imported geometry and furniture extents are sensor or reconstruction estimates, not a verified survey. Existing furniture is not added to a shopping basket. Photo estimates describe colors and material families; they do not reproduce measured surface reflectance." : "Model dimensions — demo, not verified retailer sizes. Sample geometry and furniture remain unchanged by the photo finish reference; this is not a reconstruction of your home."}</p>
        </aside>
      </div>
    </main>
  );
}
