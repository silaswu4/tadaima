"use client";

import { useMemo } from "react";
import { IsoRoomGallery } from "@/spatial/components/IsoRoomGallery";
import { makeGalleryRooms } from "@/spatial/fixtures/galleryRooms";

// Development preview for the room gallery.
export default function IsoGalleryPreview() {
  const rooms = useMemo(() => makeGalleryRooms(), []);
  return (
    <main style={{ height: "100svh" }}>
      <IsoRoomGallery rooms={rooms} hrefFor={() => "/room"} />
    </main>
  );
}
