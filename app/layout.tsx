import type { Metadata } from "next";
import { Instrument_Serif } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

const serif = Instrument_Serif({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: "400",
});

// paper mono, by paper.design (SIL OFL, see fonts/PaperMono-OFL.txt)
const mono = localFont({
  src: "./fonts/PaperMono.woff2",
  variable: "--font-mono",
  weight: "100 800",
});

export const metadata: Metadata = {
  title: "michael",
  description: "scan your room, swap anything, buy what fits.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${serif.variable} ${mono.variable} antialiased`}>
      <body>{children}</body>
    </html>
  );
}
