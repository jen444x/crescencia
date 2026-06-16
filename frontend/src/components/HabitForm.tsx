import { useState, useEffect } from "react";

export type HabitValues = {
  name: string;
  notes: string;
  area: number | null;
};

type Area = {
  id: number;
  name: string;
};

// The name/notes/area form shared by the Add and Edit pages. It owns the field
// state; the parent passes `initial` values and an `onSubmit` that does the
// actual API call (create vs edit) and navigation. onSubmit should throw on
// failure so we can show the error and re-enable the button.
function HabitForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial?: HabitValues;
  submitLabel: string;
  onSubmit: (values: HabitValues) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [area, setArea] = useState<number | null>(initial?.area ?? null);
  const [areas, setAreas] = useState<Area[]>([]);
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Load the areas for the picker. It's optional, so a failed load is ignored.
  useEffect(() => {
    async function fetchAreas() {
      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL}/areas/`);
        const data = await res.json();
        if (res.ok) setAreas(data);
      } catch {
        // Area picker is optional; leave it empty if areas can't load.
      }
    }
    fetchAreas();
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setError("");
    setIsSaving(true);
    try {
      await onSubmit({ name: name.trim(), notes: notes.trim(), area });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setIsSaving(false);
    }
  }

  const fieldClass =
    "w-full px-4 py-4 bg-white border border-calm-200 rounded-xl focus:outline-none focus:border-calm-500 text-calm-900 placeholder:text-calm-400";

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label className="block text-calm-700 text-sm mb-2 font-medium">
          Name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          type="text"
          placeholder="e.g. Drink water"
          maxLength={200}
          className={fieldClass}
        />
      </div>

      <div>
        <label className="block text-calm-700 text-sm mb-2 font-medium">
          Notes
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Optional details"
          className={`${fieldClass} resize-none`}
        />
      </div>

      <div>
        <label className="block text-calm-700 text-sm mb-2 font-medium">
          Area
        </label>
        <select
          value={area ?? ""}
          onChange={(e) =>
            setArea(e.target.value ? Number(e.target.value) : null)
          }
          className={fieldClass}
        >
          <option value="">No area</option>
          {areas.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="text-red-500 text-sm">{error}</p>}

      <button
        type="submit"
        disabled={isSaving}
        className="w-full bg-calm-600 text-white py-4 rounded-xl font-medium hover:bg-calm-700 transition-colors disabled:opacity-60"
      >
        {isSaving ? "Saving..." : submitLabel}
      </button>
    </form>
  );
}

export default HabitForm;
