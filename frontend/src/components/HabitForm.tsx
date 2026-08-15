import { useState, useEffect, useRef, type ReactNode } from "react";
import { CARD, F_LABEL, F_INPUT, BTN_PRIMARY, SEG } from "./ui";

export type HabitValues = {
  name: string;
  notes: string;
  area: number | null;
  is_support: boolean;
  // The aspirations this habit works toward (a habit can support several).
  // Empty on pages that don't offer the picker (the Add page passes no options).
  aspiration_ids: number[];
  // The Roots(1)/Growth(2) tag the habit's first ladder rung wears. Only sent by
  // pages that show the tier picker (the Add page); undefined elsewhere, since
  // the Edit page's ladder editor owns the tags after creation.
  label?: number;
  // The starter rung's typed meaning (Add page only): a "by" deadline as
  // "HH:MM", and a length in minutes. Together with the name they ARE the habit
  // at birth; more versions come later on the habit's page.
  target_time?: string | null;
  duration?: string | null;
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
  tierPicker,
  ladder,
}: {
  initial?: HabitValues;
  submitLabel: string;
  onSubmit: (values: HabitValues) => Promise<void>;
  // When provided, an "Aspiration" dropdown is shown (non-helper habits only).
  // Omit it to hide the field entirely (e.g. the Add page).
  aspirationOptions?: AspirationOption[];
  // True shows the Roots/Growth picker that tags the habit's first ladder rung.
  // Add page only — on Edit, the ladder editor owns the tags.
  tierPicker?: boolean;
  // The Edit page's version-rows editor, rendered INSIDE the habit card right
  // under the name — name + versions together are the habit; notes/area/
  // aspirations are details about it and live in their own card below.
  ladder?: ReactNode;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [area, setArea] = useState<number | null>(initial?.area ?? null);
  const [isSupport, setIsSupport] = useState(initial?.is_support ?? false);
  const [aspirationIds, setAspirationIds] = useState<number[]>(
    initial?.aspiration_ids ?? [],
  );
  // New habits start at Roots — the everyday minimum, and the rung most habits
  // only ever have.
  const [label, setLabel] = useState<number>(initial?.label ?? 1);
  // The starter rung's By/For (Add page). "" = not set.
  const [targetTime, setTargetTime] = useState(initial?.target_time ?? "");
  const [durationText, setDurationText] = useState(initial?.duration ?? "");
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
        ...(tierPicker
          ? {
              label,
              target_time: targetTime || null,
              duration: durationText.trim(),
            }
          : {}),
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
      {/* Card 1 — THE HABIT: name + its time/length (and on Edit, its version
          rows). Together these are what the habit IS; everything else is
          details about it and lives in the card below. */}
      <div className={`space-y-4 p-4 ${CARD}`}>
        <div>
          <label className={F_LABEL}>Habit</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            type="text"
            placeholder="Name"
            maxLength={200}
            className={fieldClass}
          />
        </div>

        {/* The starter rung's By / For + its Roots/Growth tag (Add page). A new
            habit gets exactly one rung carrying these; more versions come later
            on the habit's page. */}
        {tierPicker && (
          <div>
            {/* A soft invitation between the name and the optional extras. */}
            <p className="mb-3 text-[11px] leading-relaxed text-stone-400">
              Want to make your goal more specific?
            </p>
            <div className="space-y-3">
              <div>
                <label className={F_LABEL}>Done by?</label>
                <input
                  type="time"
                  value={targetTime}
                  onChange={(e) => setTargetTime(e.target.value)}
                  className={fieldClass}
                />
              </div>
              <div>
                <label className={F_LABEL}>How long?</label>
                <input
                  type="text"
                  value={durationText}
                  onChange={(e) => setDurationText(e.target.value)}
                  placeholder="e.g. 10 mins"
                  className={fieldClass}
                />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className={SEG} role="group" aria-label="Tier">
                {([1, 2] as const).map((level) => (
                  <button
                    key={level}
                    type="button"
                    onClick={() => setLabel(level)}
                    aria-pressed={label === level}
                    className={`rounded-full px-4 py-1 text-xs transition-colors ${
                      label === level
                        ? level === 1
                          ? "bg-blush font-semibold text-clay"
                          : "bg-mint font-semibold text-calm-700"
                        : "font-medium text-stone-400 hover:text-stone-600"
                    }`}
                  >
                    {level === 1 ? "Roots" : "Growth"}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Edit page: the version rows live here, right under the name. */}
        {ladder}
      </div>

      {/* Card 2 — DETAILS: notes, aspirations, area, helper flag. */}
      <div className={`space-y-4 p-4 ${CARD}`}>
        <div>
          <label className={F_LABEL}>Notes</label>
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
            <label className={F_LABEL}>Aspirations</label>
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
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19 9l-7 7-7-7"
                />
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
          <label className={F_LABEL}>Area</label>
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
            Helper habit — a step that supports a main one (hidden from the
            Habits list)
          </span>
        </label>
      </div>

      {error && <p className="text-red-500 text-sm">{error}</p>}

      <button type="submit" disabled={isSaving} className={BTN_PRIMARY}>
        {isSaving ? "Saving..." : submitLabel}
      </button>
    </form>
  );
}

export default HabitForm;
