import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import Header from "../components/layout/Header";
import HabitForm, { type HabitValues } from "../components/HabitForm";
import ConfirmDialog from "../components/ConfirmDialog";

// The bottom sheet offering the two ways to remove a habit, modeled on Google
// Calendar's recurring-event delete. "Stop going forward" retires it from today
// (keeps ALL history, reversible); "Delete forever" wipes it and its history
// (the caller gates this one behind an extra ConfirmDialog).
function DeleteHabitSheet({
  name,
  open,
  busy,
  onStop,
  onForever,
  onClose,
}: {
  name: string;
  open: boolean;
  busy: boolean;
  onStop: () => void;
  onForever: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div
        className="animate-backdrop-in absolute inset-0 bg-calm-900/40"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Remove ${name}`}
        className="animate-sheet-in relative w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl"
      >
        <p className="px-2 pt-1 text-sm font-medium text-calm-900">
          Remove &ldquo;{name}&rdquo;
        </p>
        <p className="px-2 pb-3 text-xs text-stone-400">
          This removes the whole habit, including every tier/version of it. (To
          drop just one tier, use Remove in the Tiers section instead.)
        </p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onStop}
            className="rounded-xl border border-calm-200 px-4 py-3 text-left transition-colors hover:bg-calm-50 disabled:opacity-50"
          >
            <span className="block text-sm font-medium text-calm-900">
              Stop going forward
            </span>
            <span className="mt-0.5 block text-xs text-stone-400">
              Hides the whole habit (every tier) from today on and stops counting
              it. Keeps all your past history &mdash; you can resume it later.
            </span>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onForever}
            className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-left transition-colors hover:bg-rose-100 disabled:opacity-50"
          >
            <span className="block text-sm font-medium text-rose-600">
              Delete forever
            </span>
            <span className="mt-0.5 block text-xs text-rose-400">
              Permanently deletes the habit, every tier/version of it, and its
              whole history. Can&rsquo;t be undone.
            </span>
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-2 w-full rounded-xl py-3 text-sm font-medium text-stone-400 transition-colors hover:text-stone-600"
        >
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
}

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

  // Delete / stop / resume state. `endedOn` is the habit's retirement date (null
  // = active); when set, the page shows "stopped" + Resume instead of Delete.
  // `deleteOpen` is the two-choice sheet; `confirmForever` gates the irreversible
  // purge behind a second confirm.
  const [endedOn, setEndedOn] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmForever, setConfirmForever] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

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
        setEndedOn(data.ended_on ?? null);
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

  // Remove the habit. mode "stop" retires it from today (keeps history); mode
  // "forever" wipes it and its history. Both leave the page on success.
  async function deleteHabit(mode: "stop" | "forever") {
    setDeleteBusy(true);
    setDeleteError("");
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/habits/${id}/delete/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not remove habit.");
      navigate(-1);
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "An unknown error occurred",
      );
    } finally {
      setDeleteBusy(false);
    }
  }

  // Un-retire a stopped habit: clear its end date so it's back on the plan.
  async function resumeHabit() {
    setDeleteBusy(true);
    setDeleteError("");
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/habits/${id}/resume/`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not resume habit.");
      setEndedOn(null);
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "An unknown error occurred",
      );
    } finally {
      setDeleteBusy(false);
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

        {/* Remove the habit: stop it going forward (keeps history) or delete it
            forever. When it's already stopped, this becomes a Resume control. */}
        {initial && (
          <section className="mt-10 border-t border-stone-100 pt-6">
            {deleteError && (
              <p className="mb-3 text-center text-sm text-red-500">
                {deleteError}
              </p>
            )}

            {endedOn ? (
              <div className="text-center">
                <p className="text-sm text-stone-500">
                  Stopped as of {endedOn} &mdash; it&rsquo;s off your plan and
                  isn&rsquo;t counted. Your past history is kept.
                </p>
                <button
                  type="button"
                  onClick={resumeHabit}
                  disabled={deleteBusy}
                  className="mt-3 rounded-xl bg-calm-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-calm-700 disabled:opacity-50"
                >
                  Resume habit
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setDeleteOpen(true)}
                disabled={deleteBusy}
                className="w-full rounded-xl border border-rose-200 py-3 text-sm font-medium text-rose-600 transition-colors hover:bg-rose-50 disabled:opacity-50"
              >
                Delete habit
              </button>
            )}
          </section>
        )}
      </div>

      <DeleteHabitSheet
        name={initial?.name ?? "this habit"}
        open={deleteOpen}
        busy={deleteBusy}
        onStop={() => {
          setDeleteOpen(false);
          deleteHabit("stop");
        }}
        onForever={() => {
          setDeleteOpen(false);
          setConfirmForever(true);
        }}
        onClose={() => setDeleteOpen(false)}
      />

      <ConfirmDialog
        open={confirmForever}
        title="Delete forever?"
        message={`This permanently deletes “${initial?.name ?? "this habit"}”, every tier/version of it, and all of its logs and history. This can’t be undone.`}
        confirmLabel="Delete forever"
        destructive
        onConfirm={() => {
          setConfirmForever(false);
          deleteHabit("forever");
        }}
        onCancel={() => setConfirmForever(false)}
      />
    </>
  );
}

export default EditHabitPage;
