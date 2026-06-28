import { useState, useEffect } from "react";

// Shared by the Add and Edit aspiration pages — mirrors HabitForm: controlled
// inputs, validates name, hands the assembled values to `onSubmit`.
export type AspirationValues = {
  name: string;
  reason: string;
  motivation: string;
  notes: string;
  habit_ids: number[];
};

type HabitOption = { id: number; name: string };

const fieldClass =
  "w-full px-4 py-4 bg-white border border-calm-200 rounded-xl focus:outline-none focus:border-calm-500 text-calm-900 placeholder:text-calm-400";

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
        habit_ids: habitIds,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label className="block text-calm-700 text-sm mb-2 font-medium">
          Aspiration
        </label>
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
        <label className="block text-calm-700 text-sm mb-2 font-medium">
          Reason
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          placeholder="Why you want this"
          className={`${fieldClass} resize-none`}
        />
      </div>

      <div>
        <label className="block text-calm-700 text-sm mb-2 font-medium">
          Motivation
        </label>
        <textarea
          value={motivation}
          onChange={(e) => setMotivation(e.target.value)}
          rows={2}
          placeholder="What keeps you going"
          className={`${fieldClass} resize-none`}
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
          placeholder="Anything else"
          className={`${fieldClass} resize-none`}
        />
      </div>

      <div>
        <label className="block text-calm-700 text-sm mb-2 font-medium">
          Habits
        </label>
        {habits.length === 0 ? (
          <p className="text-calm-400 text-sm">No habits to attach yet.</p>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {habits.map((h) => (
              <label
                key={h.id}
                className="flex items-center gap-3 bg-white border border-calm-200 rounded-xl px-4 py-3 cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={habitIds.includes(h.id)}
                  onChange={() => toggleHabit(h.id)}
                  className="h-4 w-4 rounded border-calm-300 text-calm-600 focus:ring-calm-500"
                />
                <span className="text-calm-900 text-sm">{h.name}</span>
              </label>
            ))}
          </div>
        )}
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

export default AspirationForm;
