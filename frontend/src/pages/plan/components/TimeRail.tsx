import { useEffect, useRef, useState } from "react";
import { RAIL_PX_PER_MIN, type Ruler } from "../useTimeRail";

// The time rail down the left of the habit list.
//
//   RESTING — a faint hairline, and nothing else. The chains' times stay in their
//   own headers where they've always been; the line is just the affordance that
//   says a habit can be dragged over here.
//
//   OPEN — a habit has been dragged onto it, and it becomes an ordinary ruler:
//   a mark every 15 minutes, running continuously in both directions. It opens
//   near where she already is (useTimeRail seeds it from the gap her finger is
//   holding) but it isn't fenced in — scrub as far as you like.
//
// The day's existing chains are marked on the ruler too, so scrubbing onto one
// means "put it in that chain" rather than "make a second chain at the same
// minute". The rail is a way into the existing chains, not only a way to make
// new times.
//
// It lives INSIDE the list container and is bounded by it, so it can never draw
// over the plant, the quote, or the toolbar.

// The permanent gutter the list keeps clear. Only the hairline lives here at
// rest, so it stays narrow; the open ruler's labels overflow to the right, over
// the list, which is dimmed while it's up.
export const RAIL_WIDTH = 22;
// Where the hairline sits inside that gutter.
const SPINE_X = 15;
// How far right of the tick the LIVE time is drawn. A fingertip covers roughly
// 40px around the touch point, and the touch point is the rail — so the live
// pill clears it instead of hiding under it.
const FINGER_CLEARANCE = 46;

// "6:30 AM" -> "6:30a". A ruler marked every 15 minutes is a lot of labels, and
// the compact form keeps each one to a single short line.
function compactTime(min: number): string {
  const hour = Math.floor(min / 60);
  const minute = String(min % 60).padStart(2, "0");
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${minute}${hour >= 12 ? "p" : "a"}`;
}

const DAY_END_MIN = 23 * 60 + 59;
const STEP = 15;

export function TimeRail({
  ruler,
  previewMin,
  joinChainMin,
  names,
  habitName,
}: {
  // The open ruler; null while resting.
  ruler: Ruler | null;
  // The live time under the finger; null while resting.
  previewMin: number | null;
  // Set when that time IS an existing chain — the drop joins it instead.
  joinChainMin: number | null;
  // Chain names by start minute.
  names: Map<number, string>;
  // The habit being placed. The floating drag card is hidden while the ruler is
  // up (it rides the finger and would cover the very mark it's setting), so the
  // ruler has to say what's being placed as well as when.
  habitName: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The drag reports viewport px; this element draws in its own. `height` bounds
  // what may be drawn, so a mark never escapes the list.
  const [geo, setGeo] = useState({ originY: 0, height: 0 });
  const isOpen = ruler != null;

  useEffect(() => {
    const measure = () => {
      const rect = ref.current?.getBoundingClientRect();
      setGeo({ originY: rect?.top ?? 0, height: rect?.height ?? 0 });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
    // Re-measured when the ruler opens or closes, which changes what's drawn.
  }, [isOpen]);

  const inside = (y: number) => y >= 0 && y <= geo.height;
  // Where a minute sits on the open ruler — the same scale useTimeRail.minuteAt
  // reads back, so the marks and the finger always agree.
  const yForMin = (min: number) =>
    ruler == null
      ? 0
      : ruler.anchorY - geo.originY + (min - ruler.seedMin) * RAIL_PX_PER_MIN;

  // Only the marks actually on screen. The ruler is continuous, so this comes
  // from the visible band rather than from any fixed range.
  const marks: number[] = [];
  if (ruler != null && geo.height > 0) {
    const span = Math.ceil(geo.height / RAIL_PX_PER_MIN) + STEP * 2;
    const from = Math.max(0, Math.floor((ruler.seedMin - span) / STEP) * STEP);
    const to = Math.min(DAY_END_MIN, ruler.seedMin + span);
    for (let m = from; m <= to; m += STEP) {
      if (inside(yForMin(m))) marks.push(m);
    }
  }

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 left-0 z-20"
      style={{ width: RAIL_WIDTH }}
    >
      {/* A quiet backing for the open ruler. Its labels overflow the narrow
        gutter and would otherwise sit straight on top of the habit rows; this
        gives them a surface to read against without hiding the list. */}
      {isOpen && (
        <span
          className="absolute inset-y-0 left-0 bg-white/80 backdrop-blur-[2px]"
          style={{ width: SPINE_X + 52 }}
        />
      )}

      {/* The hairline. Barely there at rest; lit while the drag is on it. */}
      <span
        className={`absolute inset-y-0 w-px transition-colors ${
          isOpen ? "bg-calm-500" : "bg-mist"
        }`}
        style={{ left: SPINE_X }}
      />

      {ruler != null &&
        marks.map((m) => {
          const y = yForMin(m);
          const isHour = m % 60 === 0;
          const isChain = ruler.chainMins.includes(m);
          const targeted = joinChainMin === m;
          const name = names.get(m);
          // The mark the finger is on. previewMin is snapped to the same 15
          // minutes the marks step by, so it always lands exactly on one — and
          // lighting it up is what makes the ruler visibly respond as she moves.
          // Without this the labels sit still and the rail reads as dead.
          const here = previewMin === m;
          return (
            <div
              key={`mark-${m}`}
              className="absolute left-0 flex -translate-y-1/2 items-center whitespace-nowrap"
              style={{ top: y }}
            >
              {/* The tick itself, on the hairline. */}
              <span
                className={`shrink-0 ${
                  here
                    ? "h-0.5 w-6 bg-calm-700"
                    : isChain
                      ? "h-0.5 w-4 bg-calm-500"
                      : isHour
                        ? "h-px w-4 bg-calm-400"
                        : "h-px w-2.5 bg-calm-300"
                }`}
                style={{ marginLeft: SPINE_X - 8 }}
              />
              {/* The label, overflowing right over the dimmed list. The one under
                the finger becomes a solid pill — it's the answer to "what time
                is this?", so it has to be the loudest thing on the strip.
                It is also pushed clear to the RIGHT: the finger sits on the
                rail itself, so a pill drawn at the tick was underneath it and
                the one number she actually needed was the one she couldn't
                see. */}
              <span
                className={`tabular-nums ${
                  here
                    ? "rounded-full bg-calm-600 px-2 py-0.5 text-[11px] font-semibold text-white shadow ring-2 ring-white"
                    : isChain
                      ? "text-[10px] font-semibold text-calm-600"
                      : isHour
                        ? "text-[10px] font-medium text-calm-500"
                        : "text-[10px] text-calm-400"
                }`}
                style={{ marginLeft: here ? FINGER_CLEARANCE : 6 }}
              >
                {compactTime(m)}
              </span>
              {/* What's being placed, on the mark it would land on. */}
              {here && habitName && !isChain && (
                <span className="ml-2 max-w-40 truncate rounded-md bg-white px-1.5 py-0.5 text-[10px] font-medium text-calm-700 shadow ring-1 ring-mist">
                  {habitName}
                </span>
              )}
              {/* An existing chain: say which, and that landing here joins it. */}
              {isChain && name && (
                <span
                  className={`ml-1.5 max-w-40 truncate rounded-md px-1.5 py-0.5 text-[10px] shadow-sm ${
                    targeted
                      ? "bg-calm-600 font-semibold text-white"
                      : "bg-white/95 text-calm-500"
                  }`}
                >
                  {targeted ? "Add to " : ""}
                  {name}
                </span>
              )}
            </div>
          );
        })}

    </div>
  );
}
