"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { RoomPlan } from "@/backend/contracts";
import { RoomExperience, type ExperienceRoom } from "@/spatial/components/RoomExperience";
import { getTadaimaRooms, hydrateCatalogRoom, withHandClearance } from "@/spatial/fixtures/roomsCatalog";
import { getRoom, getRoomDraft, saveEditedPlan, saveRoomDraft } from "@/spatial/rooms/registry";

export function RoomClient({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = use(params);
  const [loaded, setLoaded] = useState<{ routeId: string; room?: ExperienceRoom; error?: string } | null>(null);
  const saves = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    let live = true;
    (async () => {
      const own = getTadaimaRooms().find((r) => r.id === roomId || r.slug === roomId);
      let room: ExperienceRoom | undefined;
      if (own) {
        const [hydrated, draft] = await Promise.all([hydrateCatalogRoom(own), getRoomDraft(own.id)]);
        room = { ...hydrated, plan: draft ?? hydrated.plan };
      }
      else {
        const local = await getRoom(roomId);
        if (local) room = { id: local.id, label: local.label, plan: withHandClearance(local.editedPlan),
          sourceDescription: local.model ? "Measured layout · photo-informed furniture and finishes" : "Measured layout · furniture stand-ins",
          reconstruction: local.model ? { plan: local.sourcePlan, texturedModel: local.model, binding: local.binding } : undefined };
      }
      if (!live) return;
      if (room) { try { sessionStorage.setItem("tadaima:last-room", room.id); } catch { /* optional */ } }
      setLoaded({ routeId: roomId, room });
    })().catch((cause) => { if (live) setLoaded({ routeId: roomId, error: cause instanceof Error ? cause.message : "The room could not load." }); });
    return () => { live = false; };
  }, [roomId]);

  const save = useCallback((plan: RoomPlan) => {
    const snapshot = structuredClone(plan);
    const id = loaded?.routeId === roomId ? loaded.room?.id ?? roomId : roomId;
    const next = saves.current.catch(() => undefined).then(() => id.startsWith("local-scan-")
      ? saveEditedPlan(id, snapshot) : saveRoomDraft(id, snapshot));
    saves.current = next;
    return next.then(() => undefined);
  }, [roomId, loaded]);

  if (!loaded || loaded.routeId !== roomId) return <main className="rooms-page__message" role="status">Opening your room…</main>;
  if (!loaded.room) return <main className="rooms-page__message"><h1>This room is not available here</h1><p>{loaded.error ?? "Private scans are saved in the browser where you imported them. Open your scan here, or choose a demo room."}</p><Link href="/rooms">Back to rooms</Link></main>;
  return <RoomExperience key={roomId} room={loaded.room} onPlanChange={save} backHref="/rooms" />;
}
