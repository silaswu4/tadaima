import { Suspense } from "react";
import { RoomClient } from "./RoomClient";

export default function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  return (
    <Suspense fallback={<main style={{ height: "100svh", background: "#f5f2eb" }} />}>
      <RoomClient params={params} />
    </Suspense>
  );
}
