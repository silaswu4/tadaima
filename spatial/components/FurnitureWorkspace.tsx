"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RoomPlan, FloorSpot, FurnitureCategory, ShopResult } from "../../backend/contracts";
import { makeWorkspaceDemo } from "../room/workspace-fixture";
import { makePhotoReferencePlan } from "../room/photo-reference";
import { MAX_ROOM_IMPORT_BYTES, parseRoomImport } from "../room/import-room";
import { planWindowDaylight } from "../room/window-daylight";
import type { CapturedRoomBinding } from "../room/textured-model";
import type { WorkspaceItem, WorkspaceScene } from "../room/workspace-scene";
import { prepareLocalShoppingPlan, searchLocalProducts, commitLocalProduct, removeLocalPurchase, localShoppingCost, LOCAL_SHOPPING_NOTICE } from "../room/local-shopping";
import { checkWorkspaceXRSupport } from "../room/workspace-xr";
import "./FurnitureWorkspace.css";

function centimeters(value: number): string {
  return Number.isFinite(value) && value > 0 ? `${Math.round(value * 100)} cm` : "Unavailable";
}

export default function FurnitureWorkspace() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const modelInput = useRef<HTMLInputElement>(null);
  const capturedInput = useRef<HTMLInputElement>(null);
  const [capturedModel, setCapturedModel] = useState<ArrayBuffer | null>(null);
  const [capturedLoaded, setCapturedLoaded] = useState(false);
  const [capturedView, setCapturedView] = useState(false);
  const [capturedBinding, setCapturedBinding] = useState<CapturedRoomBinding | null>(null);
  const [texturedModel, setTexturedModel] = useState<ArrayBuffer | null>(null);
  const [photoModelLoaded, setPhotoModelLoaded] = useState(false);
  const [structuredModelLoaded, setStructuredModelLoaded] = useState(false);
  const importGeneration = useRef(0);
  const localCaptureLoaded = useRef(false);
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
  const [walking, setWalking] = useState(false);
  const [pointerLocked, setPointerLocked] = useState(false);
  const [vrPresenting, setVrPresenting] = useState(false);
  const [vrSupport, setVrSupport] = useState({supported:false, reason:"Checking headset support…"});
  const [navigationError, setNavigationError] = useState("");
  const shoppingBase = useMemo(() => prepareLocalShoppingPlan(plan),[plan]);
  const [shoppingState, setShoppingState] = useState<{source:RoomPlan;value:RoomPlan}|null>(null);
  const shoppingPlan = shoppingState?.source === plan ? shoppingState.value : shoppingBase;
  const [spot,setSpot] = useState<FloorSpot|null>(null);
  const [category,setCategory] = useState<FurnitureCategory>("chair");
  const [maxPrice,setMaxPrice] = useState("500");
  const results = useMemo(() => {
    const cap = Number(maxPrice);
    return spot && Number.isFinite(cap) && cap>0 ? searchLocalProducts(shoppingPlan,{category,spot,maxPriceUsd:cap}) : [];
  },[shoppingPlan,spot,category,maxPrice]);
  const [pending,setPending] = useState<ShopResult|null>(null);
  const [shopStatus,setShopStatus] = useState("Choose an empty floor spot to shop there.");
  const resolvedShopStatus = shopStatus || (!spot ? "Choose an empty floor spot to shop there." : !Number.isFinite(Number(maxPrice)) || Number(maxPrice)<=0 ? "Enter a positive price limit." : results.some((result)=>result.fits) ? "Choose a product to preview its size here." : "No catalog match fits near this spot. Choose another spot or category.");
  const placing = useRef(false);
  const [placingBusy,setPlacingBusy] = useState(false);
  const shoppingRuntimeRef = useRef<{source:RoomPlan;value:RoomPlan}|null>(null);
  useEffect(()=>{shoppingRuntimeRef.current={source:plan,value:shoppingPlan};},[plan,shoppingPlan]);
  const interactionRef = useRef<{preview:(id:string)=>void;confirm:()=>void}>({preview:()=>{},confirm:()=>{}});
  const viewRef = useRef<{ exploded: boolean; selectedId: string | null; capturedView: boolean; walking:boolean }>({ exploded: false, selectedId: null, capturedView: false, walking:false });

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
          async onReady(loadedItems) {
            if (!alive) return;
            const runtime = shoppingRuntimeRef.current;
            const purchases = runtime?.source===plan ? runtime.value.items.filter((item)=>item.origin==="proposed_purchase" && !plan.items.some((base)=>base.id===item.id)) : [];
            for (const item of purchases) await current?.addShoppingItem(item);
            if (!alive) return;
            const added:WorkspaceItem[] = purchases.map((item)=>({id:item.id,label:item.label,size:[...item.dimensions!] as [number,number,number],modelAvailable:true,representation:"product_approximation",locked:false,evidence:[]}));
            // Next.js Activity keeps React state while destroying/reconnecting
            // effects. Reapply it when the asynchronous renderer is recreated.
            current?.setExploded(viewRef.current.exploded);
            current?.selectItem(viewRef.current.selectedId);
            if (viewRef.current.walking) current?.setWalking(true);
            setVrPresenting(false);
            setItems([...loadedItems,...added]);
            setReady(true);
            setLoading(false);
          },
          onNavigation(active,locked) { if (alive) { setWalking(active); setPointerLocked(locked); } },
          onVR(presenting) { if (alive) setVrPresenting(presenting); },
          onNavigationError(message) { if (alive) setNavigationError(message); },
          onFloorSpot(next) { if (alive && !placing.current) { setSpot(next); setPending(null); setShopStatus(""); sceneRef.current?.setShoppingPreview(null); } },
          onPreviewOffer(id) { interactionRef.current.preview(id); },
          onConfirmOffer() { interactionRef.current.confirm(); },
          onSelect(id) {
            if (alive) setSelectedId(id);
          },
          onPhotoModel(loaded, message, representation) {
            if (!alive) return;
            setPhotoModelLoaded(loaded);
            setStructuredModelLoaded(loaded && representation === "photo_informed_parametric");
            if (message) setImportError(message);
          },
          onCapturedModel(loaded, message) {
            if (!alive) return;
            setCapturedLoaded(loaded);
            if (!loaded) setCapturedView(false);
            if (message) setImportError(message);
          },
          onError(message) {
            if (!alive) return;
            setError(message);
            setReady(false);
            setLoading(false);
          },
        }, {
          plan,
          texturedModel: texturedModel ?? undefined,
          capturedModel: capturedModel ?? undefined,
          capturedBinding: capturedBinding ?? undefined,
          capturedView: viewRef.current.capturedView,
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
  }, [plan, texturedModel, capturedModel, capturedBinding]);

  // Synchronize React's committed preview state with the external renderer.
  // The state updater stays pure even when React checks it twice in Strict Mode.
  useEffect(() => {
    viewRef.current = { exploded, selectedId, capturedView, walking };
    sceneRef.current?.setCapturedView(capturedView);
    sceneRef.current?.setExploded(exploded);
  }, [exploded, selectedId, capturedView, walking]);

  useEffect(() => { let alive=true; void checkWorkspaceXRSupport().then((support) => {if(alive)setVrSupport(support);}); return()=>{alive=false;}; },[]);
  function previewOffer(id:string) {
    if (!ready || placing.current) return;
    const result=results.find((entry)=>entry.product.id===id);
    if (!result?.fits || !result.placement || result.withinBudget===false) {setShopStatus(result?.problems.join(" ") || "This product cannot be placed here.");return;}
    setPending(result);setShopStatus("Preview ready. Confirm placement to add it to your local basket.");
  }
  async function confirmOffer() {
    if (!ready || !pending || !spot || placing.current || !sceneRef.current) return;
    const activeScene=sceneRef.current;
    const placed=commitLocalProduct(shoppingPlan,pending.product.id,spot,shoppingPlan.revision);
    if (!placed.ok) {setShopStatus(placed.reason === "stale_revision" ? "The room changed. Choose the product again." : placed.validations.map((entry)=>entry.message).join(" "));return;}
    placing.current=true;setPlacingBusy(true);
    try {
      const item=placed.plan.items.at(-1)!;
      await activeScene.addShoppingItem(item);
      if (activeScene!==sceneRef.current) return;
      activeScene.setShoppingPreview(null);
      setShoppingState({source:plan,value:placed.plan});setPending(null);
      setExploded(false);
      setItems((current)=>[...current,{id:item.id,label:item.label,size:[...item.dimensions!] as [number,number,number],modelAvailable:true,representation:"product_approximation",locked:false,evidence:[]}]);
      setShopStatus(`${item.label} added to your local preview basket.`);
    } catch {setShopStatus("The furniture preview could not load. Your basket was not changed; try again.");}
    finally {placing.current=false;setPlacingBusy(false);}
  }
  function removePurchase(id:string) {
    if (!ready || placing.current) return;
    const result=removeLocalPurchase(shoppingPlan,id,shoppingPlan.revision);
    if(!result.ok){setShopStatus("This piece could not be removed from the preview.");return;}
    sceneRef.current?.setShoppingPreview(null);sceneRef.current?.removeShoppingItem(id);
    setItems((current)=>current.filter((item)=>item.id!==id));setPending(null);setExploded(false);
    setShoppingState({source:plan,value:result.plan});setShopStatus("Removed from the local preview basket.");
  }
  useEffect(()=>{sceneRef.current?.setShoppingPreview(pending?.product ?? null,pending?.placement);},[pending,ready]);
  useEffect(()=>{interactionRef.current={preview:previewOffer,confirm:()=>{void confirmOffer();}};});
  useEffect(()=>{
    sceneRef.current?.setShoppingState({offers:results.filter((r)=>r.fits && r.withinBudget!==false).map((r)=>({id:r.product.id,label:r.product.label,
      detail:`${r.product.price ? new Intl.NumberFormat("en-US",{style:"currency",currency:r.product.price.currency}).format(r.product.price.amountMinor/100) : "Price unknown"} · ${r.product.dimensions?.map((v)=>Math.round(v*100)).join(" × ")} cm · model approximate`})),
      selectedItemLabel:items.find((item)=>item.id===selectedId)?.label, status:resolvedShopStatus,pendingOfferId:pending?.product.id,canConfirm:!!pending});
  },[results,selectedId,items,resolvedShopStatus,pending,ready]);

  // A USB-local preview link carries a temporary capability in the fragment,
  // never in server logs or a public asset URL. Production serves no such route.
  useEffect(()=>{
    if (localCaptureLoaded.current) return;
    let token=new URLSearchParams(window.location.hash.slice(1)).get("local-scan");
    try { token ||= window.sessionStorage.getItem("tadaima:local-scan"); } catch { /* Storage can be unavailable in private browsing. */ }
    if (!token || token.length!==64 || !/^[a-f0-9]{64}$/.test(token)) return;
    let alive=true; const generation=++importGeneration.current;
    void Promise.all(["scene","model"].map(async(asset)=>{
      const response=await fetch(`/api/local-capture/${asset}`,{headers:{authorization:`Bearer ${token}`},cache:"no-store"});
      if (!response.ok) throw new Error("The private local scan link is unavailable. Check the Mac preview server.");
      return response.arrayBuffer();
    })).then(async([body,model])=>{
      const source=new TextDecoder("utf-8",{fatal:true}).decode(body), next=parseRoomImport(source);
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",body)),(byte)=>byte.toString(16).padStart(2,"0")).join("");
      const {validateLocalTexturedGlb}=await import("../room/textured-model");validateLocalTexturedGlb(model);
      if (!alive || generation!==importGeneration.current) return;
      localCaptureLoaded.current=true;
      resetPresentation();setCapturedBinding({jobId:JSON.parse(source).jobId,inputSha256:hash});setImported(next);setTexturedModel(model);setImportError("");
      try { window.sessionStorage.setItem("tadaima:local-scan",token); } catch { /* Local preview still works without persistence. */ }
      window.history.replaceState(null,"",window.location.pathname+window.location.search);
    }).catch((cause)=>{if(alive && generation===importGeneration.current)setImportError(cause instanceof Error?cause.message:"Local preview failed.");});
    return()=>{alive=false;};
  },[]);

  const selected = items.find((item) => item.id === selectedId) ?? null;

  function selectItem(id: string) {
    setSelectedId(id);
    if (ready) sceneRef.current?.selectItem(id);
  }

  function resetPresentation() {
    viewRef.current = { exploded: false, selectedId: null, capturedView: false, walking:false };
    sceneRef.current?.setWalking(false); setWalking(false);setNavigationError("");
    setSpot(null);setPending(null);setShoppingState(null);setShopStatus("Choose an empty floor spot to shop there.");
    setCapturedView(false);
    setExploded(false); setSelectedId(null); setItems([]); setReady(false); setLoading(true);
  }
  async function importRoom(file?: File) {
    if (!file) return;
    const generation = ++importGeneration.current;
    try {
      if (file.size > MAX_ROOM_IMPORT_BYTES) throw new Error("Choose a room file smaller than 2 MiB.");
      const body = await file.arrayBuffer();
      const source = new TextDecoder("utf-8", { fatal: true }).decode(body);
      const next = parseRoomImport(source);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const binding = { jobId: JSON.parse(source).jobId as string, inputSha256: hash };
      if (generation !== importGeneration.current) return;
      try { window.sessionStorage.removeItem("tadaima:local-scan"); } catch {}
      resetPresentation(); setCapturedModel(null); setCapturedLoaded(false); setCapturedBinding(binding); setTexturedModel(null); setPhotoModelLoaded(false); setStructuredModelLoaded(false); setImported(next); setImportError("");
    } catch (cause) {
      if (generation === importGeneration.current) setImportError(cause instanceof Error ? cause.message : "The room file could not be opened.");
    }
  }
  async function importPhotoModel(file?: File) {
    if (!file || !imported) return;
    const generation = ++importGeneration.current;
    try {
      const { MAX_TEXTURED_MODEL_BYTES, validateLocalTexturedGlb } = await import("../room/textured-model");
      if (file.size > MAX_TEXTURED_MODEL_BYTES) throw new Error("Choose a photo-textured GLB smaller than 64 MiB.");
      const bytes = await file.arrayBuffer();
      validateLocalTexturedGlb(bytes);
      if (generation !== importGeneration.current) return;
      resetPresentation(); setPhotoModelLoaded(false); setStructuredModelLoaded(false); setTexturedModel(bytes); setImportError("");
    } catch (cause) {
      if (generation === importGeneration.current) setImportError(cause instanceof Error ? cause.message : "The photo model could not be opened.");
    }
  }
  async function importCapturedModel(file?: File) {
    if (!file || !imported || !capturedBinding) return;
    const generation = ++importGeneration.current;
    try {
      const { MAX_CAPTURED_MODEL_BYTES, validateLocalCapturedGlb } = await import("../room/textured-model");
      if (file.size > MAX_CAPTURED_MODEL_BYTES) throw new Error("Choose a captured-room GLB no larger than 128 MiB.");
      const bytes = await file.arrayBuffer();
      validateLocalCapturedGlb(bytes, imported, capturedBinding);
      if (generation !== importGeneration.current) return;
      setCapturedLoaded(false); setCapturedModel(bytes); setCapturedView(true); setImportError("");
    } catch (cause) {
      if (generation === importGeneration.current) setImportError(cause instanceof Error ? cause.message : "The captured room could not be opened.");
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
          {imported ? <>
            <button type="button" onClick={() => modelInput.current?.click()}>Open room model</button>
            <input ref={modelInput} type="file" accept="model/gltf-binary,.glb" aria-label="Open local room model GLB"
              onChange={(event) => { void importPhotoModel(event.target.files?.[0]); event.target.value = ""; }} />
            <button type="button" onClick={() => capturedInput.current?.click()}>Open captured room</button>
            <input ref={capturedInput} type="file" accept="model/gltf-binary,.glb" aria-label="Open local detailed captured-room GLB"
              onChange={(event) => { void importCapturedModel(event.target.files?.[0]); event.target.value = ""; }} />
            {capturedLoaded ? <button type="button" aria-pressed={capturedView} disabled={walking || vrPresenting} onClick={() => setCapturedView((value) => !value)}>{capturedView ? "Show editable layout" : "Show captured room"}</button> : null}
            {texturedModel ? <button type="button" onClick={() => { importGeneration.current++; resetPresentation(); setTexturedModel(null); setPhotoModelLoaded(false); setStructuredModelLoaded(false); setImportError(""); }}>Remove room model</button> : null}
          </> : null}
          <button type="button" aria-pressed={imported ? undefined : photoReference} onClick={() => { try { window.sessionStorage.removeItem("tadaima:local-scan"); } catch {} importGeneration.current++; resetPresentation(); setTexturedModel(null); setPhotoModelLoaded(false); setStructuredModelLoaded(false); setCapturedModel(null); setCapturedLoaded(false); setCapturedBinding(null); setImported(null); setPhotoReference((value) => imported ? true : !value); }}>
            {imported ? "Back to demo" : "Photo reference finishes"}
          </button>
        </div>
        <p className="furniture-fileHelp">Open a reconstruction.request.json or scene.json file (up to 2 MiB). It stays in this browser. Then open its matching clean or photo-textured scene.glb with Open room model (up to 64 MiB). For a detailed surface scan, choose Open captured room with its matching scene.glb (up to 128 MiB). Files stay local. The captured view shows observed shape and appearance; the editable layout keeps furniture proxies selectable and able to explode.</p>
        {importError ? <p className="furniture-importError" role="alert">{importError}</p> : null}
      </section>

      <div className="furniture-workspaceGrid">
        <section className="furniture-viewer" aria-label="Interactive room preview">
          <div className="furniture-toolbar">
            <div className="furniture-viewState" aria-live="polite">
              <span className={exploded ? "furniture-stateDot furniture-stateDotExploded" : "furniture-stateDot"} aria-hidden="true" />
              {capturedView && capturedLoaded ? "Captured room surfaces" : exploded ? "Inventory layout" : "Room layout"}
            </div>
            <div className="furniture-viewActions">
              <button type="button" className="furniture-reset" disabled={!ready || capturedView || vrPresenting}
                aria-pressed={walking} onClick={()=>{setNavigationError("");setExploded(false);sceneRef.current?.setWalking(!walking);}}>{walking ? "Overview" : "Walk inside"}</button>
              <button type="button" className="furniture-reset" disabled={!ready || (!vrSupport.supported && !vrPresenting)}
                title={vrSupport.reason} onClick={()=>{setNavigationError("");setExploded(false);void (vrPresenting ? sceneRef.current?.exitVR() : sceneRef.current?.enterVR())?.catch((cause)=>setNavigationError(cause instanceof Error?cause.message:"VR could not start."));}}>{vrPresenting ? "Exit VR" : "Enter VR"}</button>
              <button type="button" className="furniture-reset" disabled={!ready}
                onClick={() => sceneRef.current?.resetCamera()}>Reset view</button>
              <button type="button" className="furniture-explode" disabled={!ready || !items.length || capturedView || walking || vrPresenting || placingBusy}
                aria-pressed={exploded} onClick={() => setExploded((value) => !value)}>
                {exploded ? "Return furniture" : "Explode furniture"}
              </button>
            </div>
          </div>

          {navigationError ? <p role="alert" className="furniture-importError">{navigationError}</p> : null}
          {!vrSupport.supported ? <p className="furniture-cameraHelp">{vrSupport.reason}</p> : null}
          <div className="furniture-viewport" aria-busy={loading}>
            <canvas ref={canvas} className="furniture-canvas" role="img"
              aria-label={capturedView ? "Observed captured room surfaces. Missing areas were not scanned; furniture is not individually editable in this reference." : imported ? "Interactive imported room and captured furniture draft. Select an item in the list to inspect it." : "Isometric demo room with nine furniture pieces. Select a piece in the item list for its details."}
              aria-describedby="furniture-cameraHelp" />
            {walking ? <>
              <span className="furniture-crosshair" aria-hidden="true">+</span>
              <button type="button" className="furniture-lookButton" onClick={()=>sceneRef.current?.requestPointerLock()}>{pointerLocked ? "Mouse look active · Esc releases" : "Click to look · WASD to walk · E to select"}</button>
              <div className="furniture-walkPad" aria-label="Walking controls">
                {[["Forward",1,0],["Left",0,-1],["Back",-1,0],["Right",0,1]].map(([label,forward,right])=><button key={label} type="button" aria-label={`Walk ${label}`} onPointerDown={(event)=>{event.preventDefault();canvas.current?.focus({preventScroll:true});event.currentTarget.setPointerCapture(event.pointerId);sceneRef.current?.setMoveInput(Number(forward),Number(right));}} onPointerUp={()=>sceneRef.current?.setMoveInput(0,0)} onPointerCancel={()=>sceneRef.current?.setMoveInput(0,0)} onLostPointerCapture={()=>sceneRef.current?.setMoveInput(0,0)}>{label}</button>)}
              </div>
            </> : null}
            {loading ? <p className="furniture-loading" role="status">Loading room and furniture…</p> : null}
            {error ? <div className="furniture-error" role="alert"><strong>Room preview unavailable</strong><p>{error}</p></div> : null}
            <div className="furniture-viewBadge" aria-hidden="true">{capturedView && capturedLoaded ? "03 / captured" : exploded ? "02 / pieces" : "01 / together"}</div>
          </div>
          <div className="furniture-appearanceNote" aria-live="polite">
            <strong>{capturedView && capturedLoaded ? "Observed room surface scan" : structuredModelLoaded ? "Photo-informed room model" : photoModelLoaded ? "Captured photo textures" : appearance ? "Photo-estimated finishes" : "Sample finishes"}</strong>
            <span>{capturedView && capturedLoaded ? "Actual captured surface geometry with projected photos. Gaps and rough edges reflect missing sensor coverage; this is a partial reference, not a complete exact replica. Return to the editable layout to select or explode furniture proxies." : structuredModelLoaded ? "Complete room geometry and furniture forms are modeled from scan dimensions and photo references. Shapes, materials and unseen details are estimates; this is not an exact recovered mesh or a measured material scan." : photoModelLoaded ? "Visible photo patches are projected onto the scan geometry. Unseen areas keep fallback materials; furniture shape remains a size proxy." : appearance ? photoScope : "Generic oak and plaster, unrelated to the room photos."} {photoSource ? <a href={photoSource} target="_blank" rel="noreferrer">View reference photo</a> : null}</span>
            {appearance && !photoModelLoaded ? <span>Only cited surfaces use photo estimates; other finishes use sample materials.</span> : null}
            {!capturedView ? <span>{structuredModelLoaded ? "Soft indoor lighting is estimated for this photo-informed room. Ceiling light placement, brightness and material response are approximations; exterior daylight is disabled." : hasWindowDaylight ? "Daylight follows exterior windows in the model. Light strength and downward shadow angle are approximations; sun direction and weather are unknown." : "No exterior windows are established in this draft. A generic studio light keeps it visible; daylight is not reconstructed."}</span> : <span>Photo colors preserve captured lighting; this view uses unlit materials.</span>}
          </div>
          <p id="furniture-cameraHelp" className="furniture-cameraHelp">{walking ? "WASD or arrow keys to walk. Click the scene for mouse look; Esc releases the cursor for shopping. E selects at the crosshair. Touch: drag to look and use the walking buttons. Click an empty floor spot to shop there." : capturedView ? "Drag to look around the observed room. Scroll or pinch to zoom; right-drag or use two fingers to pan. Reset view returns inside the room. Switch to the editable layout for furniture selection." : "Drag to orbit. Scroll or pinch to zoom. Right-drag or use two fingers to pan. Select an exploded piece for a closer view; Reset view restores the overview."}</p>
        </section>

        <aside className="furniture-sidebar" aria-label="Furniture inventory">
          <section className="furniture-shop" aria-label="Shop this room">
            <p className="furniture-sectionLabel">shop this room</p>
            <h2>Try something here.</h2>
            <p className="furniture-selectionHelp">{spot ? `Floor spot: ${spot.position[0].toFixed(2)}, ${spot.position[2].toFixed(2)} m` : "Click an empty floor spot, or look down and press E while walking."}</p>
            <label>Furniture<select value={category} disabled={!ready || placingBusy} onChange={(event)=>{setCategory(event.target.value as FurnitureCategory);setPending(null);setShopStatus("");sceneRef.current?.setShoppingPreview(null);}}>{["chair","table","sofa","storage","desk","bed","rug","lamp"].map((value)=><option key={value} value={value}>{value}</option>)}</select></label>
            <label>Price limit (USD)<input type="number" min="1" max="100000" value={maxPrice} disabled={!ready || placingBusy} onChange={(event)=>{setMaxPrice(event.target.value);setPending(null);setShopStatus("");sceneRef.current?.setShoppingPreview(null);}}/></label>
            <p role="status" className="furniture-selectionHelp">{resolvedShopStatus}</p>
            {results.map((result)=><article className="furniture-product" key={result.product.id}>
              <strong>{result.product.label}</strong><span>{result.product.merchant} · {result.product.price ? `$${(result.product.price.amountMinor/100).toFixed(2)}` : "Price unknown"}</span>
              <span>{result.product.dimensions?.map((v)=>Math.round(v*100)).join(" × ")} cm · approximate library model</span>
              <span>Observed {result.product.observedAt.slice(0,10)} · {result.fits ? "Fits near this spot" : result.problems.join(" ")}</span>
              <button type="button" disabled={!ready || placingBusy || !result.fits || result.withinBudget===false} onClick={()=>previewOffer(result.product.id)}>{pending?.product.id===result.product.id ? "Preview selected" : "Try in room"}</button>
              <a href={result.product.sourceUrl} target="_blank" rel="noreferrer">Retailer details</a>
            </article>)}
            {pending ? <button type="button" className="furniture-confirm" disabled={!ready || placingBusy} onClick={()=>void confirmOffer()}>Confirm placement</button> : null}
            <p className="furniture-selectionHelp">Preview basket: {shoppingPlan.items.filter((item)=>item.origin==="proposed_purchase").length} items · ${(localShoppingCost(shoppingPlan).knownSubtotal.amountMinor/100).toFixed(2)} known subtotal.</p>
            {shoppingPlan.items.filter((item)=>item.origin==="proposed_purchase").map((item)=><div className="furniture-product" key={item.id}><strong>{item.label}</strong><button type="button" disabled={!ready || placingBusy} onClick={()=>removePurchase(item.id)}>Remove from preview basket</button></div>)}
            <p className="furniture-disclosure">{LOCAL_SHOPPING_NOTICE}</p>
          </section>
          <section className="furniture-selection" aria-labelledby="furniture-selectedHeading" aria-live="polite">
            <p id="furniture-selectedHeading" className="furniture-sectionLabel">selected piece</p>
            {capturedView ? <><h2>Captured surfaces.</h2><p className="furniture-selectionHelp">The room and existing furniture share one observed surface reference. Show editable layout to inspect individual detected furniture proxies.</p></> : selected ? <>
              <h2>{selected.label}</h2>
              <p className="furniture-modelLabel">{selected.representation === "product_approximation" ? "Product category approximation at listed dimensions" : selected.representation === "photo_informed_model" ? "Photo-informed furniture model" : selected.representation === "photo_textured_proxy" ? "Photo-textured size proxy" : selected.representation === "detected_size_proxy" ? "Detected size proxy" : selected.modelAvailable ? "Demo model" : "Demo proxy"}</p>
              <dl className="furniture-dimensions">
                <div><dt>Width / X</dt><dd>{centimeters(selected.size[0])}</dd></div>
                <div><dt>Height / Y</dt><dd>{centimeters(selected.size[1])}</dd></div>
                <div><dt>Depth / Z</dt><dd>{centimeters(selected.size[2])}</dd></div>
              </dl>
              {selected.representation === "photo_informed_model" ? <>
                <p className="furniture-selectionHelp">Modeled furniture form and materials guided by room photos. The scan dimensions and placement are preserved; shape, hidden details and material properties are estimates.</p>
                <p className="furniture-selectionHelp">{selected.locked ? "Placement preserved for planning." : "Placement is not locked."} Explode only changes the preview.</p>
                {selected.evidence.map((claim, index) => <p key={index} className="furniture-selectionHelp">{claim}</p>)}
              </> : null}
              {selected.representation === "detected_size_proxy" || selected.representation === "photo_textured_proxy" ? <>
                <p className="furniture-selectionHelp">Sensor-estimated dimensions and placement. This box approximates the detected extent. Photo textures show observed appearance where captured; the exact furniture shape and identity have not been recovered.</p>
                <p className="furniture-selectionHelp">{selected.locked ? "Placement preserved for planning." : "Placement is not locked."} Explode only changes the preview.</p>
                {selected.evidence.map((claim, index) => <p key={index} className="furniture-selectionHelp">{claim}</p>)}
              </> : null}
            </> : <><h2>A closer look.</h2><p className="furniture-selectionHelp">Select furniture in the room or choose a piece below.</p></>}
          </section>

          <section className="furniture-inventory" aria-labelledby="furniture-inventoryHeading">
            <div className="furniture-inventoryTitle"><h2 id="furniture-inventoryHeading">{capturedView ? "Editable layout proxies" : "In this room"}</h2><span>{items.length ? `${items.length} pieces` : imported ? "room shell" : "demo collection"}</span></div>
            {items.length ? <ol className="furniture-itemList">{items.map((item, index) => (
              <li key={item.id}><button type="button" className="furniture-item"
                disabled={capturedView} aria-pressed={selectedId === item.id} onClick={() => selectItem(item.id)}>
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
