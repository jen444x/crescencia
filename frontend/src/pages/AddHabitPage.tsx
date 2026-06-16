import { useNavigate } from "react-router-dom";
import Header from "../components/layout/Header";
import HabitForm, { type HabitValues } from "../components/HabitForm";

function AddHabitPage() {
  const navigate = useNavigate();

  async function createHabit(values: HabitValues) {
    const res = await fetch(
      `${import.meta.env.VITE_API_URL}/habits/create/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Could not create habit.");
    // New habits start unscheduled; the Plan page shows them in its list.
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
