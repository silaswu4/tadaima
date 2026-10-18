import { RoomHero } from "@/components/RoomHero";

export default function Home() {
  return (
    <main className="relative h-[100dvh] min-h-[560px] w-full overflow-hidden">
      <RoomHero />

      <header className="pointer-events-none absolute inset-x-0 top-0 flex justify-end px-4 py-5 md:px-10">
        <a href="#" className="pointer-events-auto text-ink transition-opacity hover:opacity-60">
          Sign in
        </a>
      </header>

      {/* sits on the back wall, above the sofa. placeholder copy */}
      <div className="pointer-events-none absolute inset-x-0 top-[25%] flex flex-col items-center gap-5 px-4 text-center">
        <h1 className="text-[clamp(44px,8vw,112px)] leading-none font-medium tracking-[-0.04em] text-ink">Michael</h1>
        <p className="max-w-[40ch] leading-relaxed text-ink-soft">
          Scan your room, swap anything in it, and buy the pieces that actually fit.
        </p>
        <a
          href="#"
          className="pointer-events-auto mt-1 bg-ink px-5 py-3 text-surface-soft transition-transform active:translate-y-[1px]"
        >
          Scan your room
        </a>
      </div>
    </main>
  );
}
