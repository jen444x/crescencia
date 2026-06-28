import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Header from "../components/layout/Header";
import AspirationForm, {
  type AspirationValues,
} from "../components/AspirationForm";

function EditAspirationPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [initial, setInitial] = useState<AspirationValues | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    async function fetchAspiration() {
      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_URL}/aspirations/${id}/`,
        );
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Could not load aspiration.");
          return;
        }
        setInitial({
          name: data.name,
          reason: data.reason,
          motivation: data.motivation,
          notes: data.notes,
          habit_ids: data.habit_ids,
        });
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "An unknown error occurred",
        );
      }
    }
    fetchAspiration();
  }, [id]);

  async function saveAspiration(values: AspirationValues) {
    const res = await fetch(
      `${import.meta.env.VITE_API_URL}/aspirations/${id}/edit/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Could not save aspiration.");
    navigate(`/aspirations/${id}`);
  }

  return (
    <>
      <Header title="Edit aspiration" body="" />
      <div className="max-w-md mx-auto">
        {error && (
          <p className="text-red-500 text-sm text-center mb-4">{error}</p>
        )}
        {initial && (
          <AspirationForm
            initial={initial}
            submitLabel="Save changes"
            onSubmit={saveAspiration}
          />
        )}
      </div>
    </>
  );
}

export default EditAspirationPage;
