import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import Header from "../components/layout/Header";
import { CARD, HEADER_ACTION } from "../components/ui";

type DayCell = { done: boolean; existed: boolean };
type VersionWeek = {
  level: number;
  name: string; // "Roots" / "Growth" / ...
  value: string; // e.g. "5000 steps"
  days: DayCell[];
};
type HabitWeek = {
  id: number;
  name: string;
  tiers: VersionWeek[]; // one strip per version; [] when the habit is untiered
  days: DayCell[]; // untiered habit only
};
type Aspiration = { id: number; name: string; habits: HabitWeek[] };

// 7-day completion strip: filled = done, hollow = not done, whisper = the habit
// didn't exist that day yet (so it couldn't have been done). Drawn on the same
// 7-column grid as DowRow so each dot sits under its weekday letter.
function WeekRow({ days }: { days: DayCell[] }) {
  return (
    <div className="grid grid-cols-[repeat(7,15px)] gap-[7px]">
      {days.map((d, i) => (
        <span
          key={i}
          className={`h-[15px] w-[15px] rounded-full ${
            !d.existed
              ? "bg-whisper"
              : d.done
                ? "bg-calm-600"
                : "border-[1.5px] border-mist"
          }`}
        />
      ))}
    </div>
  );
}

// Weekday letters over the dot strips, one row per card. The letters come from
// the SERVER's window dates (a rolling 7 days ending on the server's today),
// not the browser clock — a viewer in another timezone can be on a different
// calendar day than the backend, and deriving letters locally would label
// every dot one column off. Parsed by hand: `new Date("YYYY-MM-DD")` is UTC
// midnight and can shift the weekday locally.
function DowRow({ window: days }: { window: string[] }) {
  const letters = days.map((ymd) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return "SMTWTFS"[new Date(y, m - 1, d).getDay()];
  });
  return (
    <div className="mb-1.5 grid grid-cols-[repeat(7,15px)] gap-[7px]">
      {letters.map((letter, i) => (
        <span
          key={i}
          className="text-center text-[9px] font-semibold text-stone-400"
        >
          {letter}
        </span>
      ))}
    </div>
  );
}

// Right-pointing chevron that rotates down when its section is open.
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-4 w-4 shrink-0 text-calm-400 transition-transform ${
        open ? "rotate-90" : ""
      }`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 5l7 7-7 7"
      />
    </svg>
  );
}

function AspirationsPage() {
  const [aspirations, setAspirations] = useState<Aspiration[]>([]);
  // The strip's dates ("YYYY-MM-DD", oldest first, last = the server's today),
  // straight from the response — the weekday letters are derived from these.
  const [windowDays, setWindowDays] = useState<string[]>([]);
  // Which aspirations are expanded. Seeded to "all open" on load.
  const [openIds, setOpenIds] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    async function fetchAspirations() {
      setIsLoading(true);
      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL}/aspirations/`);
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Could not load aspirations.");
          return;
        }
        setAspirations(data.aspirations);
        setWindowDays(data.window);
        setOpenIds(
          new Set(data.aspirations.map((a: Aspiration) => a.id)), // default: open
        );
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "An unknown error occurred",
        );
      } finally {
        setIsLoading(false);
      }
    }
    fetchAspirations();
  }, []);

  function toggleOne(id: number) {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allOpen =
    aspirations.length > 0 && aspirations.every((a) => openIds.has(a.id));

  function toggleAll() {
    setOpenIds(allOpen ? new Set() : new Set(aspirations.map((a) => a.id)));
  }

  return (
    <>
      <Header
        title="Aspirations"
        eyebrow="Where you're headed"
        action={
          <button
            onClick={() => navigate("/aspirations/new")}
            className={HEADER_ACTION}
          >
            + New
          </button>
        }
      />
      <div className="max-w-md mx-auto">
        {isLoading && (
          <p className="text-center text-calm-500 text-sm">
            Loading aspirations...
          </p>
        )}
        {error && <p className="text-red-500 text-sm text-center">{error}</p>}

        {!isLoading && !error && aspirations.length === 0 && (
          <div className={`p-10 text-center ${CARD}`}>
            <h3 className="font-heading text-xl text-ink mb-2">
              No aspirations yet
            </h3>
            <p className="text-stone-400 text-sm">
              Add one to group the habits that move you toward it.
            </p>
          </div>
        )}

        {aspirations.length > 0 && (
          <div className="flex justify-end mb-3">
            <button
              onClick={toggleAll}
              className="text-xs font-semibold text-calm-600 hover:text-calm-700"
            >
              {allOpen ? "Collapse all" : "Expand all"}
            </button>
          </div>
        )}

        <ul className="space-y-3">
          {aspirations.map((a) => {
            const open = openIds.has(a.id);
            return (
              <li key={a.id} className={`overflow-hidden ${CARD}`}>
                <button
                  onClick={() => toggleOne(a.id)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-2 p-4 text-left"
                >
                  <Chevron open={open} />
                  {/* Serif — an aspiration is an intention, not a list item. */}
                  <h3 className="min-w-0 flex-1 font-heading text-xl leading-snug text-ink">
                    {a.name}
                  </h3>
                  <span className="shrink-0 rounded-full bg-petal px-2.5 py-0.5 text-[11px] font-semibold text-calm-700">
                    {a.habits.length} habit{a.habits.length === 1 ? "" : "s"}
                  </span>
                </button>

                {open && (
                  <div className="space-y-3 px-4 pb-4">
                    {a.habits.length === 0 ? (
                      <p className="text-stone-400 text-sm">No habits yet.</p>
                    ) : (
                      <>
                        <DowRow window={windowDays} />
                        {a.habits.map((h) =>
                          h.tiers.length > 0 ? (
                            <div key={h.id}>
                              <p className="mb-2 text-[13px] font-medium text-ink">
                                {h.name}
                              </p>
                              <div className="space-y-2">
                                {h.tiers.map((t) => (
                                  <div key={t.level}>
                                    <p className="mb-1 text-[11px] font-medium text-calm-600">
                                      {t.name}
                                      {t.value && (
                                        <span className="text-stone-400">
                                          {" · "}
                                          {t.value}
                                        </span>
                                      )}
                                    </p>
                                    <WeekRow days={t.days} />
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div key={h.id}>
                              <p className="mb-1.5 text-[13px] font-medium text-ink">
                                {h.name}
                              </p>
                              <WeekRow days={h.days} />
                            </div>
                          ),
                        )}
                      </>
                    )}
                    <Link
                      to={`/aspirations/${a.id}`}
                      className="inline-block text-xs font-semibold text-calm-600 hover:text-calm-700"
                    >
                      Details ›
                    </Link>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

export default AspirationsPage;
