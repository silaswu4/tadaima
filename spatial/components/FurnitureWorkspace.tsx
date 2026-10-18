"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceItem, WorkspaceScene } from "../room/workspace-scene";
import "./FurnitureWorkspace.css";

function centimeters(value: number): string {
  return Number.isFinite(value) && value > 0 ? `${Math.round(value * 100)} cm` : "Unavailable";
}

export default function FurnitureWorkspace() {
  const canvas = useRef<HTMLCanvasElement>(null);
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
  }, []);

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

  return (
    <main className="furniture-workspace">
      <header className="furniture-header">
        <Link href="/" className="furniture-brand">tadaima</Link>
        <span className="furniture-headerLabel">furniture workspace</span>
        <Link href="/capture" className="furniture-captureLink">Capture a room <span aria-hidden="true">↗</span></Link>
      </header>

      <section className="furniture-intro">
        <p className="furniture-eyebrow">demo room / 9 pieces</p>
        <h1>Your room, piece by piece.</h1>
        <p>Take the furniture apart, inspect each piece, then bring the room back together.</p>
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
              <button type="button" className="furniture-explode" disabled={!ready}
                aria-pressed={exploded} onClick={() => setExploded((value) => !value)}>
                {exploded ? "Return furniture" : "Explode furniture"}
              </button>
            </div>
          </div>

          <div className="furniture-viewport" aria-busy={loading}>
            <canvas ref={canvas} className="furniture-canvas" role="img"
              aria-label="Isometric demo room with nine furniture pieces. Select a piece in the item list for its details."
              aria-describedby="furniture-cameraHelp" />
            {loading ? <p className="furniture-loading" role="status">Loading room and furniture…</p> : null}
            {error ? <div className="furniture-error" role="alert"><strong>Room preview unavailable</strong><p>{error}</p></div> : null}
            <div className="furniture-viewBadge" aria-hidden="true">{exploded ? "02 / pieces" : "01 / together"}</div>
          </div>
          <p id="furniture-cameraHelp" className="furniture-cameraHelp">Drag to orbit. Scroll or pinch to zoom. Right-drag or use two fingers to pan. Select an exploded piece for a closer view; Reset view restores the overview.</p>
        </section>

        <aside className="furniture-sidebar" aria-label="Furniture inventory">
          <section className="furniture-selection" aria-labelledby="furniture-selectedHeading" aria-live="polite">
            <p id="furniture-selectedHeading" className="furniture-sectionLabel">selected piece</p>
            {selected ? <>
              <h2>{selected.label}</h2>
              <p className="furniture-modelLabel">{selected.modelAvailable ? "Demo model" : "Demo proxy"}</p>
              <dl className="furniture-dimensions">
                <div><dt>Width / X</dt><dd>{centimeters(selected.size[0])}</dd></div>
                <div><dt>Height / Y</dt><dd>{centimeters(selected.size[1])}</dd></div>
                <div><dt>Depth / Z</dt><dd>{centimeters(selected.size[2])}</dd></div>
              </dl>
            </> : <><h2>A closer look.</h2><p className="furniture-selectionHelp">Select furniture in the room or choose a piece below.</p></>}
          </section>

          <section className="furniture-inventory" aria-labelledby="furniture-inventoryHeading">
            <div className="furniture-inventoryTitle"><h2 id="furniture-inventoryHeading">In this room</h2><span>{items.length ? `${items.length} pieces` : "demo collection"}</span></div>
            {items.length ? <ol className="furniture-itemList">{items.map((item, index) => (
              <li key={item.id}><button type="button" className="furniture-item"
                aria-pressed={selectedId === item.id} onClick={() => selectItem(item.id)}>
                <span className="furniture-itemNumber" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                <span className="furniture-itemText"><span>{item.label}</span>{!item.modelAvailable ? <small>Demo proxy</small> : null}</span>
                <span className="furniture-itemMark" aria-hidden="true">{selectedId === item.id ? "−" : "+"}</span>
              </button></li>
            ))}</ol> : <p className="furniture-emptyInventory">{error ? "The item list will be available when the room loads." : "Preparing the demo collection…"}</p>}
          </section>
          <p className="furniture-disclosure">Model dimensions — demo, not verified retailer sizes. This scene uses sample furniture; it is not a reconstruction of your home.</p>
        </aside>
      </div>
    </main>
  );
}
