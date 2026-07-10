import { useState, useEffect, useRef } from "react";
import { CARD, F_LABEL, F_INPUT, BTN_PRIMARY } from "./ui";

export type HabitValues = {
  name: string;
  notes: string;
  area: number | null;
  is_support: boolean;
  // The aspirations this habit works toward (a habit can support several).
  // Empty on pages that don't offer the picker (the Add page passes no options).
  aspiration_ids: number[];
};

type Area = {
  id: number;
  name: string;
};

// One choosable aspiration for the (optional) aspiration dropdown.
export type AspirationOption = {
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
  aspirationOptions,
}: {
  initial?: HabitValues;
  submitLabel: string;
  onSubmit: (values: HabitValues) => Promise<void>;
  // When provided, an "Aspiration" dropdown is shown (non-helper habits only).
  // Omit it to hide the field entirely (e.g. the Add page).
  aspirationOptions?: AspirationOption[];
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [area, setArea] = useState<number | null>(initial?.area ?? null);
  const [isSupport, setIsSupport] = useState(initial?.is_support ?? false);
  const [aspirationIds, setAspirationIds] = useState<number[]>(
    initial?.aspiration_ids ?? [],
  );
  // The aspiration dropdown is a checklist popover; track its open state and a
  // ref so a click outside closes it.
  const [aspOpen, setAspOpen] = useState(false);
  const aspRef = useRef<HTMLDivElement>(null);
  const [areas, setAreas] = useState<Area[]>([]);
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Close the aspiration checklist when clicking anywhere outside it.
  useEffect(() => {
    if (!aspOpen) return;
    function onDown(e: MouseEvent) {
      if (aspRef.current && !aspRef.current.contains(e.target as Node)) {
        setAspOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [aspOpen]);

  function toggleAspiration(aspId: number) {
    setAspirationIds((ids) =>
      ids.includes(aspId) ? ids.filter((x) => x !== aspId) : [...ids, aspId],
    );
  }

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
        aspiration_ids: aspirationIds,
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

      {/* Aspirations this habit works toward — shown only when the parent offers
          options (the Edit page) and the habit isn't a helper. Sits between
          Notes and Area. A checklist dropdown, so several can be picked. */}
      {aspirationOptions && !isSupport && (
        <div className="relative" ref={aspRef}>
          <label className={F_LABEL}>
            Aspirations
          </label>
          <button
            type="button"
            onClick={() => setAspOpen((o) => !o)}
            aria-expanded={aspOpen}
            className={`${fieldClass} flex items-center justify-between gap-2 text-left`}
          >
            <span
              className={`truncate ${
                aspirationIds.length ? "text-ink" : "text-stone-400"
              }`}
            >
              {aspirationIds.length
                ? aspirationOptions
                    .filter((a) => aspirationIds.includes(a.id))
                    .map((a) => a.name)
                    .join(", ")
                : "None"}
            </span>
            <svg
              className={`h-4 w-4 shrink-0 text-stone-400 transition-transform ${
                aspOpen ? "rotate-180" : ""
              }`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {aspOpen && (
            <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-xl border border-mist bg-white p-1 shadow-[0_8px_24px_rgba(27,46,42,0.12)]">
              {aspirationOptions.length === 0 ? (
                <p className="px-3 py-2 text-sm text-stone-400">
                  No aspirations yet — create one on the Aspirations tab.
                </p>
              ) : (
                aspirationOptions.map((a) => (
                  <label
                    key={a.id}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink hover:bg-whisper"
                  >
                    <input
                      type="checkbox"
                      checked={aspirationIds.includes(a.id)}
                      onChange={() => toggleAspiration(a.id)}
                      className="h-4 w-4 rounded border-mist accent-calm-600"
                    />
                    <span>{a.name}</span>
                  </label>
                ))
              )}
            </div>
          )}
        </div>
      )}

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
