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
