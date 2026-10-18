import type { Metadata } from "next";
import { Inter, Inter_Tight } from "next/font/google";
import localFont from "next/font/local";
import "@/frontend/styles/globals.css";

// paper mono, by paper.design (SIL OFL, see fonts/PaperMono-OFL.txt)
const mono = localFont({
  src: "./fonts/PaperMono.woff2",
  variable: "--font-mono",
  weight: "100 800",
});

// the product faces: Inter Tight for display, Inter for everything else
const display = Inter_Tight({ subsets: ["latin"], variable: "--font-display" });
const body = Inter({ subsets: ["latin"], variable: "--font-body" });

export const metadata: Metadata = {
  title: "tadaima",
  description: "Scan your room, swap anything, buy what fits.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${mono.variable} ${display.variable} ${body.variable} antialiased`}>
      <body>{children}</body>
    </html>
  );
}
