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
import HabitHistory from "../components/HabitHistory";
import HabitSteps, { type StepRung } from "../components/HabitSteps";

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
  target_time: string | null; // "HH:MM" deadline, or null
  duration: number | null; // minutes, or null
  // What you DO at this rung ([] for a habit that isn't a recipe).
  steps: { id: number; step: number; name: string; amount: string }[];
};
// A rung while editing: `id` present = an existing Version, absent = a new one.
// target_time/duration are kept as input strings ("" = unset).
type EditRung = {
  id?: number;
  value: string;
  label: number | null;
  target_time: string;
  duration: string;
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
  // For the retag prompt: how many base-level "did it" completions the habit
  // has, and whether it was rung-less when the page loaded — the prompt shows
  // only when a FIRST ladder lands on real history.
  const [baseCompletions, setBaseCompletions] = useState(0);
  const [hadNoRungs, setHadNoRungs] = useState(false);
  const [retagOpen, setRetagOpen] = useState(false);
  const [retagChoice, setRetagChoice] = useState<number | null>(null);
  const [retagBusy, setRetagBusy] = useState(false);
  // The saved ladder as the server sees it (rung ids + their steps), which is
  // what the steps editor hangs off. Kept alongside `rungs` because that one is
  // a local draft of the ladder and may hold rungs that don't exist yet.
  const [tiers, setTiers] = useState<StepRung[]>([]);
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
            target_time: t.target_time ?? "",
            duration: t.duration != null ? String(t.duration) : "",
          })),
        );
        setTiers(data.tiers ?? []);
        setBaseCompletions(data.base_completions ?? 0);
        setHadNoRungs((data.tiers ?? []).length === 0);
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
    // The habit card's Save is ONE action: fields + version rows together.
    const ladderOk = await saveLadder();
    if (!ladderOk) throw new Error("Could not save the versions.");
    // A FIRST ladder landing on real base-level history: ask which rung those
    // old completions were, instead of guessing. Otherwise, leave the page.
    if (hadNoRungs && rungs.length > 0 && baseCompletions > 0) {
      setRetagOpen(true);
      return;
    }
    // Back to wherever they opened this from (usually the Plan page).
    navigate(-1);
  }

  // Answer the "which rung were they?" prompt: retag old base completions onto
  // the chosen rung (null = keep as plain "did it"), then leave the page.
  async function submitRetag() {
    setRetagBusy(true);
    try {
      await fetch(`${import.meta.env.VITE_API_URL}/habits/${id}/history/retag/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: retagChoice }),
      });
    } catch {
      // Retag is best-effort; the ladder itself is already saved.
    } finally {
      setRetagBusy(false);
      setRetagOpen(false);
      navigate(-1);
    }
  }

  // --- ladder editing (local until "Save ladder") ------------------------
  function addRung() {
    setRungs((rs) => [
      ...rs,
      { value: "", label: null, target_time: "", duration: "" },
    ]);
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
  function setRungTime(i: number, target_time: string) {
    setRungs((rs) => rs.map((r, j) => (j === i ? { ...r, target_time } : r)));
  }
  function setRungDuration(i: number, duration: string) {
    setRungs((rs) => rs.map((r, j) => (j === i ? { ...r, duration } : r)));
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

  // Save the whole ladder in one POST (position = level, low->high). Returns
  // whether it stuck — the form's single Save calls this alongside the field
  // save, and the retag prompt only makes sense after a successful write.
  async function saveLadder(): Promise<boolean> {
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
              target_time: r.target_time || null,
              duration: r.duration ? Number(r.duration) : null,
            })),
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setTiersError(data.error ?? "Could not save the ladder.");
        return false;
      }
      setRungs(
        (data.tiers as Tier[]).map((t) => ({
          id: t.version,
          value: t.value,
          label: t.label ?? null,
          target_time: t.target_time ?? "",
          duration: t.duration != null ? String(t.duration) : "",
        })),
      );
      // Rungs may have been added/removed/renumbered, so the steps editor needs
      // the fresh list (a deleted rung takes its steps with it).
      setTiers(data.tiers as StepRung[]);
      return true;
    } catch (err) {
      setTiersError(
        err instanceof Error ? err.message : "An unknown error occurred",
      );
      return false;
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

  // The version rows, rendered INSIDE the habit card (name + versions are one
  // thing — her call). Saved by the form's single Save button via saveLadder.
  const ladderEditor = (
    <div>
      <p className="text-xs text-stone-400">
        Versions from easiest to hardest — each can carry a complete-by time and a
        length. Finishing a higher one fills in the ones below.
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
              className="flex flex-wrap items-center gap-2 border-t border-whisper py-2 first:border-t-0 first:pt-0"
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
              <select
                value={r.label ?? 0}
                onChange={(e) =>
                  setRungLabel(i, Number(e.target.value) || null)
                }
                aria-label="Tag"
                className="min-w-0 flex-1 rounded-xl border border-mist bg-whisper px-2 py-1.5 text-sm text-ink focus:border-calm-400 focus:outline-none"
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
              {/* The rung's typed meaning: a "by" deadline (slot
                  completion acts on it) and a length in minutes. */}
              <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1.5 pl-7 pt-1.5">
                <label className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-calm-600">
                  Complete by
                  <input
                    type="time"
                    value={r.target_time}
                    onChange={(e) => setRungTime(i, e.target.value)}
                    className="rounded-lg border border-mist bg-whisper px-2 py-1 text-[13px] text-ink focus:border-calm-400 focus:outline-none"
                  />
                </label>
                <label className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-calm-600">
                  Duration
                  <input
                    type="number"
                    min={1}
                    value={r.duration}
                    onChange={(e) => setRungDuration(i, e.target.value)}
                    placeholder="—"
                    className="w-16 rounded-lg border border-mist bg-whisper px-2 py-1 text-right text-[13px] text-ink placeholder:text-stone-400 focus:border-calm-400 focus:outline-none"
                  />
                  <span className="text-[11px] text-stone-300">min</span>
                </label>
                {/* The free-text value ("1000 steps", "Cleanse face") — kept
                    for rungs that aren't about time, and so old ones stay
                    visible and editable. Sits under the typed fields now that
                    those carry the main meaning. */}
                <label className="flex w-full items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-calm-600">
                  Value
                  <input
                    type="text"
                    value={r.value}
                    onChange={(e) => setRungValue(i, e.target.value)}
                    placeholder="e.g. 1000 steps"
                    className="min-w-0 flex-1 rounded-lg border border-mist bg-whisper px-2.5 py-1.5 text-[13px] font-normal normal-case tracking-normal text-ink placeholder:text-stone-400 focus:border-calm-400 focus:outline-none"
                  />
                </label>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3">
        <button
          type="button"
          onClick={addRung}
          disabled={tiersSaving}
          className="rounded-full border border-mist bg-whisper px-3.5 py-1.5 text-sm font-semibold text-calm-700 transition-colors hover:border-calm-400 disabled:opacity-50"
        >
          + Add rung
        </button>
      </div>
    </div>
    </div>
  );

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
            ladder={ladderEditor}
          />
        )}

        {/* This habit's month-by-month record — which days she completed,
            skipped, missed, hasn't reached yet, or the habit wasn't active for. */}
        {initial && id && <HabitHistory habitId={Number(id)} />}

        {/* What you DO inside this habit, per rung — "cat cow, 3 mins". Sits
            under the Ladder because a step's amount belongs to a rung. */}
        {initial && id && (
          <HabitSteps
            habitId={Number(id)}
            rungs={tiers}
            onSaved={(t) => setTiers(t as StepRung[])}
          />
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

      {/* "Your past completions — which rung were they?" Shown once, when a
          first ladder is saved onto base-level history. Portaled like the
          other sheets so nothing clips it. */}
      {retagOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-6"
            role="dialog"
            aria-modal="true"
            aria-label="Assign past completions"
          >
            <div className="w-full max-w-sm rounded-[18px] border border-mist bg-white p-5 shadow-[0_12px_32px_rgba(27,46,42,0.16)]">
              <h2 className="font-heading text-lg text-ink">
                Your {baseCompletions} past{" "}
                {baseCompletions === 1 ? "completion" : "completions"}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-stone-400">
                This habit was one thing before it had versions. Which version
                were those days? They'll be recorded as that amount — or leave
                them as "did it" if you're not sure.
              </p>
              <div className="mt-3 space-y-2">
                {rungs
                  .filter((r) => r.id != null)
                  .map((r, i) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setRetagChoice(r.id ?? null)}
                      aria-pressed={retagChoice === r.id}
                      className={`flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors ${
                        retagChoice === r.id
                          ? "border-calm-600 bg-mint text-calm-700"
                          : "border-mist text-ink hover:bg-whisper"
                      }`}
                    >
                      <span
                        className={`h-4 w-4 shrink-0 rounded-full border-2 ${
                          retagChoice === r.id
                            ? "border-calm-600 bg-calm-600 shadow-[inset_0_0_0_3px_#fff]"
                            : "border-calm-300"
                        }`}
                      />
                      {r.value ||
                        (r.target_time ? `by ${r.target_time}` : `Version ${i + 1}`)}
                    </button>
                  ))}
                <button
                  type="button"
                  onClick={() => setRetagChoice(null)}
                  aria-pressed={retagChoice === null}
                  className={`flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors ${
                    retagChoice === null
                      ? "border-calm-600 bg-mint text-calm-700"
                      : "border-mist text-ink hover:bg-whisper"
                  }`}
                >
                  <span
                    className={`h-4 w-4 shrink-0 rounded-full border-2 ${
                      retagChoice === null
                        ? "border-calm-600 bg-calm-600 shadow-[inset_0_0_0_3px_#fff]"
                        : "border-calm-300"
                    }`}
                  />
                  Keep as "did it"
                  <span className="ml-auto text-[11px] text-stone-400">
                    not sure
                  </span>
                </button>
              </div>
              <button
                type="button"
                onClick={submitRetag}
                disabled={retagBusy}
                className="mt-4 w-full rounded-full bg-calm-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-calm-700 disabled:opacity-60"
              >
                {retagBusy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export default EditHabitPage;
