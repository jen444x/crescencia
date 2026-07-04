import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Header from "../components/layout/Header";
import ConfirmDialog from "../components/ConfirmDialog";

// One scheduled habit-slot from the recurring read. `schedule` is the Schedule
// row id — what the routine-membership endpoints add/remove. A habit can have
// more than one slot (e.g. tiers), each its own row, so `tier_name` disambiguates.
type Slot = {
  schedule: number;
  habit: number;
  name: string;
  tier_name: string | null;
  routine: number | null;
};

function slotLabel(s: Slot): string {
  return s.tier_name ? `${s.name} · ${s.tier_name}` : s.name;
}

function RoutinePage() {
  const { id } = useParams();
  const routineId = Number(id);
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  // Inline rename + delete-confirm state.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Load the routine's name (from the list) and the current schedule slots (which
  // carry each habit's routine membership). One read of each drives the editor.
  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [rRes, sRes] = await Promise.all([
        fetch(`${import.meta.env.VITE_API_URL}/routines/`),
        fetch(`${import.meta.env.VITE_API_URL}/schedules/recurring/`),
      ]);
      const rData = await rRes.json();
      const sData = await sRes.json();
      if (!rRes.ok || !sRes.ok) {
        setError(rData.error ?? sData.error ?? "Could not load this routine.");
        return;
      }
      const found = (rData as { id: number; name: string }[]).find(
        (r) => r.id === routineId,
      );
      if (!found) {
        setError("This routine no longer exists.");
        return;
      }
      setName(found.name);
      const flat: Slot[] = (sData.blocks as { habits: Slot[] }[]).flatMap(
        (b) => b.habits,
      );
      setSlots(flat);
      setError("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "An unknown error occurred",
      );
    } finally {
      setIsLoading(false);
    }
  }, [routineId]);

  useEffect(() => {
    // Fetch on mount / when routineId changes — a legitimate effect (syncing
    // with the server). The rule can't see load()'s async boundary, so the
    // setState it flags actually happens after an await, not synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Add/remove a schedule row from this routine, then re-read so membership is
  // the server's truth (never optimistic — keeps the two lists consistent).
  async function setMember(scheduleId: number, action: "add" | "remove") {
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/routines/${routineId}/members/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [action]: [scheduleId] }),
        },
      );
      if (!res.ok) throw new Error("save failed");
      await load();
    } catch {
      setError("Couldn't update that habit.");
      await load();
    }
  }

  async function saveName() {
    const next = nameDraft.trim();
    if (!next) return;
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/routines/${routineId}/edit/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: next }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't rename that routine.");
        return;
      }
      setName(data.name ?? next);
      setEditingName(false);
    } catch {
      setError("Couldn't rename that routine.");
    }
  }

  async function deleteRoutine() {
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/routines/${routineId}/delete/`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      if (!res.ok) throw new Error("delete failed");
      navigate("/routines");
    } catch {
      setError("Couldn't delete that routine.");
      setConfirmDelete(false);
    }
  }

  const members = slots.filter((s) => s.routine === routineId);
  // Only habits not already in a routine can be added (membership is a single
  // FK, so a slot belongs to at most one routine).
  const available = slots.filter((s) => s.routine === null);

  return (
    <>
      <Header title="Routine" body="" />
      <div className="max-w-md mx-auto">
        <button
          onClick={() => navigate("/routines")}
          className="mb-4 text-sm font-medium text-calm-600 hover:text-calm-700"
        >
          ‹ All routines
        </button>

        {isLoading && (
          <p className="text-center text-calm-500 text-sm">Loading...</p>
        )}
        {error && (
          <p className="mb-3 text-red-500 text-sm text-center">{error}</p>
        )}

        {!isLoading && !error && (
          <>
            {/* Name + rename/delete controls. */}
            <div className="mb-5 rounded-xl bg-white p-4 shadow-sm">
              {editingName ? (
                <div>
                  <input
                    autoFocus
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveName();
                      if (e.key === "Escape") setEditingName(false);
                    }}
                    className="w-full rounded-lg border border-calm-200 px-3 py-2 text-sm text-calm-900 focus:border-calm-400 focus:outline-none"
                  />
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => setEditingName(false)}
                      className="flex-1 rounded-lg border border-calm-200 py-2 text-sm font-medium text-calm-700 transition-colors hover:bg-calm-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={saveName}
                      disabled={!nameDraft.trim()}
                      className="flex-1 rounded-lg bg-calm-600 py-2 text-sm font-medium text-white transition-colors hover:bg-calm-700 disabled:opacity-40"
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <h2 className="flex-1 font-heading text-xl text-calm-900">
                    {name}
                  </h2>
                  <button
                    onClick={() => {
                      setNameDraft(name);
                      setEditingName(true);
                    }}
                    className="text-xs font-medium text-calm-600 hover:text-calm-700"
                  >
                    Rename
                  </button>
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="text-xs font-medium text-rose-500 hover:text-rose-600"
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>

            {/* Current members. */}
            <h3 className="mb-2 text-sm font-medium text-calm-600">
              Habits in this routine
            </h3>
            {members.length === 0 ? (
              <p className="mb-6 text-sm text-stone-400">
                No habits yet — add some below.
              </p>
            ) : (
              <ul className="mb-6 space-y-1.5">
                {members.map((s) => (
                  <li
                    key={s.schedule}
                    className="flex items-center gap-3 rounded-xl bg-white px-3 py-2.5 shadow-sm"
                  >
                    <span className="min-w-0 flex-1 break-words text-sm text-calm-900">
                      {slotLabel(s)}
                    </span>
                    <button
                      onClick={() => setMember(s.schedule, "remove")}
                      className="shrink-0 rounded-full border border-calm-200 px-3 py-1 text-xs font-medium text-calm-600 transition-colors hover:bg-calm-50"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* Add habits — every scheduled habit not already in a routine. */}
            <h3 className="mb-2 text-sm font-medium text-calm-600">
              Add a habit
            </h3>
            {available.length === 0 ? (
              <p className="text-sm text-stone-400">
                Every scheduled habit is already in a routine. (Only habits on
                your schedule can be added.)
              </p>
            ) : (
              <ul className="space-y-1.5">
                {available.map((s) => (
                  <li
                    key={s.schedule}
                    className="flex items-center gap-3 rounded-xl bg-white px-3 py-2.5 shadow-sm"
                  >
                    <span className="min-w-0 flex-1 break-words text-sm text-calm-900">
                      {slotLabel(s)}
                    </span>
                    <button
                      onClick={() => setMember(s.schedule, "add")}
                      className="shrink-0 rounded-full bg-calm-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-calm-700"
                    >
                      Add
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this routine?"
        message="Its habits stay on your plan — they just won't be grouped anymore."
        confirmLabel="Delete"
        destructive
        onConfirm={deleteRoutine}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}

export default RoutinePage;
