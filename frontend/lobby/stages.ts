// The address lobby's run: what each stage is called, what it says while it works, and the demo room it
// builds. Ported in spirit from gist's pipeline stages (components/gist/pipeline/stages.ts): there the stages
// were derived from agent_tasks rows; here everything but the live browse is a paced script.

/**
 * Every address builds this room for now (the gallery's "Scanned studio", shown in the lobby as the 1A living
 * room). Change it here to point the demo at another gallery room.
 */
export const DEMO_ROOM_SLUG = "scanned-studio";
export const DEMO_ROOM_HREF = `/rooms/${DEMO_ROOM_SLUG}`;

/** The address the demo is scripted around, and the building it resolves to. */
export const DEMO_ADDRESS = "10965 Strathmore Dr, Los Angeles, CA 90024";
export const DEMO_BUILDING = { name: "Atrium Westwood", units: 84, stories: 6, built: 2022, site: "atrium-westwood.com" };
/**
 * Atrium Westwood lists no studios; its smallest layout is plan 1A (650 sq ft, one bedroom). The room the demo
 * opens is that apartment's living room, rebuilt from the listing's living room photo.
 */
export const DEMO_UNIT = { plan: "1A", sqft: 650, room: "1A living room" };
export const LISTING_PHOTO = "https://www.atrium-westwood.com/wp-content/uploads/2025/08/rwselby-atrium-livingroom2.jpg";

/**
 * The "Scanned studio" gallery room (id "photo-finish-reference", slug "scanned-studio" in
 * spatial/fixtures/roomsCatalog.ts, geometry from reconstruction/fixtures/photo-reference.request.json and
 * furniture from native-furniture.synthetic.json). Copied here as plain numbers so the landing page does not
 * pull the whole room catalog into its bundle. Meters, top-down: x to the right, z down the page, back wall at z = 0.
 */
export const STUDIO = {
  width: 4.2,
  depth: 3.5,
  height: 2.7,
  wallThickness: 0.12,
  // offset is measured from each wall's start corner, as in the RoomPlan contract
  door: { wall: "front", from: [4.2, 3.5], to: [0, 3.5], offset: 0.9, width: 0.9 },
  window: { wall: "back", from: [0, 0], to: [4.2, 0], offset: 1.4, width: 1.4, sill: 0.9, tall: 1.2 },
  // footprints after rotation: the sofa is turned a quarter, so its 1.8 m length runs down the room
  items: [
    { id: "sofa", label: "sofa", x: 1.0, z: 1.75, w: 0.8, d: 1.8, back: "left" as const },
    { id: "table", label: "table", x: 2.5, z: 1.75, w: 1.0, d: 0.6 },
  ],
} as const;

const SQ_FT_PER_M2 = 10.7639;
export const STUDIO_SQFT = Math.round(STUDIO.width * STUDIO.depth * SQ_FT_PER_M2);
const cm = (m: number) => Math.round(m * 100);

/** How far the plan sketch has got. Each scripted step can move it on. */
export type PlanPhase = "empty" | "walls" | "measured" | "door" | "window" | "furniture" | "raised" | "lit";
export const PLAN_ORDER: PlanPhase[] = ["empty", "walls", "measured", "door", "window", "furniture", "raised", "lit"];

export type StageId = "lookup" | "browse" | "read" | "trace" | "furnish" | "build";

export interface StageDef {
  id: StageId;
  title: string;
  explain: string;
  /** what the thought line says while it works, then once it lands ("Found it in 3.1s") */
  working: string;
  done: string;
}

export const STAGES: StageDef[] = [
  { id: "lookup", title: "Finding the building", explain: "Matches the address to a real building and what we know about it.", working: "Looking it up", done: "Found it in" },
  { id: "browse", title: "Browsing for the floorplan", explain: "An agent opens a real browser and looks through the listings for your unit.", working: "Browsing listings", done: "Browsed for" },
  { id: "read", title: "Reading the listing photo", explain: "Reads the listing's living room photo for finishes and furniture.", working: "Reading the photo", done: "Read it in" },
  { id: "trace", title: "Drawing the plan", explain: "Traces the walls, then scales everything from the entry door.", working: "Drawing the plan", done: "Drew it in" },
  { id: "furnish", title: "Placing what's there", explain: "Puts back the pieces seen in the photo, at their real size.", working: "Placing furniture", done: "Placed in" },
  { id: "build", title: "Building your room", explain: "Raises the walls and lights the room so you can walk in.", working: "Building the room", done: "Built in" },
];

export interface ScriptStep {
  text: string;
  /** seconds this step takes before the next one starts */
  ms: number;
  plan?: PlanPhase;
}

/** The first line of a typed address, tidied, for the lookup step. */
export function shortAddress(address: string): string {
  const first = address.split(",")[0]?.trim() || address.trim();
  return first.length > 48 ? `${first.slice(0, 45)}...` : first;
}

/** The browse stage's last line, live or replayed. */
export const PULL_STEP = `Pulling plan ${DEMO_UNIT.plan} and its listing photos`;

/** The scripted steps per stage. The browse stage's own steps are live when the browser is. */
export function script(address: string): Record<StageId, ScriptStep[]> {
  const b = DEMO_BUILDING;
  return {
    lookup: [
      { text: `Looking up ${shortAddress(address)}`, ms: 1300 },
      { text: `Found ${b.name}, ${b.units} units, built ${b.built}`, ms: 1700 },
      { text: `${b.stories} stories in Westwood, near UCLA`, ms: 1100 },
    ],
    // used when the live browser can't open (or as the run-up before it does)
    browse: [
      { text: "Checking listings on apartmentlist.com and hotpads.com", ms: 1600 },
      { text: `Opening the floor plans on ${b.site}`, ms: 1500 },
      { text: `No studios listed, smallest is plan ${DEMO_UNIT.plan} at ${DEMO_UNIT.sqft} sq ft`, ms: 1700 },
      { text: PULL_STEP, ms: 1300 },
    ],
    read: [
      { text: "Reading the living room photo", ms: 1800 },
      { text: "Warm taupe walls, dark wood-look floor", ms: 1200 },
    ],
    trace: [
      { text: "Tracing the living room's 4 walls", ms: 1700, plan: "walls" },
      {
        text: `Scaling from the ${cm(STUDIO.door.width)} cm entry door: ${STUDIO.width} x ${STUDIO.depth} m, ${STUDIO_SQFT} sq ft`,
        ms: 2100,
        plan: "measured",
      },
      { text: `Door on the front wall, ${cm(STUDIO.door.width)} cm`, ms: 1000, plan: "door" },
      { text: `Window on the back wall, ${STUDIO.window.width} m wide`, ms: 1300, plan: "window" },
    ],
    furnish: [
      { text: "Placing the sofa and table seen in the photo", ms: 1900, plan: "furniture" },
      { text: "Sofa 1.8 m long, table 1.0 x 0.6 m", ms: 1000 },
    ],
    build: [
      { text: `Raising walls to ${STUDIO.height} m`, ms: 1700, plan: "raised" },
      { text: "Lighting it from the window", ms: 1400, plan: "lit" },
      { text: `Your ${DEMO_UNIT.room} is ready`, ms: 900 },
    ],
  };
}

/** Live browsing gets at most this long on screen before the scripted stages carry on. */
export const BROWSE_MAX_MS = 35_000;
/** No live view by this long after the run started: show the replay instead. */
export const LIVE_VIEW_TIMEOUT_MS = 20_000;
export const POLL_MS = 2_000;
