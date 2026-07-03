import { useState, useEffect } from "react";
import { CARD, F_LABEL, F_INPUT, BTN_PRIMARY } from "./ui";

export type HabitValues = {
  name: string;
  notes: string;
  area: number | null;
  is_support: boolean;
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
  const [isSupport, setIsSupport] = useState(initial?.is_support ?? false);
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
      await onSubmit({
        name: name.trim(),
        notes: notes.trim(),
        area,
        is_support: isSupport,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setIsSaving(false);
    }
  }

  const fieldClass = F_INPUT;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* All the fields live in one card; the save pill stands alone below. */}
      <div className={`space-y-4 p-4 ${CARD}`}>
      <div>
        <label className={F_LABEL}>
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
        <label className={F_LABEL}>
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
        <label className={F_LABEL}>
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

      <label className="flex items-start gap-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={isSupport}
          onChange={(e) => setIsSupport(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-mist accent-calm-600"
        />
        <span className="text-xs leading-relaxed text-calm-700">
          Helper habit — a step that supports a main one (hidden from the Habits list)
        </span>
      </label>
      </div>

      {error && <p className="text-red-500 text-sm">{error}</p>}

      <button
        type="submit"
        disabled={isSaving}
        className={BTN_PRIMARY}
      >
        {isSaving ? "Saving..." : submitLabel}
      </button>
    </form>
  );
}

export default HabitForm;
