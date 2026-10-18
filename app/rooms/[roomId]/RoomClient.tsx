"use client";

import { use, useEffect, useMemo, useState } from "react";
import { notFound } from "next/navigation";
import type { RoomPlan } from "@/backend/contracts";
import { RoomExperience } from "@/spatial/components/RoomExperience";
import type { WalkEnvironment } from "@/spatial/room/walk-api";
import { getTadaimaRooms } from "@/spatial/fixtures/roomsCatalog";

type WalkRoom = { id: string; label: string; plan: RoomPlan; environment?: WalkEnvironment };

// Optional machine-local walkable rooms (public/local-rooms/walk-manifest.json, never committed).
async function loadLocalWalkRoom(id: string): Promise<WalkRoom | null> {
  try {
    const res = await fetch("/local-rooms/walk-manifest.json", { cache: "no-store" });
    if (!res.ok) return null;
    const rooms = (await res.json()) as WalkRoom[];
    return (Array.isArray(rooms) && rooms.find((r) => r.id === id && r.plan)) || null;
  } catch {
    return null;
  }
}

export function RoomClient({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = use(params);
  const own = useMemo(() => getTadaimaRooms().find((r) => r.id === roomId || r.slug === roomId) ?? null, [roomId]);
  const [local, setLocal] = useState<WalkRoom | null | undefined>(own ? null : undefined);

  useEffect(() => {
    if (own) return;
    let live = true;
    loadLocalWalkRoom(roomId).then((r) => live && setLocal(r));
    return () => {
      live = false;
    };
  }, [own, roomId]);

  const room = own ?? local;
  if (room === undefined) return <main style={{ height: "100svh", background: "#f5f2eb" }} />;
  if (!room) notFound();
  return <RoomExperience key={room.id} room={room} backHref="/rooms" />;
}
