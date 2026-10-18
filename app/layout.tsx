import type { Metadata } from "next";
import localFont from "next/font/local";
import "@/frontend/styles/globals.css";

// paper mono, by paper.design (SIL OFL, see fonts/PaperMono-OFL.txt)
const mono = localFont({
  src: "./fonts/PaperMono.woff2",
  variable: "--font-mono",
  weight: "100 800",
});

export const metadata: Metadata = {
  title: "tadaima",
  description: "Scan your room, swap anything, buy what fits.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${mono.variable} antialiased`}>
      <body>{children}</body>
    </html>
  );
}
