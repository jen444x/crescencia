import { useState, useEffect } from "react";
import Header from "../components/layout/Header";
import { useToast } from "../components/Toast";

// The statuses we can WRITE for a habit's day. Matches the backend's
// HabitLog.Status (the log endpoint only accepts these three).
type HabitStatus = "PENDING" | "COMPLETED" | "SKIPPED";

// One tier of a habit's ladder (e.g. Roots / Growth), low -> high by level.
type HabitTier = { level: number; name: string; value: string };

// A habit as returned by GET /habits/ : the habit plus today's tracking state.
// `tiers` is [] for an untiered habit; `achieved_tier` is today's highest
// completed tier level (the cascade truth), null when nothing's done.
type HabitRow = {
  id: number;
  name: string;
  area: number | null;
  area_name: string | null;
  is_important: boolean;
  tiers: HabitTier[];
  status: HabitStatus;
  achieved_tier: number | null;
};

// Filled star marking an "important" habit. Filled (not outline) so it reads as
// a clear marker at a glance next to the name. Mirrors PlanPage's StarIcon.
function StarIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-4 w-4"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M9.05 2.93c.3-.92 1.6-.92 1.9 0l1.42 4.38a1 1 0 00.95.69h4.6c.97 0 1.37 1.24.59 1.81l-3.73 2.71a1 1 0 00-.36 1.12l1.42 4.38c.3.92-.75 1.69-1.54 1.12l-3.72-2.71a1 1 0 00-1.18 0l-3.72 2.71c-.79.57-1.84-.2-1.54-1.12l1.42-4.38a1 1 0 00-.36-1.12L1.48 9.81c-.78-.57-.38-1.81.59-1.81h4.6a1 1 0 00.95-.69L9.05 2.93z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={3}
        d="M5 13l4 4L19 7"
      />
    </svg>
  );
}

// One tier row inside a habit card. A tier reads "done" when the habit's
// achieved_tier has reached THIS tier's level (so completing Growth cascades to
// mark Roots done too). Tapping a not-done tier completes at its level; tapping
// a done tier sends the habit back to PENDING (undo the whole day).
function TierRow({
  tier,
  done,
  onComplete,
  onUndo,
}: {
  tier: HabitTier;
  done: boolean;
  onComplete: () => void;
  onUndo: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors ${
        done ? "bg-calm-50" : "bg-stone-50"
      }`}
    >
      <div className="min-w-0 flex-1">
        <span
          className={`block break-words text-sm font-medium ${
            done ? "text-calm-400 line-through" : "text-calm-900"
          }`}
        >
          {tier.name}
        </span>
        {tier.value && (
          <span
            className={`block text-xs ${done ? "text-calm-300" : "text-stone-400"}`}
          >
            {tier.value}
          </span>
        )}
      </div>

      <button
        type="button"
        aria-label={done ? `Undo ${tier.name}` : `Complete ${tier.name}`}
        aria-pressed={done}
        onClick={done ? onUndo : onComplete}
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors ${
          done
            ? "border-calm-600 bg-calm-600 text-white"
            : "border-calm-300 text-transparent hover:border-calm-500"
        }`}
      >
        <CheckIcon />
      </button>
    </div>
  );
}

// One habit as a card: name + optional star + area label, then either its tier
// stack (higher tier on top) or a single complete control when untiered.
function HabitCard({
  habit,
  onLog,
}: {
  habit: HabitRow;
  onLog: (habitId: number, status: HabitStatus, tier?: number) => void;
}) {
  const tiered = habit.tiers.length > 0;
  // Untiered: a plain done state from the log status.
  const untieredDone = habit.status === "COMPLETED";

  return (
    <div className="bg-white rounded-2xl p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        {habit.is_important && (
          <span className="shrink-0 text-amber-400">
            <StarIcon />
          </span>
        )}
        <h3 className="min-w-0 flex-1 break-words font-medium text-stone-900">
          {habit.name}
        </h3>
        {habit.area_name && (
          <span className="shrink-0 rounded-full bg-accent-100 px-2 py-0.5 text-[11px] font-medium text-stone-500">
            {habit.area_name}
          </span>
        )}
      </div>

      {tiered ? (
        // Stacked tiers, HIGHER tier on top (render reversed: tiers come low->high).
        <div className="space-y-1.5">
          {[...habit.tiers]
            .sort((a, b) => b.level - a.level)
            .map((tier) => (
              <TierRow
                key={tier.level}
                tier={tier}
                // Cascade: done when achieved_tier reaches this tier's level.
                done={
                  habit.achieved_tier != null &&
                  habit.achieved_tier >= tier.level
                }
                onComplete={() => onLog(habit.id, "COMPLETED", tier.level)}
                onUndo={() => onLog(habit.id, "PENDING")}
              />
            ))}
        </div>
      ) : (
        // Untiered: a single complete/undo control driven by the log status.
        <button
          type="button"
          aria-label={
            untieredDone ? "Mark as not done today" : "Mark as done today"
          }
          aria-pressed={untieredDone}
          onClick={() =>
            onLog(habit.id, untieredDone ? "PENDING" : "COMPLETED")
          }
          className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 transition-colors ${
            untieredDone ? "bg-calm-50" : "bg-stone-50 hover:bg-stone-100"
          }`}
        >
          <span
            className={`flex-1 text-left text-sm font-medium ${
              untieredDone ? "text-calm-400 line-through" : "text-calm-900"
            }`}
          >
            {untieredDone ? "Done today" : "Mark done"}
          </span>
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors ${
              untieredDone
                ? "border-calm-600 bg-calm-600 text-white"
                : "border-calm-300 text-transparent"
            }`}
          >
            <CheckIcon />
          </span>
        </button>
      )}
    </div>
  );
}

function HabitsPage() {
  const [habits, setHabits] = useState<HabitRow[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  // "Important only" filter, off by default (show all habits).
  const [importantOnly, setImportantOnly] = useState(false);
  const toast = useToast();

  // Initial load (with the spinner). Defined INSIDE the effect — mirrors
  // AreasPage, and keeps the setState off the effect's synchronous path.
  useEffect(() => {
    async function fetchHabits() {
      setIsLoading(true);
      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL}/habits/`, {
          method: "GET",
          headers: {},
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Couldn't load your habits");
          return;
        }
        setHabits(data);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "An unknown error occurred",
        );
      } finally {
        setIsLoading(false);
      }
    }
    fetchHabits();
  }, []);

  // A quiet re-fetch (no spinner) used after a log POST, so the cascaded
  // achieved_tier truth comes straight from the backend rather than us guessing
  // it client-side. Reliability over cleverness.
  async function reloadHabits() {
    const res = await fetch(`${import.meta.env.VITE_API_URL}/habits/`, {
      method: "GET",
      headers: {},
    });
    const data = await res.json();
    if (!res.ok) throw new Error("Request failed");
    setHabits(data);
  }

  // Complete / undo a habit (optionally at a tier), then re-fetch GET /habits/
  // to pick up the cascade across the whole tier stack.
  async function logHabit(
    habitId: number,
    status: HabitStatus,
    tier?: number,
  ) {
    try {
      const body: { status: HabitStatus; tier?: number } = { status };
      if (status === "COMPLETED" && tier != null) body.tier = tier;

      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/habits/${habitId}/log/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw new Error("Request failed");
      await reloadHabits();
    } catch {
      toast("Couldn't update that habit", { variant: "error" });
    }
  }

  if (isLoading) {
    return (
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-center py-12">
          <div className="w-6 h-6 border-2 border-calm-300 border-t-calm-600 rounded-full animate-spin"></div>
          <span className="ml-3 text-stone-400 text-sm">Loading habits...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-md mx-auto">
        <div className="bg-red-50 rounded-xl p-4 text-center">
          <p className="text-red-500 text-sm">{error}</p>
        </div>
      </div>
    );
  }

  if (habits.length === 0) {
    return (
      <>
        <Header title="Habits" body="" />
        <div className="max-w-md mx-auto">
          <div className="bg-white rounded-2xl p-10 text-center shadow-sm">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-accent-100 flex items-center justify-center">
              <span className="text-3xl">&#x1F331;</span>
            </div>
            <h3 className="font-heading text-xl text-stone-900 mb-2">
              No habits yet
            </h3>
            <p className="text-stone-400 text-sm">
              Add your first habit to start growing
            </p>
          </div>
        </div>
      </>
    );
  }

  const visible = importantOnly
    ? habits.filter((habit) => habit.is_important)
    : habits;

  return (
    <>
      <Header title="Habits" body="" />
      <div className="max-w-md mx-auto">
        {/* "Important only" filter, off by default. */}
        <div className="mb-4 flex items-center justify-end">
          <button
            type="button"
            onClick={() => setImportantOnly((on) => !on)}
            aria-pressed={importantOnly}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              importantOnly
                ? "bg-amber-100 text-amber-700"
                : "bg-white text-stone-400 shadow-sm hover:text-stone-600"
            }`}
          >
            <StarIcon />
            Important only
          </button>
        </div>

        {visible.length === 0 ? (
          <div className="bg-white rounded-2xl p-8 text-center shadow-sm">
            <p className="text-stone-400 text-sm">
              No important habits yet. Star a habit to see it here.
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {visible.map((habit) => (
              <li key={habit.id}>
                <HabitCard habit={habit} onLog={logHabit} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export default HabitsPage;