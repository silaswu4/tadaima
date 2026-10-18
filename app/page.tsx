import { RoomFigure } from "@/components/RoomFigure";

export default function Home() {
  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-[1400px] flex-col px-4 md:px-10">
      <header className="rise flex items-center justify-between py-6">
        <span className="text-ink">michael</span>
        <a
          href="#"
          className="text-ink-soft transition-colors hover:text-ink active:translate-y-[1px]"
        >
          sign in
        </a>
      </header>

      <main className="grid flex-1 grid-cols-1 items-center gap-10 pb-10 md:grid-cols-[5fr_7fr] md:gap-6">
        <section className="flex flex-col gap-8 md:pb-16">
          {/* placeholder copy */}
          <h1 className="display rise" style={{ animationDelay: "120ms" }}>
            your room,
            <br />
            rearranged.
          </h1>
          <p
            className="rise max-w-[34ch] leading-relaxed text-ink-soft"
            style={{ animationDelay: "260ms" }}
          >
            scan your room, swap anything in it, and buy the pieces that
            actually fit.
          </p>
          <div className="rise" style={{ animationDelay: "400ms" }}>
            <a
              href="#"
              className="inline-flex items-center gap-3 rounded-full bg-accent px-6 py-3 text-surface-soft transition-colors hover:bg-accent-deep active:translate-y-[1px]"
            >
              step inside
              <span aria-hidden>&rarr;</span>
            </a>
          </div>
        </section>

        <section className="rise" style={{ animationDelay: "300ms" }}>
          <RoomFigure />
        </section>
      </main>
    </div>
  );
}
