import type { Habit, DayNote } from "../types";
import { SharedNoteIcon } from "../../../components/icons";
import { useState, useRef, useEffect } from "react";
// A bottom-sheet editor for a habit's per-day note. Seeded from the habit's
// current note; Save writes it, Clear empties it, and backdrop / Escape / Cancel
// close without saving. The note is per-DAY (this date's HabitLog), separate
// from the habit's permanent notes on the edit page.
export function NoteSheet({
  habit,
  allHabits,
  notes,
  dateLabel,
  onCreate,
  onEdit,
  onDelete,
  onClose,
}: {
  habit: Habit;
  // Every habit on the day, for the composer's "also add to" picker.
  allHabits: { id: number; name: string }[];
  // LIVE notes for this habit (from notesByHabit) — re-read each render so the
  // list stays current as notes are added/removed while the sheet is open.
  notes: DayNote[];
  dateLabel: string;
  onCreate: (body: string, habitIds: number[]) => Promise<boolean>;
  onEdit: (
    noteId: number,
    body: string,
    scope: "all" | "one",
  ) => Promise<boolean>;
  onDelete: (noteId: number, scope: "all" | "one") => void;
  onClose: () => void;
}) {
  // The sheet is an "add a note" composer plus the day's note list. The composer
  // always starts empty; editing happens inline on a note via `editingId`.
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  // Which note is being edited inline (null = none), its draft text, and whether
  // that edit is mid-save.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  // Extra habits a NEW note should also attach to (this habit is always
  // included). Cleared after a successful add.
  const [alsoHabitIds, setAlsoHabitIds] = useState<number[]>([]);
  // The "also add to" picker starts collapsed — a wall of every habit crowded
  // the sheet; now it opens on demand into a scrollable checklist.
  const [shareOpen, setShareOpen] = useState(false);
  // Which note is awaiting a "this one vs. all" delete choice (shared notes
  // only); null = none.
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Habits other than this one — the toggle choices in the "also add to" picker.
  const otherHabits = allHabits.filter((h) => h.id !== habit.id);

  // Keep the sheet sitting *above* the on-screen keyboard. Mobile browsers shrink
  // the visual viewport when the keyboard opens but leave `fixed` elements pinned
  // to the taller layout viewport, which buries a bottom sheet behind the
  // keyboard. We mirror the visual viewport's height/offset onto the overlay so
  // the note field stays in view — no manual scrolling.
  const [viewport, setViewport] = useState(() => {
    const vv = window.visualViewport;
    return vv ? { height: vv.height, offsetTop: vv.offsetTop } : null;
  });
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () =>
      setViewport({ height: vv.height, offsetTop: vv.offsetTop });
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  // Focus the field on open and close on Escape.
  useEffect(() => {
    taRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Add the composed note. Keep the sheet open and the field focused so several
  // notes can be jotted in a row; only clear the field once the save succeeds.
  async function add() {
    const body = text.trim();
    if (!body || saving) return;
    setSaving(true);
    const ok = await onCreate(body, [habit.id, ...alsoHabitIds]);
    setSaving(false);
    if (ok) {
      setText("");
      setAlsoHabitIds([]);
      taRef.current?.focus();
    }
  }

  // Save an inline edit; close the editor only if the save sticks. scope "all"
  // changes a shared note for every habit; "one" makes/keeps a copy for just
  // this habit (copy-on-write on the backend).
  async function saveEdit(noteId: number, scope: "all" | "one") {
    const body = editText.trim();
    if (!body || editSaving) return;
    setEditSaving(true);
    const ok = await onEdit(noteId, body, scope);
    setEditSaving(false);
    if (ok) setEditingId(null);
  }

  // Non-shared notes delete immediately; shared notes first ask "this one vs.
  // all" via the confirm row.
  function requestDelete(n: DayNote) {
    if (n.shared) setConfirmDeleteId(n.id);
    else onDelete(n.id, "one");
  }

  return (
    <div
      className="fixed inset-x-0 z-50 flex items-end justify-center sm:items-center"
      style={{
        top: viewport?.offsetTop ?? 0,
        height: viewport?.height ?? "100dvh",
      }}
    >
      <div
        className="animate-backdrop-in absolute inset-0 bg-ink/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Notes for ${habit.name}`}
        className="animate-sheet-in relative max-h-full w-full max-w-md overflow-y-auto rounded-t-3xl border border-mist bg-white p-6 pb-8 shadow-[0_18px_44px_rgba(27,46,42,0.18)] sm:rounded-3xl"
      >
        {/* Grabber — a small affordance that this sheet came up from the bottom. */}
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-mist sm:hidden" />
        <h2 className="font-heading text-2xl text-calm-900">{habit.name}</h2>
        <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-calm-500">
          Notes · {dateLabel}
        </p>

        {/* The day's existing notes. A shared note (on more than one habit) is
            marked; editing or deleting one asks whether to change it for just
            this habit or for all of them. */}
        {notes.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {notes.map((n) => {
              const others = n.habits.length - 1;
              // Inline editor. On a shared note, the two save buttons map to the
              // "this one vs. all" scope; otherwise a single plain Save.
              if (editingId === n.id) {
                return (
                  <li
                    key={n.id}
                    className="rounded-xl border border-mist bg-white p-3"
                  >
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={3}
                      autoFocus
                      className="w-full resize-none rounded-lg border border-mist bg-whisper px-3 py-2 text-sm text-calm-900 focus:border-calm-500 focus:outline-none"
                    />
                    {n.shared && (
                      <p className="mt-2 text-[11px] text-calm-500">
                        Shared with {others} other habit
                        {others === 1 ? "" : "s"} — save for…
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="rounded-full px-3 py-1.5 text-xs font-semibold text-calm-600 transition-colors hover:bg-whisper"
                      >
                        Cancel
                      </button>
                      {n.shared ? (
                        <>
                          <button
                            type="button"
                            onClick={() => saveEdit(n.id, "one")}
                            disabled={editText.trim() === "" || editSaving}
                            className="rounded-full border border-mist px-4 py-1.5 text-xs font-semibold text-calm-700 transition-colors hover:bg-whisper disabled:opacity-50"
                          >
                            Just this habit
                          </button>
                          <button
                            type="button"
                            onClick={() => saveEdit(n.id, "all")}
                            disabled={editText.trim() === "" || editSaving}
                            className="rounded-full bg-calm-600 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-calm-700 disabled:opacity-50"
                          >
                            All {n.habits.length} habits
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => saveEdit(n.id, "one")}
                          disabled={editText.trim() === "" || editSaving}
                          className="rounded-full bg-calm-600 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-calm-700 disabled:opacity-50"
                        >
                          Save
                        </button>
                      )}
                    </div>
                  </li>
                );
              }

              // "This one vs. all" choice before deleting a SHARED note.
              if (confirmDeleteId === n.id) {
                return (
                  <li
                    key={n.id}
                    className="rounded-xl border border-rose-200 bg-rose-50 p-3"
                  >
                    <p className="text-xs text-calm-700">
                      On {n.habits.length} habits — remove this note…
                    </p>
                    <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded-full px-3 py-1.5 text-xs font-semibold text-calm-600 transition-colors hover:bg-whisper"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onDelete(n.id, "one");
                          setConfirmDeleteId(null);
                        }}
                        className="rounded-full border border-mist px-4 py-1.5 text-xs font-semibold text-calm-700 transition-colors hover:bg-whisper"
                      >
                        Just this habit
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onDelete(n.id, "all");
                          setConfirmDeleteId(null);
                        }}
                        className="rounded-full bg-rose-500 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-rose-600"
                      >
                        All {n.habits.length} habits
                      </button>
                    </div>
                  </li>
                );
              }

              // Default display row.
              return (
                <li
                  key={n.id}
                  className="flex items-start gap-2 rounded-xl border border-mist bg-whisper px-3 py-2"
                >
                  {n.shared && (
                    <span
                      className="mt-0.5 text-calm-400"
                      title={`Shared across ${n.habits.length} habits`}
                    >
                      <SharedNoteIcon />
                    </span>
                  )}
                  <p className="min-w-0 flex-1 whitespace-pre-wrap wrap-break-word text-sm text-calm-800">
                    {n.body}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(n.id);
                      setEditText(n.body);
                    }}
                    className="shrink-0 text-xs font-medium text-calm-500 transition-colors hover:text-calm-700"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => requestDelete(n)}
                    className="shrink-0 text-xs font-medium text-rose-500 transition-colors hover:text-rose-600"
                  >
                    Delete
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-calm-400">
            No notes yet for this day.
          </p>
        )}

        <label className="mt-5 block text-[11px] font-medium uppercase tracking-wide text-calm-500">
          Add a note
        </label>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="How did it go? Why you skipped, how it felt…"
          className="mt-1.5 w-full resize-none rounded-xl border border-mist bg-whisper px-4 py-3 text-sm text-calm-900 placeholder:text-calm-400 focus:border-calm-500 focus:outline-none"
        />

        {/* Optionally attach the new note to other habits too (write a reflection
            once, share it across everything it's about). This habit is always
            included; these are the extras. */}
        {otherHabits.length > 0 && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setShareOpen((o) => !o)}
              aria-expanded={shareOpen}
              className="flex w-full items-center justify-between rounded-xl border border-mist bg-white px-3 py-2.5 text-xs font-semibold text-calm-700 transition-colors hover:bg-whisper"
            >
              <span>
                Also add to other habits
                {alsoHabitIds.length > 0 ? ` · ${alsoHabitIds.length}` : ""}
              </span>
              <svg
                className={`h-4 w-4 text-calm-400 transition-transform ${shareOpen ? "rotate-180" : ""}`}
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
            {shareOpen && (
              <div className="mt-1.5 max-h-44 overflow-y-auto rounded-xl border border-mist bg-whisper p-1.5">
                {otherHabits.map((h) => {
                  const on = alsoHabitIds.includes(h.id);
                  return (
                    <button
                      key={h.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setAlsoHabitIds((prev) =>
                          on
                            ? prev.filter((id) => id !== h.id)
                            : [...prev, h.id],
                        )
                      }
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-ink transition-colors hover:bg-white"
                    >
                      <span
                        className={`flex h-4.25 w-4.25 shrink-0 items-center justify-center rounded-[5px] border ${
                          on
                            ? "border-calm-600 bg-calm-600 text-white"
                            : "border-mist bg-white text-transparent"
                        }`}
                      >
                        <svg
                          className="h-3 w-3"
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
                      </span>
                      <span className="min-w-0 flex-1 truncate">{h.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-4 py-2.5 text-sm font-medium text-calm-600 transition-colors hover:bg-calm-50"
          >
            Done
          </button>
          <button
            type="button"
            onClick={add}
            disabled={text.trim() === "" || saving}
            className="rounded-xl bg-calm-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-calm-700 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
