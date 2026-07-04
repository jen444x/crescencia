import { useState, useMemo } from "react";
import { useToast } from "../../components/Toast";
import { toYMD } from "./dates";
import type { DayNote, Habit } from "./types";

// All Plan-page note state + mutations in one place: the day's notes, the memo
// that groups them by habit, which habit's note editor is open, and the
// create/delete/edit handlers (optimistic, with a toast on failure). The page
// passes `viewedDate` + `isViewingToday` so a note made on another day is stamped
// with that date. The page still owns the INITIAL fetch — notes load in the same
// round-trip as chains — so it populates state through the exposed setDayNotes.
export function useNotes(viewedDate: Date, isViewingToday: boolean) {
  const toast = useToast();
  const [dayNotes, setDayNotes] = useState<DayNote[]>([]);
  const [editingNote, setEditingNote] = useState<Habit | null>(null);

  // habit id -> the notes touching that habit, so a card can show its own notes.
  const notesByHabit = useMemo(() => {
    const map = new Map<number, DayNote[]>();
    for (const note of dayNotes) {
      for (const habitId of note.habits) {
        const list = map.get(habitId);
        if (list) list.push(note);
        else map.set(habitId, [note]);
      }
    }
    return map;
  }, [dayNotes]);

  // Create a new note for this habit via the new Note model. Returns true on
  // success so the sheet can clear its field. Not optimistic — the server
  // assigns the note id, so we add the note once it comes back.
  async function createNote(
    habitIds: number[],
    body: string,
  ): Promise<boolean> {
    const text = body.trim();
    if (!text || habitIds.length === 0) return false;
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/notes/create/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isViewingToday
            ? { body: text, habits: habitIds }
            : { body: text, habits: habitIds, date: toYMD(viewedDate) },
        ),
      });
      if (!res.ok) throw new Error("Request failed");
      const note: DayNote = await res.json();
      setDayNotes((prev) => [...prev, note]);
      return true;
    } catch {
      toast("Couldn't save your note", { variant: "error" });
      return false;
    }
  }

  // Delete a note for one habit. scope "one" detaches just this habit; the
  // backend deletes the note if that was its last habit (orphan rule). Today's
  // notes are single-habit, so this is a plain delete — and it stays correct
  // once notes can be shared (Step 4). Optimistic, with rollback on failure.
  async function deleteNote(
    noteId: number,
    habitId: number,
    scope: "all" | "one",
  ) {
    const snapshot = dayNotes;
    setDayNotes((prev) =>
      scope === "all"
        ? prev.filter((n) => n.id !== noteId)
        : prev.flatMap((n) => {
            if (n.id !== noteId) return [n];
            const habits = n.habits.filter((id) => id !== habitId);
            if (habits.length === 0) return [];
            return [{ ...n, habits, shared: habits.length > 1 }];
          }),
    );
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/notes/${noteId}/delete/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            scope === "all"
              ? { scope: "all" }
              : { scope: "one", habit: habitId },
          ),
        },
      );
      if (!res.ok) throw new Error("Request failed");
    } catch {
      setDayNotes(snapshot);
      toast("Couldn't delete that note", { variant: "error" });
    }
  }

  // Edit a note. scope "all" changes the text for every habit on it (200, same
  // id). scope "one" is copy-on-write: on a SHARED note the backend peels this
  // habit onto a brand-new note (201, new id) and leaves the others untouched;
  // on a single-habit note it's just a plain edit (200). We branch on the
  // status to mirror that in state. Returns true on success.
  async function editNote(
    noteId: number,
    habitId: number,
    body: string,
    scope: "all" | "one",
  ): Promise<boolean> {
    const text = body.trim();
    if (!text) return false;
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/notes/${noteId}/edit/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            scope === "one"
              ? { body: text, scope: "one", habit: habitId }
              : { body: text, scope: "all" },
          ),
        },
      );
      if (!res.ok) throw new Error("Request failed");
      const note: DayNote = await res.json();
      if (res.status === 201) {
        // Forked: this habit moved onto `note`; drop it from the original, which
        // keeps its remaining habits.
        setDayNotes((prev) => [
          ...prev.map((n) => {
            if (n.id !== noteId) return n;
            const habits = n.habits.filter((id) => id !== habitId);
            return { ...n, habits, shared: habits.length > 1 };
          }),
          note,
        ]);
      } else {
        // In-place: replace the note (same id) with the server's version.
        setDayNotes((prev) => prev.map((n) => (n.id === note.id ? note : n)));
      }
      return true;
    } catch {
      toast("Couldn't save your note", { variant: "error" });
      return false;
    }
  }

  return {
    dayNotes,
    setDayNotes,
    editingNote,
    setEditingNote,
    notesByHabit,
    createNote,
    deleteNote,
    editNote,
  };
}
