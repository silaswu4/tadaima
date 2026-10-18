import { RoomHero } from "@/components/RoomHero";

export default function Home() {
  return (
    <main className="relative h-[100dvh] min-h-[560px] w-full overflow-hidden">
      <RoomHero />

      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-4 py-5 md:px-10">
        <span className="pointer-events-auto">Michael</span>
        <a href="#" className="pointer-events-auto text-ink transition-opacity hover:opacity-60">
          Sign in
        </a>
      </header>

      {/* placeholder copy */}
      <div className="pointer-events-none absolute bottom-6 left-4 flex max-w-[360px] flex-col gap-4 md:left-10">
        <p className="bg-surface/85 px-4 py-3 leading-relaxed text-ink backdrop-blur-md">
          This is a living room, rebuilt piece by piece. Point at anything to see what it is and how big it is.
        </p>
        <a
          href="#"
          className="pointer-events-auto w-fit bg-ink px-5 py-3 text-surface-soft transition-transform active:translate-y-[1px]"
        >
          Scan your room
        </a>
      </div>
    </main>
  );
}
