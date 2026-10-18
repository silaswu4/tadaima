"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { RoomsPage, type RoomsPageRoom } from "@/spatial/components/RoomsPage";
import { getTadaimaRooms, hydrateCatalogRoom } from "@/spatial/fixtures/roomsCatalog";
import { bootstrapLocalCapture, getRoom, getRoomDraft, listRooms, subscribeRooms } from "@/spatial/rooms/registry";

const RoomImporter = dynamic(() => import("@/spatial/components/RoomImporter"));
const PhoneScanInbox = dynamic(() => import("@/spatial/components/PhoneScanInbox"));

export default function Rooms() {
  const router = useRouter();
  const own = useMemo(() => getTadaimaRooms().map((r) => ({ ...r, description: r.description ?? "Demo room · furniture at listed dimensions" })), []);
  const [rooms, setRooms] = useState<RoomsPageRoom[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState("");
  const [initial, setInitial] = useState(0);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let live = true;
    let refresh = 0;
    const load = async () => {
      const version = ++refresh;
      const summaries = await listRooms();
      const local = await Promise.all(summaries.map((r) => getRoom(r.id)));
      if (!live || version !== refresh) return;
      const privateRooms: RoomsPageRoom[] = local.filter((r) => r !== null).map((r) => ({
        id: r.id, label: r.label, plan: r.editedPlan,
        description: r.model ? "Your scan · measured layout, photo-informed furniture" : "Your scan · measured layout, furniture stand-ins",
        reconstruction: r.model ? { plan: r.sourcePlan, texturedModel: r.model, binding: r.binding } : undefined,
      }));
      const demos = await Promise.all(own.map(async (room) => {
        const [hydrated, draft] = await Promise.all([hydrateCatalogRoom(room), getRoomDraft(room.id)]);
        return { ...hydrated, plan: draft ?? hydrated.plan };
      }));
      if (!live || version !== refresh) return;
      const next = [...privateRooms, ...demos];
      let selected: string | null = null;
      try { selected = sessionStorage.getItem("tadaima:last-room"); } catch { /* storage is optional */ }
      setInitial(Math.max(0, next.findIndex((r) => r.id === selected)));
      setRooms(next);
      setGeneration((g) => g + 1);
    };
    const report = (cause: unknown) => { if (live) { setNotice(cause instanceof Error ? cause.message : "Saved rooms could not load."); setRooms((previous) => previous ?? own); } };
    const unsubscribe = subscribeRooms(() => { load().catch(report); });
    (async () => {
      try {
        const imported = await bootstrapLocalCapture();
        if (imported) { try { sessionStorage.setItem("tadaima:last-room", imported.id); } catch { /* optional */ } }
        const pending = sessionStorage.getItem("tadaima:pending-address");
        if (pending && live) setNotice(`Address saved: ${pending}. Automatic address research is not connected yet. Import a reconstructed room or explore a demo below.`);
      } catch (cause) { report(cause); }
      await load();
    })().catch(report);
    return () => { live = false; unsubscribe(); };
  }, [own]);

  useEffect(() => {
    if (!importing) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handle = (event: KeyboardEvent) => {
      const modal = document.querySelector<HTMLElement>(".rooms-page__import-overlay");
      if (!modal) return;
      if (event.key === "Escape" && !modal.querySelector('[aria-busy="true"]')) { event.preventDefault(); setImporting(false); }
      if (event.key !== "Tab") return;
      const controls = Array.from(modal.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), a[href]"));
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", handle, true);
    const observer = new MutationObserver(() => {
      const modal = document.querySelector<HTMLElement>(".rooms-page__import-overlay");
      if (modal && !modal.contains(document.activeElement)) modal.querySelector<HTMLElement>("input, button")?.focus();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.querySelector<HTMLElement>(".rooms-page__import-overlay input")?.focus();
    return () => { observer.disconnect(); window.removeEventListener("keydown", handle, true); opener?.focus({ preventScroll: true }); };
  }, [importing]);

  if (!rooms) return <main className="rooms-page__message" role="status">Opening your rooms…</main>;

  return <>
    <RoomsPage rooms={rooms} initial={initial} generation={generation} onImport={() => setImporting(true)} notice={notice} onDismissNotice={() => { setNotice(""); try { sessionStorage.removeItem("tadaima:pending-address"); } catch { /* optional */ } }} />
    <PhoneScanInbox onImported={(room) => {
      try { sessionStorage.setItem("tadaima:last-room", room.id); } catch { /* optional */ }
      router.push(`/rooms/${room.id}`);
    }} />
    {importing ? <div className="rooms-page__import-overlay" role="dialog" aria-modal="true" aria-label="Import a room">
      <RoomImporter onCancel={() => setImporting(false)} onImported={(room) => {
        try { sessionStorage.setItem("tadaima:last-room", room.id); } catch { /* optional */ }
        setImporting(false);
        router.push(`/rooms/${room.id}`);
      }} />
    </div> : null}
  </>;
}
