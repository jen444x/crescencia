import { useMemo, useState, useEffect, useRef } from "react";
import { CheckIcon } from "../../../components/icons";

// A bottom-sheet to create OR edit a routine: set its name and check which
// scheduled habits belong to it. In edit mode it can also delete the routine
// (members are ungrouped, never deleted). `habits` is every scheduled habit with
// its current routine, so we pre-check this routine's members and offer the loose
// (ungrouped) ones to add. Mirrors NoteSheet's overlay/keyboard handling.
export function RoutineSheet({
  routine,
  habits,
  chains,
  currentChainId,
  onCreate,
  onSave,
  onDelete,
  onMoveChain,
  onClose,
}: {
  routine: { id: number; name: string } | null; // null = create mode
  habits: { scheduleId: number; name: string; routineId: number | null }[];
  // The timed chains this routine could live in, and which one it's in now
  // (null if it isn't in a timed chain). Drives the "Move to chain" picker.
  chains: { id: number; label: string }[];
  currentChainId: number | null;
  onCreate: (name: string, scheduleIds: number[]) => Promise<boolean>;
  onSave: (
    routineId: number,
    name: string,
    addIds: number[],
    removeIds: number[],
  ) => Promise<boolean>;
  onDelete: (routineId: number) => void;
  // Move the whole routine to another chain (every day from today), applied as
  // part of Save. `memberScheduleIds` is the routine's membership after this
  // save, so the move targets the final members. Resolves true on success.
  onMoveChain: (
    routineId: number,
    chainId: number,
    memberScheduleIds?: number[],
  ) => Promise<boolean>;
  onClose: () => void;
}) {
  // Schedule ids currently in THIS routine (edit mode): pre-checked, always shown.
  const currentMemberIds = useMemo(
    () =>
      routine
        ? habits
            .filter((h) => h.routineId === routine.id)
            .map((h) => h.scheduleId)
        : [],
    [habits, routine],
  );

  const [name, setName] = useState(routine?.name ?? "");
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(currentMemberIds),
  );
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The chain staged in the picker; the actual move runs on Save (see save()).
  const [chainId, setChainId] = useState<number | null>(currentChainId);
  const nameRef = useRef<HTMLInputElement>(null);

  // Habits you can put in this routine: its own members plus any loose
  // (ungrouped) ones. Habits already in a DIFFERENT routine are left out — it's
  // one routine per habit, so you'd remove them from the other one first.
  const choices = habits.filter(
    (h) =>
      h.routineId == null || (routine != null && h.routineId === routine.id),
  );

  // Keep the sheet above the on-screen keyboard (same approach as NoteSheet).
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

  useEffect(() => {
    nameRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function toggle(scheduleId: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(scheduleId)) next.delete(scheduleId);
      else next.add(scheduleId);
      return next;
    });
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    let ok: boolean;
    if (routine) {
      const current = new Set(currentMemberIds);
      const addIds = [...selected].filter((id) => !current.has(id));
      const removeIds = currentMemberIds.filter((id) => !selected.has(id));
      ok = await onSave(routine.id, trimmed, addIds, removeIds);
      // Then, if the chain was changed, move the routine. We pass the SAVED
      // membership (selected) so an add/remove done in this same Save is honored
      // — the move acts on the final members, not the stale pre-edit set.
      if (ok && chainId != null && chainId !== currentChainId) {
        ok = await onMoveChain(routine.id, chainId, [...selected]);
      }
    } else {
      ok = await onCreate(trimmed, [...selected]);
    }
    setSaving(false);
    if (ok) onClose();
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
        aria-label={routine ? `Edit ${routine.name}` : "New routine"}
        className="animate-sheet-in relative max-h-full w-full max-w-md overflow-y-auto rounded-t-3xl border border-mist bg-white p-6 pb-8 shadow-[0_18px_44px_rgba(27,46,42,0.18)] sm:rounded-3xl"
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-mist sm:hidden" />
        <h2 className="font-heading text-2xl text-calm-900">
          {routine ? "Edit routine" : "New routine"}
        </h2>
        <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-calm-500">
          A group of habits, done in any order
        </p>

        <label className="mt-4 block text-xs font-medium text-calm-600">
          Name
        </label>
        <input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Morning routine"
          maxLength={100}
          className="mt-1 w-full rounded-lg border border-mist bg-whisper px-3 py-2 text-sm text-calm-900 focus:border-calm-500 focus:outline-none"
        />

        <p className="mt-4 text-xs font-medium text-calm-600">
          Habits{selected.size > 0 ? ` · ${selected.size} selected` : ""}
        </p>
        {choices.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {choices.map((h) => {
              const on = selected.has(h.scheduleId);
              return (
                <li key={h.scheduleId}>
                  <button
                    type="button"
                    onClick={() => toggle(h.scheduleId)}
                    aria-pressed={on}
                    className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                      on
                        ? "border-mist bg-whisper text-calm-900"
                        : "border-mist bg-white text-stone-600 hover:bg-whisper"
                    }`}
                  >
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${
                        on
                          ? "border-calm-600 bg-calm-600 text-white"
                          : "border-stone-300 text-transparent"
                      }`}
                    >
                      <CheckIcon />
                    </span>
                    <span className="truncate">{h.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-stone-400">
            No scheduled habits to add yet — put a habit on your plan first.
          </p>
        )}

        {/* Move the whole routine to another time block. Picking a chain here
            only stages the choice — it's applied when you tap Save (every day
            from today), with an Undo on the toast. Only shown in edit mode when
            there's somewhere else to move it. */}
        {routine && chains.length > 1 && (
          <div className="mt-5">
            <label className="block text-xs font-medium text-calm-600">
              Chain
            </label>
            <p className="mt-0.5 text-[11px] text-calm-400">
              Move the whole routine to another time block — applied on Save,
              every day from today.
            </p>
            <select
              value={chainId ?? ""}
              disabled={saving}
              onChange={(e) => setChainId(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-mist bg-whisper px-3 py-2 text-sm text-calm-900 focus:border-calm-500 focus:outline-none disabled:opacity-50"
            >
              {chains.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                  {c.id === currentChainId ? " (current)" : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="mt-6 flex items-center justify-between gap-2">
          {/* Delete (edit only) — two taps so it can't fire by accident. Members
              are ungrouped, not deleted. */}
          {routine ? (
            confirmDelete ? (
              <button
                type="button"
                onClick={() => onDelete(routine.id)}
                className="rounded-lg bg-rose-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-rose-700"
              >
                Tap to confirm
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="rounded-lg px-3 py-2 text-xs font-medium text-rose-500 transition-colors hover:bg-rose-50"
              >
                Delete
              </button>
            )
          ) : (
            <span />
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-2 text-sm font-medium text-calm-600 transition-colors hover:bg-calm-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={name.trim() === "" || saving}
              className="rounded-lg bg-calm-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-calm-700 disabled:opacity-50"
            >
              {routine ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
