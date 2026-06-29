import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import Header from "../components/layout/Header";

type DayCell = { done: boolean; existed: boolean };
type HabitWeek = { id: number; name: string; days: DayCell[] };
type Aspiration = { id: number; name: string; habits: HabitWeek[] };

// 7-day completion strip: filled = done, hollow = not done, grey = the habit
// didn't exist that day yet (so it couldn't have been done).
function WeekRow({ days }: { days: DayCell[] }) {
  return (
    <div className="flex items-center gap-1.5">
      {days.map((d, i) => (
        <span
          key={i}
          className={`h-3 w-3 rounded-full ${
            !d.existed
              ? "bg-stone-100"
              : d.done
                ? "bg-calm-600"
                : "border border-calm-300"
          }`}
        />
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
        setAspirations(data);
        setOpenIds(new Set(data.map((a: Aspiration) => a.id))); // default: open
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
      <Header title="Aspirations" body="" />
      <div className="max-w-md mx-auto">
        <button
          onClick={() => navigate("/aspirations/new")}
          className="w-full mb-4 bg-calm-600 text-white py-3 rounded-xl font-medium hover:bg-calm-700 transition-colors"
        >
          + New aspiration
        </button>

        {isLoading && (
          <p className="text-center text-calm-500 text-sm">
            Loading aspirations...
          </p>
        )}
        {error && <p className="text-red-500 text-sm text-center">{error}</p>}

        {!isLoading && !error && aspirations.length === 0 && (
          <div className="bg-white rounded-2xl p-10 text-center shadow-sm">
            <h3 className="font-heading text-xl text-stone-900 mb-2">
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
              className="text-xs font-medium text-calm-600 hover:text-calm-700"
            >
              {allOpen ? "Collapse all" : "Expand all"}
            </button>
          </div>
        )}

        <ul className="space-y-3">
          {aspirations.map((a) => {
            const open = openIds.has(a.id);
            return (
              <li
                key={a.id}
                className="bg-white rounded-xl shadow-sm overflow-hidden"
              >
                <button
                  onClick={() => toggleOne(a.id)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-2 p-4 text-left"
                >
                  <Chevron open={open} />
                  <h3 className="flex-1 font-medium text-stone-900">{a.name}</h3>
                  <span className="text-xs text-calm-400">
                    {a.habits.length} habit{a.habits.length === 1 ? "" : "s"}
                  </span>
                </button>

                {open && (
                  <div className="space-y-3 px-4 pb-4">
                    {a.habits.length === 0 ? (
                      <p className="text-stone-400 text-sm">No habits yet.</p>
                    ) : (
                      a.habits.map((h) => (
                        <div key={h.id}>
                          <p className="mb-1.5 text-sm text-calm-900">
                            {h.name}
                          </p>
                          <WeekRow days={h.days} />
                        </div>
                      ))
                    )}
                    <Link
                      to={`/aspirations/${a.id}`}
                      className="inline-block text-xs font-medium text-calm-600 hover:text-calm-700"
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
