import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Header from "../components/layout/Header";
import { useToast } from "../components/Toast";

// One paused habit (a habit with an ended_on). This page lists ONLY the retired
// ones, so paused habits have a home of their own instead of being mixed into
// the Habits list. Pulled from GET /habits/?include_ended=1 and filtered down.
type PausedHabit = {
  id: number;
  name: string;
  area_name: string | null;
  ended_on: string | null;
};

function PausedHabitsPage() {
  const [habits, setHabits] = useState<PausedHabit[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const toast = useToast();
  const navigate = useNavigate();

  async function load() {
    setIsLoading(true);
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/habits/?include_ended=1`,
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't load your paused habits");
        return;
      }
      // Only the retired ones — active habits live on the Habits page.
      setHabits((data as PausedHabit[]).filter((h) => h.ended_on != null));
      setError("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "An unknown error occurred",
      );
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function resume(habitId: number) {
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/habits/${habitId}/resume/`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      if (!res.ok) throw new Error("Request failed");
      // It's active again — drop it from this list.
      setHabits((prev) => prev.filter((h) => h.id !== habitId));
    } catch {
      toast("Couldn't resume that habit", { variant: "error" });
    }
  }

  return (
    <>
      <Header
        title="Paused habits"
        body="Habits you've stopped. They're off your plan and don't count as missed — their history is kept. Resume one to bring it back from today."
      />
      <div className="max-w-md mx-auto">
        <button
          onClick={() => navigate("/habits")}
          className="mb-4 text-sm font-medium text-calm-600 hover:text-calm-700"
        >
          ‹ Back to habits
        </button>

        {isLoading ? (
          <p className="text-center text-calm-500 text-sm">Loading...</p>
        ) : error ? (
          <div className="bg-red-50 rounded-xl p-4 text-center">
            <p className="text-red-500 text-sm">{error}</p>
          </div>
        ) : habits.length === 0 ? (
          <div className="bg-white rounded-2xl p-10 text-center shadow-sm">
            <h3 className="font-heading text-xl text-stone-900 mb-2">
              No paused habits
            </h3>
            <p className="text-stone-400 text-sm">
              When you stop a habit going forward, it shows up here.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {habits.map((habit) => (
              <div
                key={habit.id}
                className="flex items-center gap-3 rounded-xl bg-white px-3 py-2.5 shadow-sm"
              >
                <div className="min-w-0 flex-1">
                  <span className="block break-words text-sm font-medium text-calm-900">
                    {habit.name}
                  </span>
                  <span className="block text-xs text-stone-400">
                    Paused {habit.ended_on}
                    {habit.area_name ? ` · ${habit.area_name}` : ""}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => resume(habit.id)}
                  className="shrink-0 rounded-full border border-calm-300 px-3 py-1 text-xs font-medium text-calm-700 transition-colors hover:bg-calm-50"
                >
                  Resume
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export default PausedHabitsPage;
