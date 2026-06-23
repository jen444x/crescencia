import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Header from "../components/layout/Header";
import HabitForm, { type HabitValues } from "../components/HabitForm";

// One per-day note as returned by /habits/:id/notes/.
type Note = {
  id: number;
  body: string;
  date: string;
  habits: number[];
  shared: boolean;
  created_at: string;
  updated_at: string;
};

// One tier (Roots=1 / Growth=2) as returned by /habits/:id/.
type Tier = { level: number; name: string; value: string };

// Local "YYYY-MM-DD" for a Date — built from local parts (not toISOString,
// which is UTC and can land on the wrong day). Matches how the rest of the app
// formats dates for the API.
function toYmd(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function EditHabitPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [initial, setInitial] = useState<HabitValues | null>(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  // Notes section: which day to show, the notes for it, and its own load/error
  // state so it doesn't interfere with loading the habit itself.
  const [noteDate, setNoteDate] = useState(() => toYmd(new Date()));
  const [notes, setNotes] = useState<Note[]>([]);
  const [notesLoading, setNotesLoading] = useState(true);
  const [notesError, setNotesError] = useState("");

  // Tiers section: this habit's easy/everyday versions, plus the add/bump form
  // and its own saving/error state so a failed tier save can't break the page.
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [tierLevel, setTierLevel] = useState(2);
  const [tierValue, setTierValue] = useState("");
  const [tiersSaving, setTiersSaving] = useState(false);
  const [tiersError, setTiersError] = useState("");

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
        setInitial({
          name: data.name,
          notes: data.notes,
          area: data.area,
          is_support: data.is_support,
        });
        setTiers(data.tiers ?? []);
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

  // Load this habit's notes for the chosen day — refetched whenever the date
  // (or habit) changes.
  useEffect(() => {
    async function fetchNotes() {
      setNotesLoading(true);
      setNotesError("");
      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_URL}/habits/${id}/notes/?date=${noteDate}`,
        );
        const data = await res.json();
        if (!res.ok) {
          setNotesError(data.error ?? "Could not load notes.");
          return;
        }
        setNotes(data);
      } catch (err) {
        setNotesError(
          err instanceof Error ? err.message : "An unknown error occurred",
        );
      } finally {
        setNotesLoading(false);
      }
    }
    fetchNotes();
  }, [id, noteDate]);

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

  // Add or bump a tier's value. Saving an existing tier just updates its value.
  async function saveTier() {
    // Value is OPTIONAL — a tier can be a plain tag (e.g. makeup = Growth only,
    // no number). A blank value just creates/keeps the tier without a value.
    const value = tierValue.trim();
    setTiersSaving(true);
    setTiersError("");
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/habits/${id}/tiers/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tier: tierLevel, value }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setTiersError(data.error ?? "Could not save tier.");
        return;
      }
      setTiers(data.tiers);
      setTierValue("");
    } catch (err) {
      setTiersError(
        err instanceof Error ? err.message : "An unknown error occurred",
      );
    } finally {
      setTiersSaving(false);
    }
  }

  // Remove a tier from this habit.
  async function removeTier(level: number) {
    setTiersSaving(true);
    setTiersError("");
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/habits/${id}/tiers/${level}/delete/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setTiersError(data.error ?? "Could not remove tier.");
        return;
      }
      setTiers(data.tiers);
    } catch (err) {
      setTiersError(
        err instanceof Error ? err.message : "An unknown error occurred",
      );
    } finally {
      setTiersSaving(false);
    }
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

        {/* Tiers: the easy (Roots) and everyday (Growth) versions of this habit. */}
        {initial && (
          <section className="mt-8">
            <h2 className="text-sm font-medium text-calm-900">Tiers</h2>

            <div className="mt-3">
              {tiersError && (
                <p className="text-red-500 text-sm text-center mb-2">
                  {tiersError}
                </p>
              )}

              {tiers.length === 0 ? (
                <p className="text-center text-stone-400 text-sm">
                  No tiers yet — add an easy or everyday version below.
                </p>
              ) : (
                <ul className="space-y-2">
                  {tiers.map((tier) => (
                    <li
                      key={tier.level}
                      className="flex items-center justify-between gap-3 rounded-lg bg-stone-50 px-3 py-2 text-sm text-calm-700"
                    >
                      <span>
                        {tier.value ? `${tier.name} — ${tier.value}` : tier.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeTier(tier.level)}
                        disabled={tiersSaving}
                        className="text-xs text-red-500 hover:text-red-600 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  saveTier();
                }}
                className="mt-3 flex items-center gap-2"
              >
                <select
                  value={tierLevel}
                  onChange={(e) => setTierLevel(Number(e.target.value))}
                  className="rounded-lg border border-stone-200 bg-white px-2 py-1 text-sm text-calm-700"
                >
                  <option value={1}>Roots</option>
                  <option value={2}>Growth</option>
                </select>
                <input
                  type="text"
                  value={tierValue}
                  onChange={(e) => setTierValue(e.target.value)}
                  placeholder="value — optional (5 min, throw water)"
                  className="flex-1 rounded-lg border border-stone-200 bg-white px-2 py-1 text-sm text-calm-700"
                />
                <button
                  type="submit"
                  disabled={tiersSaving}
                  className="rounded-lg bg-calm-900 px-3 py-1 text-sm text-white hover:bg-calm-700 disabled:opacity-50"
                >
                  Save
                </button>
              </form>
            </div>
          </section>
        )}

        {/* Per-day notes for this habit. Pick a day to browse its notes. */}
        {initial && (
          <section className="mt-8">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-calm-900">Notes</h2>
              <input
                type="date"
                value={noteDate}
                onChange={(e) => setNoteDate(e.target.value)}
                className="rounded-lg border border-stone-200 bg-white px-2 py-1 text-sm text-calm-700"
              />
            </div>

            <div className="mt-3">
              {notesLoading ? (
                <p className="text-center text-calm-500 text-sm">Loading...</p>
              ) : notesError ? (
                <p className="text-red-500 text-sm text-center">{notesError}</p>
              ) : notes.length === 0 ? (
                <p className="text-center text-stone-400 text-sm">
                  No notes for this day.
                </p>
              ) : (
                <ul className="space-y-2">
                  {notes.map((note) => (
                    <li
                      key={note.id}
                      className="rounded-lg bg-stone-50 px-3 py-2 text-sm text-calm-700"
                    >
                      {note.body}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}
      </div>
    </>
  );
}

export default EditHabitPage;
