import { useState, useEffect } from "react";
import { CARD, F_LABEL, F_INPUT, BTN_PRIMARY, BLOOMS } from "./ui";

// Shared by the Add and Edit aspiration pages — mirrors HabitForm: controlled
// inputs, validates name, hands the assembled values to `onSubmit`.
export type AspirationValues = {
  name: string;
  reason: string;
  motivation: string;
  notes: string;
  // Chosen bloom color index (0-5), or null to keep the id-based default.
  color: number | null;
  // "YYYY-MM-DD" deadline, or null for an open-ended (forever) aspiration.
  target_date: string | null;
  habit_ids: number[];
};

type HabitOption = { id: number; name: string };

const fieldClass = F_INPUT;

function AspirationForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial?: AspirationValues;
  submitLabel: string;
  onSubmit: (values: AspirationValues) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [reason, setReason] = useState(initial?.reason ?? "");
  const [motivation, setMotivation] = useState(initial?.motivation ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [color, setColor] = useState<number | null>(initial?.color ?? null);
  const [targetDate, setTargetDate] = useState<string>(initial?.target_date ?? "");
  const [habitIds, setHabitIds] = useState<number[]>(initial?.habit_ids ?? []);
  const [habits, setHabits] = useState<HabitOption[]>([]);
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // All habits to choose from for the attach picker. Optional — fail quietly.
  useEffect(() => {
    async function fetchHabits() {
      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL}/habits/`);
        const data = await res.json();
        if (res.ok) setHabits(data);
      } catch {
        // picker is optional; ignore
      }
    }
    fetchHabits();
  }, []);

  function toggleHabit(id: number) {
    setHabitIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

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
        reason: reason.trim(),
        motivation: motivation.trim(),
        notes: notes.trim(),
        color,
        target_date: targetDate || null,
        habit_ids: habitIds,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className={`space-y-4 p-4 ${CARD}`}>
        <div>
          <label className={F_LABEL}>Aspiration</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            type="text"
            placeholder="e.g. Move more"
            maxLength={200}
            className={fieldClass}
          />
        </div>

        <div>
          <label className={F_LABEL}>Color</label>
          <div className="flex flex-wrap gap-3">
            {BLOOMS.map((b, i) => {
              const selected = color === i;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setColor(i)}
                  aria-label={`Color ${i + 1}`}
                  aria-pressed={selected}
                  className={`flex h-8 w-8 items-center justify-center rounded-full transition ${
                    selected
                      ? "ring-2 ring-calm-600 ring-offset-2 ring-offset-white"
                      : ""
                  }`}
                  style={{ background: b.dot }}
                >
                  {selected && (
                    <svg
                      className="h-4 w-4 text-white"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={3}
                      aria-hidden
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className={F_LABEL}>Target date</label>
          <input
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
            className={fieldClass}
          />
          <p className="mt-1.5 text-xs text-stone-400">
            {targetDate ? (
              <>
                Counts down to this day, with a heatmap of your progress.{" "}
                <button
                  type="button"
                  onClick={() => setTargetDate("")}
                  className="font-semibold text-calm-600 underline"
                >
                  Clear
                </button>
              </>
            ) : (
              "Optional — add a deadline to make this a goal with a countdown."
            )}
          </p>
        </div>

        <div>
          <label className={F_LABEL}>Reason</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Why do you want to do this"
            className={`${fieldClass} resize-none`}
          />
        </div>

        <div>
          <label className={F_LABEL}>Motivation</label>
          <textarea
            value={motivation}
            onChange={(e) => setMotivation(e.target.value)}
            rows={2}
            placeholder="Why you should keep going"
            className={`${fieldClass} resize-none`}
          />
        </div>

        <div>
          <label className={F_LABEL}>Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Anything else"
            className={`${fieldClass} resize-none`}
          />
        </div>

        <div>
          <label className={F_LABEL}>Habits</label>
          {habits.length === 0 ? (
            <p className="text-calm-400 text-sm">No habits to attach yet.</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {habits.map((h) => (
                <label
                  key={h.id}
                  className="flex items-center gap-3 rounded-xl border border-mist bg-white px-4 py-3 cursor-pointer select-none"
                >
                  <input
                    type="checkbox"
                    checked={habitIds.includes(h.id)}
                    onChange={() => toggleHabit(h.id)}
                    className="h-4 w-4 rounded border-mist accent-calm-600"
                  />
                  <span className="text-calm-900 text-sm">{h.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && <p className="text-red-500 text-sm">{error}</p>}

      <button type="submit" disabled={isSaving} className={BTN_PRIMARY}>
        {isSaving ? "Saving..." : submitLabel}
      </button>
    </form>
  );
}

export default AspirationForm;
