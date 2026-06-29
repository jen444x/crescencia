import { useNavigate, useSearchParams } from "react-router-dom";
import Header from "../components/layout/Header";
import HabitForm, { type HabitValues } from "../components/HabitForm";

// Local "YYYY-MM-DD" for today, built from local parts (not toISOString, which is
// UTC and can land on the wrong day) — matches how the rest of the app dates the
// API. Used as the from_date when placing into a cycle (every day from today).
function todayYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function AddHabitPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // When opened from a cycle's "+ Add habit", these say which block to drop the
  // new habit into and at what position. Absent for a plain add (Habits page).
  const chainParam = params.get("chain");
  const chainId = chainParam != null ? Number(chainParam) : null;
  const orderParam = Number(params.get("order"));
  const order = Number.isFinite(orderParam) && orderParam > 0 ? orderParam : 1;

  async function createHabit(values: HabitValues) {
    const res = await fetch(`${import.meta.env.VITE_API_URL}/habits/create/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Could not create habit.");

    // Came from a cycle: place the new habit into it, every day from today, then
    // go back to that page (Plan or Everyday routine), which reloads on mount.
    if (chainId != null && !Number.isNaN(chainId)) {
      const place = await fetch(
        `${import.meta.env.VITE_API_URL}/schedules/arrange-forward/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from_date: todayYmd(),
            items: [{ habit: data.id, chain: chainId, tier: null, order }],
          }),
        },
      );
      if (!place.ok) throw new Error("Could not add the habit to that cycle.");
      navigate(-1);
      return;
    }

    // Plain add: new habits start unscheduled; the Plan page lists them.
    navigate("/plan/");
  }

  return (
    <>
      <Header title="Add habit" body="" />
      <div className="max-w-md mx-auto">
        <HabitForm submitLabel="Add habit" onSubmit={createHabit} />
      </div>
    </>
  );
}

export default AddHabitPage;
