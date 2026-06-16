import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Header from "../components/layout/Header";
import HabitForm, { type HabitValues } from "../components/HabitForm";

function EditHabitPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [initial, setInitial] = useState<HabitValues | null>(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  // Load the habit so the form can pre-fill its current name/notes/area.
  useEffect(() => {
    async function fetchHabit() {
      setIsLoading(true);
      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_URL}/habits/${id}/`,
        );
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Could not load habit.");
          return;
        }
        setInitial({ name: data.name, notes: data.notes, area: data.area });
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "An unknown error occurred",
        );
      } finally {
        setIsLoading(false);
      }
    }
    fetchHabit();
  }, [id]);

  async function saveHabit(values: HabitValues) {
    const res = await fetch(
      `${import.meta.env.VITE_API_URL}/habits/${id}/edit/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Could not save habit.");
    // Back to wherever they opened this from (usually the Plan page).
    navigate(-1);
  }

  return (
    <>
      <Header title="Edit habit" body="" />
      <div className="max-w-md mx-auto">
        {isLoading && (
          <p className="text-center text-calm-500 text-sm">Loading...</p>
        )}
        {error && <p className="text-red-500 text-sm text-center">{error}</p>}
        {initial && (
          <HabitForm
            initial={initial}
            submitLabel="Save changes"
            onSubmit={saveHabit}
          />
        )}
      </div>
    </>
  );
}

export default EditHabitPage;
