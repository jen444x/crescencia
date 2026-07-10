import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import Header from "../components/layout/Header";
import { CARD, CARD_TITLE } from "../components/ui";
import HabitForm, {
  type HabitValues,
  type AspirationOption,
} from "../components/HabitForm";
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

// One ladder rung as returned by /habits/:id/ (tiers[], low->high).
type Tier = {
  level: number;
  name: string;
  label: number | null; // tag level 1=Roots / 2=Growth, null = untagged
  value: string;
  version: number; // the rung's id
};
// A rung while editing: `id` present = an existing Version, absent = a new one.
type EditRung = { id?: number; value: string; label: number | null };

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

  // Ladder section: this habit's rungs (low->high), edited as one list and saved
  // in a single POST. Each rung is a value + an OPTIONAL Roots/Growth tag; order
  // is the rung's position (the cascade runs low->high).
  const [rungs, setRungs] = useState<EditRung[]>([]);
  const [tiersSaving, setTiersSaving] = useState(false);
  const [tiersError, setTiersError] = useState("");

  // Options for the form's "Aspiration" dropdown (non-helper habits). The chosen
  // value lives inside HabitForm and saves with the rest of the form.
  const [allAspirations, setAllAspirations] = useState<AspirationOption[]>([]);

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
          aspiration_ids: data.aspirations ?? [],
        });
        setEndedOn(data.ended_on ?? null);
        setRungs(
          (data.tiers ?? []).map((t: Tier) => ({
            id: t.version,
            value: t.value,
            label: t.label ?? null,
          })),
        );
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

  // Load every aspiration (id + name) so the picker can offer them. Cheap and
  // habit-independent, so it runs once; a failed load just leaves it empty.
  useEffect(() => {
    async function fetchAspirations() {
      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL}/aspirations/`);
        const data = await res.json();
        if (res.ok) {
          setAllAspirations(
            (data.aspirations ?? []).map((a: AspirationOption) => ({
              id: a.id,
              name: a.name,
            })),
          );
        }
      } catch {
        // Non-fatal: the picker just shows no options.
      }
    }
    fetchAspirations();
  }, []);

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

  // --- ladder editing (local until "Save ladder") ------------------------
  function addRung() {
    setRungs((rs) => [...rs, { value: "", label: null }]);
  }
  function removeRung(i: number) {
    setRungs((rs) => rs.filter((_, j) => j !== i));
  }
  function moveRung(i: number, dir: -1 | 1) {
    setRungs((rs) => {
      const j = i + dir;
      if (j < 0 || j >= rs.length) return rs;
      const next = rs.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  function setRungValue(i: number, value: string) {
    setRungs((rs) => rs.map((r, j) => (j === i ? { ...r, value } : r)));
  }
  function setRungLabel(i: number, label: number | null) {
    // A tag (Roots/Growth) can sit on only ONE rung: setting it here clears it
    // off whatever had it, mirroring the DB rule.
    setRungs((rs) =>
      rs.map((r, j) =>
        j === i
          ? { ...r, label }
          : label != null && r.label === label
            ? { ...r, label: null }
            : r,
      ),
    );
  }

  // Save the whole ladder in one POST (position = level, low->high).
  async function saveLadder() {
    setTiersSaving(true);
    setTiersError("");
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/habits/${id}/versions/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rungs: rungs.map((r) => ({
              id: r.id,
              value: r.value.trim(),
              label: r.label,
            })),
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setTiersError(data.error ?? "Could not save the ladder.");
        return;
      }
      setRungs(
        (data.tiers as Tier[]).map((t) => ({
          id: t.version,
          value: t.value,
          label: t.label ?? null,
        })),
      );
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
      <Header title={initial?.name ?? "Edit habit"} eyebrow="Edit habit" />
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
            aspirationOptions={allAspirations}
          />
        )}

        {/* Ladder: this habit's rungs, easiest -> hardest. Each is a value + an
            optional Roots/Growth tag; order is the rung's position (cascade runs
            low->high). Edited locally, saved in one "Save ladder" POST. */}
        {initial && (
          <section className={`mt-4 p-4 ${CARD}`}>
            <h2 className={CARD_TITLE}>Ladder</h2>
            <p className="mt-1 text-xs text-stone-400">
              Rungs from easiest to hardest — the number on the left is just the
              position. The Roots/Growth tag is optional and sits on one rung.
              Finishing a higher rung fills in the ones below.
            </p>

            <div className="mt-3">
              {tiersError && (
                <p className="mb-2 text-center text-sm text-red-500">
                  {tiersError}
                </p>
              )}

              {rungs.length === 0 ? (
                <p className="text-center text-sm text-stone-400">
                  No rungs yet — add one below.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {rungs.map((r, i) => (
                    <li
                      key={r.id ?? `new-${i}`}
                      className="flex items-center gap-2 border-t border-whisper py-2 first:border-t-0 first:pt-0"
                    >
                      {/* position + reorder (order = the rung's level) */}
                      <div className="flex shrink-0 flex-col items-center leading-none">
                        <button
                          type="button"
                          aria-label="Move rung up"
                          disabled={i === 0 || tiersSaving}
                          onClick={() => moveRung(i, -1)}
                          className="text-xs text-stone-400 hover:text-calm-600 disabled:opacity-30"
                        >
                          ▲
                        </button>
                        <span className="my-0.5 text-[10px] font-bold text-calm-700">
                          {i + 1}
                        </span>
                        <button
                          type="button"
                          aria-label="Move rung down"
                          disabled={i === rungs.length - 1 || tiersSaving}
                          onClick={() => moveRung(i, 1)}
                          className="text-xs text-stone-400 hover:text-calm-600 disabled:opacity-30"
                        >
                          ▼
                        </button>
                      </div>
                      <input
                        type="text"
                        value={r.value}
                        onChange={(e) => setRungValue(i, e.target.value)}
                        placeholder="value (e.g. 1000 steps)"
                        className="min-w-0 flex-1 rounded-xl border border-mist bg-whisper px-2.5 py-1.5 text-sm text-ink placeholder:text-stone-400 focus:border-calm-400 focus:outline-none"
                      />
                      <select
                        value={r.label ?? 0}
                        onChange={(e) =>
                          setRungLabel(i, Number(e.target.value) || null)
                        }
                        aria-label="Tag"
                        className="shrink-0 rounded-xl border border-mist bg-whisper px-2 py-1.5 text-sm text-ink focus:border-calm-400 focus:outline-none"
                      >
                        <option value={0}>— none —</option>
                        <option value={1}>Roots</option>
                        <option value={2}>Growth</option>
                      </select>
                      <button
                        type="button"
                        aria-label="Remove rung"
                        onClick={() => removeRung(i)}
                        disabled={tiersSaving}
                        className="shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-stone-400 transition-colors hover:text-rose-500 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-3 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={addRung}
                  disabled={tiersSaving}
                  className="rounded-full border border-mist bg-whisper px-3.5 py-1.5 text-sm font-semibold text-calm-700 transition-colors hover:border-calm-400 disabled:opacity-50"
                >
                  + Add rung
                </button>
                <button
                  type="button"
                  onClick={saveLadder}
                  disabled={tiersSaving}
                  className="rounded-full bg-calm-600 px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-calm-700 disabled:opacity-50"
                >
                  {tiersSaving ? "Saving…" : "Save ladder"}
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Per-day notes for this habit. Pick a day to browse its notes. */}
        {initial && (
          <section className={`mt-4 p-4 ${CARD}`}>
            <div className="flex items-center justify-between gap-3">
              <h2 className={CARD_TITLE}>Notes</h2>
              <input
                type="date"
                value={noteDate}
                onChange={(e) => setNoteDate(e.target.value)}
                className="rounded-full border border-mist bg-whisper px-2.5 py-1 text-xs font-semibold text-calm-700 focus:border-calm-400 focus:outline-none"
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
                      className="rounded-xl bg-whisper px-3 py-2 text-sm text-ink"
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
          <section className="mt-8">
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
                  className="mt-3 rounded-full bg-calm-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-calm-700 disabled:opacity-50"
                >
                  Resume habit
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setDeleteOpen(true)}
                disabled={deleteBusy}
                className="w-full py-2 text-center text-xs font-semibold text-rose-400 transition-colors hover:text-rose-500 disabled:opacity-50"
              >
                Stop or delete this habit…
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
