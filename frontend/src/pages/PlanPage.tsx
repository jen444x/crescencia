import { useState, useEffect, type ReactNode } from "react";
import Header from "../components/layout/Header";
import { useNavigate } from "react-router-dom";

type Plan = {
  id: number;
  time: string | null;
  habits: Habit[];
};
type Habit = {
  id: number;
  name: string;
  chain?: number | null;
  order?: number;
  // Has this habit been completed today? Comes from the backend so the
  // toggle shows the right state after a page refresh. Optional for now
  // (defaults to "not done") until your /plan/ endpoint sends it.
  done_today?: boolean;
};

// A plan's habits, grouped for rendering: standalone habits stay on their own,
// habits sharing a chain id collapse into one ordered chain.
type PlanItem =
  | { kind: "single"; habit: Habit }
  | { kind: "chain"; chainId: number; steps: Habit[] };

// "08:00:00" -> "8:00 AM"; null/empty -> "Anytime"
function formatTime(time: string | null) {
  if (!time) return "Anytime";
  const [hourStr, minute] = time.split(":");
  const hour = parseInt(hourStr, 10);
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${minute} ${period}`;
}

function groupHabits(habits: Habit[]): PlanItem[] {
  const items: PlanItem[] = [];
  const chainPos = new Map<number, number>(); // chain id -> index in items

  for (const habit of habits) {
    if (habit.chain == null) {
      items.push({ kind: "single", habit });
      continue;
    }
    const pos = chainPos.get(habit.chain);
    if (pos === undefined) {
      chainPos.set(habit.chain, items.length);
      items.push({ kind: "chain", chainId: habit.chain, steps: [habit] });
    } else {
      (items[pos] as Extract<PlanItem, { kind: "chain" }>).steps.push(habit);
    }
  }

  // Make sure each chain reads 1 -> 2 -> 3 regardless of backend order.
  for (const item of items) {
    if (item.kind === "chain") {
      item.steps.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
  }

  return items;
}

// Return a NEW plans array with one habit's completion flipped.
// Pure + immutable: we build new objects instead of mutating the old ones,
// so React reliably notices the change and re-renders.
function setHabitDone(plans: Plan[], habitId: number, done: boolean): Plan[] {
  return plans.map((plan) => ({
    ...plan,
    habits: plan.habits.map((habit) =>
      habit.id === habitId ? { ...habit, done_today: done } : habit,
    ),
  }));
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

function HabitCard({
  habit,
  done,
  onToggle,
  leading,
}: {
  habit: Habit;
  done: boolean;
  onToggle: () => void;
  leading?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <div
      onClick={() => navigate(`/habits/${habit.id}`)}
      className={`group flex items-center gap-3 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow cursor-pointer ${
        done ? "bg-calm-50" : "bg-white"
      }`}
    >
      {leading}
      <h3
        className={`flex-1 font-medium ${
          done ? "text-calm-400 line-through" : "text-calm-900"
        }`}
      >
        {habit.name}
      </h3>

      {/* Complete toggle. We stopPropagation so tapping it doesn't ALSO
          fire the card's navigate() and open the detail page. */}
      <button
        type="button"
        aria-label={done ? "Mark as not done today" : "Mark as done today"}
        aria-pressed={done}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
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

function PlansPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // Toggle a habit's "done today" state. We flip the UI FIRST (optimistic
  // update) so it feels instant, then tell the backend. If the request
  // fails we roll the UI back, so it never lies about what's actually saved.
  async function toggleHabit(habitId: number, nextDone: boolean) {
    setPlans((prev) => setHabitDone(prev, habitId, nextDone));

    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/habits/${habitId}/log/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: nextDone ? "COMPLETED" : "UNTRACKED",
          }),
        },
      );
      if (!res.ok) throw new Error("Request failed");
    } catch {
      // Undo the optimistic flip.
      setPlans((prev) => setHabitDone(prev, habitId, !nextDone));
    }
  }

  useEffect(() => {
    async function fetchPlans() {
      setIsLoading(true);

      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL}/plan/`, {
          method: "GET",
          headers: {},
        });

        const data = await res.json();
        if (!res.ok) {
          setError(data.error);
          return;
        }
        setPlans(data);
      } catch (error) {
        setError(
          error instanceof Error ? error.message : "An unknown error occurred",
        );
      } finally {
        setIsLoading(false);
      }
    }
    fetchPlans();
  }, []);

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

  if (plans.length === 0) {
    return (
      <div className="max-w-md mx-auto">
        <div className="bg-white rounded-2xl p-10 text-center shadow-sm">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-accent-100 flex items-center justify-center">
            <span className="text-3xl">&#x1F331;</span>
          </div>
          <h3 className="font-heading text-xl text-stone-900 mb-2">
            No habits yet
          </h3>
          <p className="text-stone-400 text-sm">
            Create your first habit to push your limits
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <Header title="Plan" body="" />
      <div className="max-w-md mx-auto space-y-8">
        {plans.map((plan) => (
          <section key={plan.id}>
            {/* Time label with a divider line */}
            <div className="flex items-center gap-3 mb-3">
              <span className="text-xs font-medium uppercase tracking-wide text-calm-600">
                {formatTime(plan.time)}
              </span>
              <div className="flex-1 h-px bg-calm-200" />
            </div>

            {/* Habits scheduled at this time */}
            <ul className="space-y-2">
              {groupHabits(plan.habits).map((item) =>
                item.kind === "single" ? (
                  <li key={`h-${item.habit.id}`}>
                    <HabitCard
                      habit={item.habit}
                      done={!!item.habit.done_today}
                      onToggle={() =>
                        toggleHabit(item.habit.id, !item.habit.done_today)
                      }
                      leading={
                        <span className="h-2 w-2 rounded-full bg-calm-400 shrink-0" />
                      }
                    />
                  </li>
                ) : (
                  <li key={`c-${item.chainId}`}>
                    {item.steps.map((step, i) => {
                      const isLast = i === item.steps.length - 1;
                      return (
                        <div key={step.id} className="flex gap-3">
                          {/* Step number + connecting line */}
                          <div className="flex flex-col items-center">
                            <span className="z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-calm-600 text-[11px] font-medium text-white">
                              {i + 1}
                            </span>
                            {!isLast && (
                              <span className="w-px grow bg-calm-300" />
                            )}
                          </div>
                          <div className={`flex-1 ${isLast ? "" : "pb-2"}`}>
                            <HabitCard
                              habit={step}
                              done={!!step.done_today}
                              onToggle={() =>
                                toggleHabit(step.id, !step.done_today)
                              }
                            />
                          </div>
                        </div>
                      );
                    })}
                  </li>
                ),
              )}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

export default PlansPage;
