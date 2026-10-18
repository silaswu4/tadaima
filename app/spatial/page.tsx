import type { Metadata } from "next";
import { ViewerLab } from "@/spatial/components/ViewerLab";

// development bench for the spatial viewer (Silas). thin route only.
export const metadata: Metadata = {
  title: "Spatial lab",
  robots: { index: false },
};

export default function SpatialLabPage() {
  return <ViewerLab />;
}
