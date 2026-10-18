import { AsciiHero } from "@/spatial/components/AsciiHero";

export default function Home() {
  return (
    <main className="relative h-[100dvh] min-h-[560px] w-full overflow-hidden bg-black">
      <AsciiHero />
      {/* soft dark pool behind the copy so it reads over the bright doorway */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_75%_30%_at_50%_40%,rgba(0,0,0,0.85),transparent)] md:bg-[radial-gradient(ellipse_40%_32%_at_50%_38%,rgba(0,0,0,0.78),transparent)]" />

      <header className="pointer-events-none absolute inset-x-0 top-0 flex justify-end px-4 py-5 md:px-10">
        <a href="#" className="pointer-events-auto text-white transition-opacity hover:opacity-60">
          Sign in
        </a>
      </header>

      {/* placeholder copy */}
      <div className="pointer-events-none absolute inset-x-0 top-[25%] flex flex-col items-center gap-5 px-4 text-center">
        <h1 className="text-[clamp(44px,8vw,112px)] leading-none font-medium tracking-[-0.04em] text-white">Michael</h1>
        <p className="max-w-[40ch] leading-relaxed text-white/75">
          Scan your room, swap anything in it, and buy the pieces that actually fit.
        </p>
        <a
          href="#"
          className="pointer-events-auto mt-1 bg-white px-5 py-3 text-ink transition-transform active:translate-y-[1px]"
        >
          Scan your room
        </a>
      </div>
    </main>
  );
}
