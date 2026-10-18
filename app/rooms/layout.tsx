import { Inter, Inter_Tight } from "next/font/google";
import "@/spatial/components/RoomsPage.css";

// Same faces as the landing so the rooms screens read as one product.
const display = Inter_Tight({ subsets: ["latin"], variable: "--font-display" });
const body = Inter({ subsets: ["latin"], variable: "--font-body" });

export default function RoomsLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${display.variable} ${body.variable}`}>{children}</div>;
}
