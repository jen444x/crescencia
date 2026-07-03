import { useState, useEffect, type ReactNode } from "react";
import Header from "../components/layout/Header";
import { CARD } from "../components/ui";
import { useToast } from "../components/Toast";
import ConfirmDialog from "../components/ConfirmDialog";

// A daily journal entry (GET /days/journal/). Free-text about the DAY overall,
// not tied to any habit — distinct from the per-habit Note model on the Plan
// page. Multiple entries per day form a timeline, read oldest -> newest.
type JournalEntry = {
  id: number;
  body: string;
  date: string;
  created_at: string;
  updated_at: string;
};

// --- Day navigation -----------------------------------------------------------
// These mirror the small date helpers in PlanPage. Kept local so the Journal
// page is self-contained; if a third page ever needs them we can lift them into
// a shared module.

// Local midnight — the canonical value we compare/store a viewed day by.
function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Local "YYYY-MM-DD" for the API. NOT toISOString() — that's UTC and can land
// on the wrong calendar day near midnight.
function toYMD(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
  const result = startOfDay(date);
  result.setDate(result.getDate() + days);
  return result;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// "Today" / "Yesterday" / "Tomorrow", else e.g. "Sat, Jun 13".
function dayLabel(date: Date): string {
  const diff = Math.round(
    (startOfDay(date).getTime() - startOfDay(new Date()).getTime()) / 86_400_000,
  );
  if (diff === 0) return "Today";
  if (diff === -1) return "Yesterday";
  if (diff === 1) return "Tomorrow";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// "2026-06-20T07:12:00Z" -> "7:12 AM" (local). Stamps each entry in the stream.
function entryTime(createdAt: string): string {
  return new Date(createdAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

// The same ◀ [day] ▶ browser the Plan page uses, so both day-views feel alike.
// "Jump to today" only appears once you've navigated away.
function DateNav({
  date,
  onPrev,
  onNext,
  onToday,
}: {
  date: Date;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}) {
  const viewingToday = isSameDay(date, new Date());
  const arrowClass =
    "flex h-9 w-9 items-center justify-center rounded-full border border-mist bg-white text-calm-600 transition-colors hover:bg-whisper";
  return (
    <div className="mb-5 flex items-center justify-between">
      <button
        type="button"
        onClick={onPrev}
        aria-label="Previous day"
        className={arrowClass}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 19l-7-7 7-7"
          />
        </svg>
      </button>

      <div className="flex flex-col items-center">
        <span className="font-heading text-2xl leading-tight text-ink">
          {dayLabel(date)}
        </span>
        {/* Today shows its date; any other day offers the way back. */}
        {viewingToday ? (
          <span className="text-[11px] font-semibold uppercase tracking-[0.13em] text-calm-600">
            {date.toLocaleDateString(undefined, {
              month: "long",
              day: "numeric",
            })}
          </span>
        ) : (
          <button
            type="button"
            onClick={onToday}
            className="text-[11px] font-semibold uppercase tracking-[0.13em] text-calm-600 transition-colors hover:text-calm-700"
          >
            Jump to today
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={onNext}
        aria-label="Next day"
        className={arrowClass}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5l7 7-7 7"
          />
        </svg>
      </button>
    </div>
  );
}

// One entry in the timeline: its time, then the body, with Edit/Delete. Editing
// is inline (textarea + Save/Cancel); deleting bubbles up to a confirm dialog at
// the page level via onRequestDelete.
function EntryCard({
  entry,
  onEdit,
  onRequestDelete,
}: {
  entry: JournalEntry;
  onEdit: (id: number, body: string) => Promise<boolean>;
  onRequestDelete: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(entry.body);
  const [editSaving, setEditSaving] = useState(false);

  async function save() {
    if (editSaving) return;
    setEditSaving(true);
    const ok = await onEdit(entry.id, editText);
    setEditSaving(false);
    if (ok) setEditing(false); // on failure, stay open so the text isn't lost
  }

  if (editing) {
    return (
      <div className={`p-4 ${CARD}`}>
        <textarea
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          rows={3}
          autoFocus
          className="w-full resize-none rounded-xl border border-mist bg-whisper px-3 py-2 text-sm text-stone-700 focus:border-calm-400 focus:outline-none"
        />
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setEditText(entry.body);
              setEditing(false);
            }}
            className="rounded-full border border-mist px-4 py-1.5 text-sm font-medium text-calm-700 transition-colors hover:bg-whisper"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!editText.trim() || editSaving}
            className="rounded-full bg-calm-600 px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-calm-700 disabled:opacity-50"
          >
            {editSaving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`p-4 ${CARD}`}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-calm-600">
          {entryTime(entry.created_at)}
          {entry.updated_at !== entry.created_at && (
            <span className="font-normal normal-case tracking-normal text-stone-400">
              {" "}
              &middot; edited
            </span>
          )}
        </span>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => {
              setEditText(entry.body);
              setEditing(true);
            }}
            className="text-[11px] font-semibold uppercase tracking-[0.1em] text-stone-400 transition-colors hover:text-calm-700"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => onRequestDelete(entry.id)}
            className="text-[11px] font-semibold uppercase tracking-[0.1em] text-stone-400 transition-colors hover:text-rose-500"
          >
            Delete
          </button>
        </div>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-stone-700">
        {entry.body}
      </p>
    </div>
  );
}

function JournalPage() {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // The day being viewed (default: today). ◀/▶ move it; we re-fetch on change.
  const [viewedDate, setViewedDate] = useState(() => startOfDay(new Date()));
  const isViewingToday = isSameDay(viewedDate, new Date());

  const toast = useToast();

  // The composer at the bottom of the timeline.
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  // The entry pending a delete confirmation (null = dialog closed).
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  // Load the viewed day's entries. Today omits the ?date= suffix (like /plan/).
  // `cancelled` guards against a stale response landing after the day changed.
  useEffect(() => {
    let cancelled = false;

    async function loadJournal() {
      setIsLoading(true);
      setError("");

      const today = isSameDay(viewedDate, new Date());
      const suffix = today ? "" : `?date=${toYMD(viewedDate)}`;
      const url = `${import.meta.env.VITE_API_URL}/days/journal/${suffix}`;

      try {
        const res = await fetch(url, { method: "GET", headers: {} });
        if (!res.ok) throw new Error("Couldn't load your journal.");
        const data: JournalEntry[] = await res.json();
        if (!cancelled) setEntries(data);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadJournal();
    return () => {
      cancelled = true;
    };
  }, [viewedDate]);

  // Add a new entry. The server assigns id + created_at, so we await it and then
  // append (rather than guessing an optimistic shape). Today omits ?date; other
  // days backfill onto the viewed day.
  async function createEntry() {
    const body = text.trim();
    if (!body || saving) return;
    setSaving(true);
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/journal/create/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isViewingToday ? { body } : { body, date: toYMD(viewedDate) },
          ),
        },
      );
      if (!res.ok) throw new Error();
      const created: JournalEntry = await res.json();
      setEntries((prev) => [...prev, created]);
      setText("");
    } catch {
      toast("Couldn't save your entry.", { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  // Edit an entry's text. The server returns the updated entry; we swap it in.
  // Returns whether it saved, so the card knows whether to leave edit mode.
  async function editEntry(id: number, newBody: string): Promise<boolean> {
    const body = newBody.trim();
    if (!body) return false;
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/journal/${id}/edit/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        },
      );
      if (!res.ok) throw new Error();
      const updated: JournalEntry = await res.json();
      setEntries((prev) => prev.map((e) => (e.id === id ? updated : e)));
      return true;
    } catch {
      toast("Couldn't save your changes.", { variant: "error" });
      return false;
    }
  }

  // Delete an entry. Optimistic — drop it from the list now, and put it back if
  // the request fails (snapshot rollback).
  async function deleteEntry(id: number) {
    const snapshot = entries;
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/journal/${id}/delete/`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error();
    } catch {
      setEntries(snapshot);
      toast("Couldn't delete that entry.", { variant: "error" });
    }
  }

  let body: ReactNode;
  if (isLoading && entries.length === 0) {
    body = (
      <div className="flex items-center justify-center py-12">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-calm-300 border-t-calm-600"></div>
        <span className="ml-3 text-sm text-stone-400">Loading journal...</span>
      </div>
    );
  } else if (error) {
    body = (
      <div className="rounded-xl bg-red-50 p-4 text-center">
        <p className="text-sm text-red-500">{error}</p>
      </div>
    );
  } else if (entries.length === 0) {
    body = (
      <div className={`p-10 text-center ${CARD}`}>
        <h3 className="mb-2 font-heading text-xl text-ink">Nothing written</h3>
        <p className="text-sm text-stone-400">
          How was this day? Jot down a thought.
        </p>
      </div>
    );
  } else {
    body = (
      <div
        className={`space-y-3 ${isLoading ? "opacity-60 transition-opacity" : ""}`}
      >
        {entries.map((entry) => (
          <EntryCard
            key={entry.id}
            entry={entry}
            onEdit={editEntry}
            onRequestDelete={setConfirmDeleteId}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md">
      <Header
        title="Journal"
        eyebrow={viewedDate.toLocaleDateString(undefined, { weekday: "long" })}
      />
      <DateNav
        date={viewedDate}
        onPrev={() => setViewedDate((d) => addDays(d, -1))}
        onNext={() => setViewedDate((d) => addDays(d, 1))}
        onToday={() => setViewedDate(startOfDay(new Date()))}
      />
      {body}

      {/* Composer — new entries append to the bottom of the timeline (newest
          last). Cmd/Ctrl+Enter saves; plain Enter makes a new line. */}
      <div className={`mt-4 p-4 ${CARD}`}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              createEntry();
            }
          }}
          rows={3}
          placeholder={
            isViewingToday
              ? "How was today?"
              : `Add a thought for ${dayLabel(viewedDate)}...`
          }
          className="w-full resize-none rounded-xl border border-mist bg-whisper px-3 py-2 text-sm text-stone-700 placeholder:text-stone-400 focus:border-calm-400 focus:outline-none"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={createEntry}
            disabled={!text.trim() || saving}
            className="rounded-full bg-calm-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-calm-700 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Add entry"}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Delete entry?"
        message="This journal entry will be removed for good."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (confirmDeleteId !== null) deleteEntry(confirmDeleteId);
          setConfirmDeleteId(null);
        }}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  );
}

export default JournalPage;
