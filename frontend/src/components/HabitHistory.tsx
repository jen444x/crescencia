import { useEffect, useState } from "react";
import { CARD, CARD_TITLE } from "./ui";

// One day of a habit's month, straight from /habits/<id>/history/.
type Day = {
  d: string; // "YYYY-MM-DD"
  state: DayState;
  reached: { level: number; name: string; label: number | null; value: string } | null;
};
type DayState = "COMPLETED" | "SKIPPED" | "MISSED" | "PENDING" | "ABSENT";

type History = {
  habit: { id: number; name: string };
  month: string; // "YYYY-MM"
  days: Day[];
  counts: Partial<Record<DayState, number>>;
};

// How each state reads on the grid. Deliberately NOT a single ramp: these are
// different KINDS of day, not degrees of the same thing, so each gets its own
// hue. Completed is the only saturated cell, so a good month is legible at a
// glance; skipped is a calm neutral (it was a decision, not a failure); missed
// borrows the Plan page's rose; pending is an empty outline; and absent barely
// registers — the habit wasn't in her life then, so it must not read as a gap
// she left.
const STATE: Record<
  DayState,
  { fill: string; ink: string; border?: string; label: string; blurb: string }
> = {
  COMPLETED: { fill: "#47a183", ink: "#f0faf5", label: "Done", blurb: "you did it" },
  SKIPPED: { fill: "#e4e9e7", ink: "#7d8a85", label: "Skipped", blurb: "deliberately off" },
  MISSED: { fill: "#f7dfe2", ink: "#c2707d", label: "Missed", blurb: "didn't happen" },
  PENDING: { fill: "#fff", ink: "#b8cabf", border: "1.5px solid #d2e8e0", label: "Ahead", blurb: "not yet" },
  ABSENT: { fill: "transparent", ink: "#dbe5e0", label: "Inactive", blurb: "habit wasn't active" },
};

const ORDER: DayState[] = ["COMPLETED", "SKIPPED", "MISSED", "PENDING", "ABSENT"];

// Seven equal columns that FILL the card, so the grid's edges line up with the
// title, legend and tally above and below it. (The aspiration goal calendar uses
// a fixed 32px centered track; centering it here left the grid visibly indented
// from the rest of the card's left-aligned content.) Fluid columns also scale
// with the screen instead of pinning to one phone width.
const GRID = { gridTemplateColumns: "repeat(7, minmax(0, 1fr))" } as const;

// Parse "YYYY-MM-DD" as a LOCAL date (new Date("...") reads it as UTC and can
// land on the wrong day west of GMT).
function parseISO(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function todayYmd() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// "YYYY-MM" shifted by n months.
function shiftMonth(month: string, n: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthTitle(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

// A month grid of one habit's history: which days she completed, skipped,
// missed, hasn't reached yet, or the habit simply wasn't active for.
function HabitHistory({ habitId }: { habitId: number }) {
  const [month, setMonth] = useState(() => todayYmd().slice(0, 7));
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function fetchHistory() {
      setIsLoading(true);
      setError("");
      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_URL}/habits/${habitId}/history/?month=${month}`,
        );
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error ?? "Could not load history.");
          return;
        }
        setHistory(data);
      } catch {
        if (!cancelled) setError("Could not load history.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    fetchHistory();
    // Ignore a response that lands after the month changed again.
    return () => {
      cancelled = true;
    };
  }, [habitId, month]);

  const today = todayYmd();
  // Pad the first partial week so weekday columns line up (Sunday-first).
  const lead = history?.days.length ? parseISO(history.days[0].d).getDay() : 0;
  const cells: (Day | null)[] = history
    ? [...Array(lead).fill(null), ...history.days]
    : [];

  return (
    <section className={`mt-4 p-4 ${CARD}`}>
      <div className="flex items-center justify-between gap-2">
        <h2 className={CARD_TITLE}>History</h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
            className="rounded-full px-2 py-1 text-calm-400 transition-colors hover:bg-whisper hover:text-calm-700"
          >
            ◀
          </button>
          <span className="min-w-[8.5rem] text-center text-[13px] font-semibold text-ink">
            {monthTitle(month)}
          </span>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
            className="rounded-full px-2 py-1 text-calm-400 transition-colors hover:bg-whisper hover:text-calm-700"
          >
            ▶
          </button>
        </div>
      </div>

      {error ? (
        <p className="py-6 text-center text-sm text-red-500">{error}</p>
      ) : (
        <>
          <div
            className={`mt-3 transition-opacity ${isLoading ? "opacity-40" : ""}`}
          >
            <div className="grid gap-[5px]" style={GRID}>
              {["S", "M", "T", "W", "T", "F", "S"].map((w, i) => (
                <div
                  key={i}
                  className="text-center text-[9.5px] font-semibold text-stone-300"
                >
                  {w}
                </div>
              ))}
            </div>

            <div className="mt-[5px] grid gap-[5px]" style={GRID}>
              {cells.map((c, i) => {
                if (!c) return <div key={i} className="aspect-square" />;
                const look = STATE[c.state];
                // The tooltip carries the detail the grid can't: the date, what
                // happened, and (on a completed day with a ladder) how far she got.
                const title = [
                  parseISO(c.d).toLocaleDateString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  }),
                  look.blurb,
                  c.reached?.value ? `reached ${c.reached.value}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <div
                    key={i}
                    title={title}
                    className="flex aspect-square items-center justify-center rounded-md text-[11px] font-medium tabular-nums"
                    style={{
                      background: look.fill,
                      color: look.ink,
                      border: look.border,
                      boxShadow:
                        c.d === today
                          ? "0 0 0 1.5px #fff, 0 0 0 3px #2f8168"
                          : undefined,
                    }}
                  >
                    {parseISO(c.d).getDate()}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Legend + this month's tally. ABSENT is left out of the counts line:
              "the habit didn't exist" isn't a score, and showing it as one
              invites reading it as a failure. */}
          <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1.5">
            {ORDER.map((state) => (
              <span
                key={state}
                className="flex items-center gap-1.5 text-[11px] text-stone-400"
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-[3px]"
                  style={{
                    background: STATE[state].fill,
                    border: STATE[state].border ?? "1px solid #e4e9e7",
                  }}
                />
                {STATE[state].label}
              </span>
            ))}
          </div>

          {history && (
            <p className="mt-3 border-t border-whisper pt-3 text-xs text-calm-700">
              <span className="font-semibold">
                {history.counts.COMPLETED ?? 0} done
              </span>
              {" · "}
              {history.counts.SKIPPED ?? 0} skipped {" · "}
              {history.counts.MISSED ?? 0} missed
            </p>
          )}
        </>
      )}
    </section>
  );
}

export default HabitHistory;
