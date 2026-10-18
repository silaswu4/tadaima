import type { FurnitureCategory } from "../../backend/contracts";

/* Line icons shared by the room website and its VR panel, so both draw identical marks. */

export const Icon = {
  back: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10 3 5 8l5 5" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  ),
  undo: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.5 3 2.5 6l3 3" />
      <path d="M2.5 6H10a3.5 3.5 0 0 1 0 7H7" />
    </svg>
  ),
  lock: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  ),
  basket: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 6h11l-1.2 7a1 1 0 0 1-1 .8H4.7a1 1 0 0 1-1-.8z" />
      <path d="M5.5 6 8 2.5 10.5 6" />
    </svg>
  ),
  move: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2v12M2 8h12M8 2 6 4M8 2l2 2M8 14l-2-2M8 14l2-2M2 8l2-2M2 8l2 2M14 8l-2-2M14 8l-2 2" />
    </svg>
  ),
  rotate: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M12.5 8A4.5 4.5 0 1 1 8 3.5h2.5" />
      <path d="M9 1.5 11 3.5 9 5.5" />
    </svg>
  ),
  unlock: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" />
    </svg>
  ),
  arrow: (rot: number) => (
    <svg viewBox="0 0 16 16" aria-hidden="true" style={{ transform: `rotate(${rot}deg)` }}>
      <path d="M4 10 8 6l4 4" />
    </svg>
  ),
};

/** A small line drawing per kind of piece, for inventory slots. */
export function CategoryGlyph({ category }: { category: FurnitureCategory }) {
  const paths: Record<string, string> = {
    sofa: "M3 13v-3a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3M2 13h20v4H2zM4 17v2M20 17v2M6 8V6h12v2",
    chair: "M7 4h10v8H7zM5 12h14v3H5zM6 15v5M18 15v5",
    table: "M3 9h18M5 9v10M19 9v10M3 7h18v2H3z",
    desk: "M3 8h18v2H3zM5 10v9M19 10v9M14 10h5v5h-5z",
    storage: "M5 3h14v18H5zM5 9h14M5 15h14",
    bed: "M3 18V8M3 13h18v5M21 18v-5M6 13v-2a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2",
    rug: "M4 6h16v12H4zM7 9h10v6H7z",
    lamp: "M9 3h6l2 6H7zM12 9v10M8 21h8",
    decor: "M9 4h6v3a5 5 0 1 1-6 0z",
    other: "M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10",
  };
  return (
    <svg viewBox="0 0 24 24" className="room-x__slot-glyph" aria-hidden="true">
      <path d={paths[category] ?? paths.other} />
    </svg>
  );
}
