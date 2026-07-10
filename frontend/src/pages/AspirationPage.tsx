import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Header from "../components/layout/Header";
import { CARD, F_LABEL, HEADER_CHIP, bloomFor } from "../components/ui";

type VersionProgress = {
  level: number;
  name: string; // "Roots" / "Growth" / ...
  value: string; // e.g. "5000 steps"
  days: boolean[]; // oldest first; last = today
  streak: number;
};

type HabitProgress = {
  id: number;
  name: string;
  tiers: VersionProgress[]; // one row per version; [] when the habit is untiered
  days: boolean[]; // untiered habit only (oldest first; last = today)
  streak: number;
};

// A habit/version's last-N-days completion as filled/hollow dots. The row is a
// grid that shares the card's width equally, so it can never spill off the
// card on a narrow phone (fixed-size dots could).
function DotRow({ days }: { days: boolean[] }) {
  return (
    <div
      className="grid gap-[5px]"
      style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
    >
      {days.map((done, i) => (
        <span
          key={i}
          className={`aspect-square w-full max-w-[15px] rounded-full ${
            done ? "bg-calm-600" : "border-[1.5px] border-mist"
          }`}
        />
      ))}
    </div>
  );
}

// --- Dated-goal countdown + heatmap -----------------------------------------

type Goal = {
  start_date: string; // window start (the day the aspiration was created)
  target_date: string; // the deadline
  today: string;
  total_days: number; // start..target inclusive
  elapsed_days: number; // start..today inclusive
  days_left: number; // today..target (clamped at 0)
  all_done_days: number; // elapsed days where EVERY applicable habit was done
  days: { d: string; done: number | null; total: number }[]; // done null = future
};

// The four heatmap shades: none → all-applicable-habits-done that day.
const HEAT = ["#e8efeb", "#c4e6d6", "#79c1a3", "#47a183"];

function heatLevel(done: number, total: number) {
  if (total === 0 || done === 0) return 0;
  const r = done / total;
  if (r >= 1) return 3;
  if (r >= 0.5) return 2;
  return 1;
}

// Parse "YYYY-MM-DD" as a LOCAL date (new Date("...") would read it as UTC and
// can land on the wrong day west of GMT).
function parseISO(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function fmtDate(s: string) {
  return parseISO(s).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// The 7-column calendar track, capped small and centered (matches the mock).
const GRID = {
  gridTemplateColumns: "repeat(7, minmax(0, 32px))",
  justifyContent: "center",
} as const;

function GoalCard({ goal, edge }: { goal: Goal; edge: string }) {
  // Pad the first partial week so weekday columns line up (Sunday-first).
  const lead = goal.days.length ? parseISO(goal.days[0].d).getDay() : 0;
  const cells: (Goal["days"][number] | null)[] = [
    ...Array(lead).fill(null),
    ...goal.days,
  ];

  return (
    <div className={`overflow-hidden ${CARD}`}>
      <div style={{ height: 6, background: edge }} />
      <div className="p-[18px]">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-stone-400">🎯 Target</span>
          <span className="text-[13px] font-bold text-clay">
            {fmtDate(goal.target_date)}
          </span>
        </div>

        <div className="mt-2 flex items-baseline gap-2">
          {goal.days_left > 0 ? (
            <>
              <span className="font-heading text-[52px] font-semibold leading-none text-ink">
                {goal.days_left}
              </span>
              <span className="text-sm text-stone-500">days to go</span>
            </>
          ) : (
            <span className="font-heading text-3xl font-semibold text-ink">
              {goal.today === goal.target_date
                ? "The day's here 🏁"
                : "Wrapped up 🏁"}
            </span>
          )}
        </div>

        <p className="text-xs text-stone-400">
          Started {fmtDate(goal.start_date)} · day {goal.elapsed_days} of{" "}
          {goal.total_days}
        </p>

        {goal.elapsed_days > 0 && (
          <p className="mt-3.5 flex items-center gap-1.5 text-[12.5px] font-semibold text-calm-700">
            🌱 {goal.all_done_days} full{" "}
            {goal.all_done_days === 1 ? "day" : "days"} so far
          </p>
        )}

        <div className="mt-3 grid gap-[5px]" style={GRID}>
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
            const day = parseISO(c.d).getDate();
            // The deadline itself is the finish flag, whatever its completion.
            if (c.d === goal.target_date) {
              return (
                <div
                  key={i}
                  className="flex aspect-square items-center justify-center rounded-md text-[11px]"
                  style={{ background: "#f6eae8", border: "1.5px solid #d9a79e" }}
                >
                  🏁
                </div>
              );
            }
            const future = c.done === null;
            const lvl = future ? -1 : heatLevel(c.done as number, c.total);
            const numColor = future
              ? "#b8cabf"
              : lvl >= 2
                ? "#f0faf5"
                : lvl === 1
                  ? "#5c8f79"
                  : "#a2b2ab";
            return (
              <div
                key={i}
                className="relative aspect-square rounded-md"
                style={{
                  background: future ? "#fff" : HEAT[lvl],
                  border: future ? "1.5px solid #d2e8e0" : undefined,
                  boxShadow:
                    c.d === goal.today
                      ? "0 0 0 1.5px #fff, 0 0 0 3px #2f8168"
                      : undefined,
                }}
              >
                <span
                  className="absolute left-1 top-0.5 text-[8px] font-semibold"
                  style={{ color: numColor }}
                >
                  {day}
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-3.5 flex flex-wrap items-center gap-x-3.5 gap-y-2 text-[11px] text-stone-400">
          <span className="flex items-center gap-1">
            less
            {HEAT.map((c, i) => (
              <span
                key={i}
                className="h-3 w-3 rounded"
                style={{ background: c }}
              />
            ))}
            all
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded border-[1.5px] border-mist bg-white" />
            to come
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="h-3 w-3 rounded"
              style={{
                background: "#79c1a3",
                boxShadow: "0 0 0 1px #fff, 0 0 0 2.5px #2f8168",
              }}
            />
            today
          </span>
        </div>
      </div>
    </div>
  );
}

type AspirationDetail = {
  id: number;
  name: string;
  reason: string;
  motivation: string;
  notes: string;
  color: number | null;
  created_at: string;
  target_date: string | null;
  goal: Goal | null;
  habit_ids: number[];
  habits: HabitProgress[];
  progress_days: number;
};

function AspirationPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<AspirationDetail | null>(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    async function fetchAspiration() {
      setIsLoading(true);
      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_URL}/aspirations/${id}/`,
        );
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Could not load aspiration.");
          return;
        }
        setDetail(data);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "An unknown error occurred",
        );
      } finally {
        setIsLoading(false);
      }
    }
    fetchAspiration();
  }, [id]);

  if (isLoading) {
    return (
      <div className="max-w-md mx-auto">
        <p className="text-center text-calm-500 text-sm py-8">Loading...</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="max-w-md mx-auto">
        <p className="text-red-500 text-sm text-center py-8">{error}</p>
      </div>
    );
  }
  if (!detail) return null;

  return (
    <>
      <Header
        title={detail.name}
        eyebrow="Aspiration"
        action={
          <button
            onClick={() => navigate(`/aspirations/${id}/edit`)}
            className={HEADER_CHIP}
          >
            Edit
          </button>
        }
      />
      <div className="max-w-md mx-auto space-y-4">

        {detail.goal && (
          <GoalCard
            goal={detail.goal}
            edge={bloomFor(detail.id, detail.color).edge}
          />
        )}

        {detail.reason && (
          <div className={`p-4 ${CARD}`}>
            <p className={F_LABEL}>
              Reason
            </p>
            <p className="text-ink text-sm whitespace-pre-wrap">
              {detail.reason}
            </p>
          </div>
        )}
        {detail.motivation && (
          <div className={`p-4 ${CARD}`}>
            <p className={F_LABEL}>
              Motivation
            </p>
            <p className="text-ink text-sm whitespace-pre-wrap">
              {detail.motivation}
            </p>
          </div>
        )}
        {detail.notes && (
          <div className={`p-4 ${CARD}`}>
            <p className={F_LABEL}>
              Notes
            </p>
            <p className="text-ink text-sm whitespace-pre-wrap">
              {detail.notes}
            </p>
          </div>
        )}

        <div>
          <div className="flex items-baseline justify-between mb-2 px-1">
            <h2 className="font-heading text-xl text-ink">
              How it's going
            </h2>
            <span className="text-xs text-stone-400">
              last {detail.progress_days} days
            </span>
          </div>

          {detail.habits.length === 0 ? (
            <div className={`p-6 text-center ${CARD}`}>
              <p className="text-stone-400 text-sm">
                No habits attached yet. Edit this aspiration to add some.
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {detail.habits.map((h) => (
                <li key={h.id} className={`p-4 ${CARD}`}>
                  {h.tiers.length > 0 ? (
                    <>
                      <p className="text-ink font-medium text-sm mb-3">
                        {h.name}
                      </p>
                      <div className="space-y-3">
                        {h.tiers.map((t) => (
                          <div key={t.level}>
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-xs font-medium text-calm-600">
                                {t.name}
                                {t.value && (
                                  <span className="text-calm-400">
                                    {" · "}
                                    {t.value}
                                  </span>
                                )}
                              </span>
                              <span className="whitespace-nowrap rounded-full bg-petal px-2 py-0.5 text-[11px] font-semibold text-calm-700">
                                🔥 {t.streak}
                              </span>
                            </div>
                            <DotRow days={t.days} />
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-ink font-medium text-sm">
                          {h.name}
                        </p>
                        <span className="whitespace-nowrap rounded-full bg-petal px-2 py-0.5 text-[11px] font-semibold text-calm-700">
                          🔥 {h.streak}
                        </span>
                      </div>
                      <DotRow days={h.days} />
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

export default AspirationPage;
