"use client";

import { useEffect, useMemo, useState } from "react";
import { RoomsPage, type RoomsPageRoom } from "@/spatial/components/RoomsPage";
import { getTadaimaRooms } from "@/spatial/fixtures/roomsCatalog";

// Optional machine-local rooms (public/local-rooms/manifest.json, never committed).
async function loadLocalRooms(): Promise<RoomsPageRoom[]> {
  try {
    const res = await fetch("/local-rooms/manifest.json", { cache: "no-store" });
    if (!res.ok) return [];
    const rooms = (await res.json()) as RoomsPageRoom[];
    return Array.isArray(rooms) ? rooms.filter((r) => r.id && r.label && r.baked) : [];
  } catch {
    return [];
  }
}

export default function Rooms() {
  const own = useMemo<RoomsPageRoom[]>(() => getTadaimaRooms(), []);
  const [rooms, setRooms] = useState<RoomsPageRoom[] | null>(null);

  useEffect(() => {
    let live = true;
    loadLocalRooms().then((local) => live && setRooms([...own, ...local]));
    return () => {
      live = false;
    };
  }, [own]);

  // The gallery builds every room up front, so wait for the full list once.
  if (!rooms) return <main style={{ height: "100svh", background: "#f5f2eb" }} />;
  return <RoomsPage rooms={rooms} />;
}
