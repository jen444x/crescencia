import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Habit, HabitStatus } from "../types";
import {
  CheckIcon,
  ChevronIcon,
  PencilIcon,
} from "../../../components/icons";
import { highestDoneLevel } from "../tier";
import { applyStatusAction, isDone, isSkipped } from "../status";
import { RowLayout } from "./RowLayout";
import { PlanStatusSheet } from "./PlanStatusSheet";

// One completed habit in the collapsed tray: compact, faded, still tappable.
// A tap opens the SAME status menu as the active rows (so a done habit behaves
// like the rest — Complete/Skip/Miss/Clear/Details); the filled check is a quick
// un-complete back to the active list. These habits are done, so menu actions
// act on the rung that's actually done (highestDoneLevel).
function CompletedRow({
  habit,
  onStatus,
  onOpenNote,
}: {
  habit: Habit;
  onStatus: (habitId: number, status: HabitStatus, tier?: number) => void;
  onOpenNote: (habit: Habit) => void;
}) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  // Prefer the new Note model; fall back to the legacy per-habit string while
  // /days/notes/ rolls out. (Step 2 shows multiple notes; this shows the first
  // as a one-line preview, matching the old single-note behavior.)
  const note = (habit.dayNotes?.[0]?.body ?? habit.notes ?? "").trim();
  const tierToSend = highestDoneLevel(habit) ?? undefined;
  return (
    <div
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-no-swipe]")) return;
        setMenuOpen(true);
      }}
      className="flex cursor-pointer items-center gap-3 rounded-lg px-4 py-2 hover:bg-white"
    >
      <span className="min-w-0 flex-1 truncate text-sm text-calm-400 line-through">
        {habit.name}
      </span>
      <button
        type="button"
        data-no-swipe
        aria-label="Mark as not done today"
        aria-pressed={true}
        onClick={(e) => {
          e.stopPropagation();
          applyStatusAction(habit, tierToSend, "CLEAR", true, onStatus);
        }}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-calm-500 bg-calm-500 text-white transition-colors hover:bg-calm-600"
      >
        <CheckIcon />
      </button>

      <PlanStatusSheet
        open={menuOpen}
        title={habit.name}
        current="COMPLETED"
        hasNotes={note !== ""}
        onPick={(action) => {
          applyStatusAction(habit, tierToSend, action, true, onStatus);
          setMenuOpen(false);
        }}
        onNote={() => {
          setMenuOpen(false);
          onOpenNote(habit);
        }}
        onDetails={() => {
          setMenuOpen(false);
          navigate(`/habits/${habit.id}`);
        }}
        onClose={() => setMenuOpen(false)}
      />
    </div>
  );
}

// A collapsed group of consecutive completed habits, shown IN PLACE (where they
// sit in the order) rather than swept to the bottom. Reads as a small "✓ N done"
// chip; tap to expand and review/undo. Collapsed by default.
export function CompletedTray({
  habits,
  onStatus,
  onOpenNote,
}: {
  habits: Habit[];
  onStatus: (habitId: number, status: HabitStatus, tier?: number) => void;
  onOpenNote: (habit: Habit) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="pb-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        // Full-width so a tap anywhere along the row toggles it, not just on the
        // "N done" text.
        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-calm-500 transition-colors hover:bg-calm-100 hover:text-calm-700"
      >
        <ChevronIcon open={open} />
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-calm-500 text-white">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-2.5 w-2.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={3}
              d="M5 13l4 4L19 7"
            />
          </svg>
        </span>
        <span>{habits.length} done</span>
      </button>

      {open && (
        <ul className="mt-0.5 space-y-0.5">
          {habits.map((habit) => (
            <li key={habit.id}>
              <CompletedRow
                habit={habit}
                onStatus={onStatus}
                onOpenNote={onOpenNote}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// A routine: a named group of habits shown as ONE collapsible block. Its "done"
// state is DERIVED, never stored — the block reads as done once every member is
// COMPLETED or SKIPPED. The big circle completes the whole block in one tap (and
// undoes it when it's already done); expand to tick members off one at a time,
// which fills the block in on its own.
export function RoutineBlock({
  routineId,
  name,
  habits,
  dayTier,
  stepNumber,
  connectBelow,
  onStatus,
  onOpenNote,
  onRoutineLog,
  onEdit,
}: {
  routineId: number;
  name: string;
  habits: Habit[];
  // The day's chosen tier, threaded to member cards for their shown rung/ladder.
  dayTier: number;
  // Chain step number + connector, when the routine sits inside a chain. null
  // step = standalone (no chain), and the block spans the full width.
  stepNumber: number | null;
  connectBelow: boolean;
  onStatus: (habitId: number, status: HabitStatus, tier?: number) => void;
  onOpenNote: (habit: Habit) => void;
  onRoutineLog: (routineId: number, status: HabitStatus) => void;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const total = habits.length;
  // A member counts as handled when it's done OR skipped — both clear the block.
  const handled = habits.filter((h) => isDone(h) || isSkipped(h)).length;
  const allDone = total > 0 && handled === total;

  return (
    <div className="flex gap-3">
      {/* Left rail: chain step badge + connector, so the routine reads as one
          step in the chain (e.g. between shower and lotion). Null step = the
          routine isn't in a chain, and the block spans the full width. */}
      {stepNumber != null && (
        <div className="flex flex-col items-center">
          <span className="z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-calm-300 bg-calm-50 text-[10px] font-medium text-calm-500">
            {stepNumber}
          </span>
          {connectBelow && <span className="w-px grow bg-calm-200" />}
        </div>
      )}
      <div className="min-w-0 flex-1">
        {/* Header reads as a habit card (same chrome): name on the left, the
            complete circle on the right. A chevron marks that it expands into its
            members; the pencil opens the manage sheet. */}
        <div
          className={`flex items-center gap-3 rounded-[18px] border border-mist px-4 py-3 shadow-[0_1px_2px_rgba(27,46,42,0.04)] transition-shadow hover:shadow-md ${
            allDone ? "bg-whisper" : "bg-white"
          }`}
        >
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <span className="shrink-0 text-calm-400">
              <ChevronIcon open={open} />
            </span>
            <span className="min-w-0">
              <span
                className={`block wrap-break-word font-medium ${
                  allDone ? "text-calm-400 line-through" : "text-calm-900"
                }`}
              >
                {name}
              </span>
              <span className="block text-xs text-stone-400">
                {handled} of {total} done
              </span>
            </span>
          </button>

          {/* Edit: rename, add/remove habits, or delete the routine. */}
          <button
            type="button"
            aria-label={`Edit ${name}`}
            onClick={onEdit}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-calm-300 transition-colors hover:bg-calm-50 hover:text-calm-500"
          >
            <PencilIcon />
          </button>

          {/* Complete-the-block circle (right, like a habit's): fills every
              member in one tap; tapping a done block undoes it. */}
          <button
            type="button"
            aria-label={allDone ? `Undo ${name}` : `Complete ${name}`}
            aria-pressed={allDone}
            onClick={() =>
              onRoutineLog(routineId, allDone ? "PENDING" : "COMPLETED")
            }
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition active:scale-90 ${
              allDone
                ? "border-calm-600 bg-calm-600 text-white"
                : "border-calm-300 text-transparent hover:border-calm-500"
            }`}
          >
            <CheckIcon />
          </button>
        </div>

        {/* Members: their own habit cards, indented under the header so you can
            do the routine one habit at a time. */}
        {open && (
          <ul className="mt-1.5 space-y-1.5 pl-3">
            {habits.map((habit) => (
              <li key={habit.id}>
                <RowLayout
                  habit={habit}
                  dayTier={dayTier}
                  stepNumber={null}
                  connectBelow={false}
                  onStatus={onStatus}
                  onOpenNote={onOpenNote}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
