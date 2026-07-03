import {
  useState,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import ConfirmDialog from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ErrorBanner } from "../components/ErrorBanner";
import { EmptyState } from "../components/EmptyState";
import {
  CheckIcon,
  DashIcon,
  XIcon,
  GripIcon,
  ChevronIcon,
  PencilIcon,
  ClockIcon,
  NoteIcon,
  SharedNoteIcon,
  RetimeHandleIcon,
} from "../components/icons";
import { useNavigate, Link } from "react-router-dom";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// Plan-page domain types and tier logic now live in ./plan/* so the toolbar and
// (future) sub-components can share them. The tier helpers are unchanged — only
// their home moved — and DAY_TIERS drives the new tier dropdown.
import type {
  HabitStatus,
  ReadStatus,
  Chain,
  Habit,
  DayNote,
  Segment,
} from "./plan/types";
import {
  GROWTH_LEVEL,
  caseBDisplayLevel,
  highestDoneLevel,
  isCaseB,
  levelsUpTo,
  rowDisplayValue,
  rowCompleteTier,
  slotPlacement,
  slotStatus,
} from "./plan/tier";
import { isDone, isSkipped, applyStatus } from "./plan/status";
import { chainLabel } from "./plan/chains";
import PlanToolbar from "./plan/components/PlanToolbar";
import { DateNav } from "./plan/components/DateNav";
import AddHabitButton from "../components/AddHabitButton";
import { forwardItemForMove, forwardItemForPlan } from "./plan/forward";
import {
  startOfDay,
  toYMD,
  addDays,
  isSameDay,
  dayLabel,
  formatTime,
  timeToMinutes,
  minutesToHHMM,
} from "./plan/dates";
import { currentBlockId, buildSegments, applyPlanOrder } from "./plan/segments";

// Which single habit moved in a within-chain reorder (fix #3). A single drag
// reorder relocates exactly one row; that row is the one whose removal from both
// the before- and after-lists leaves the remaining sequences identical. Returns
// its habit id, or null when the order didn't actually change (dropped in place).
function movedHabitId(before: Habit[], after: Habit[]): number | null {
  if (before.length !== after.length) {
    // Lengths differ — not a pure reorder; can't pinpoint one moved row.
    return null;
  }
  const sameOrder = before.every((h, i) => h.id === after[i]?.id);
  if (sameOrder) return null;
  // Try each candidate: remove it from both lists; if the remainders match in
  // order, that candidate is the moved one.
  for (const cand of after) {
    const b = before.filter((h) => h.id !== cand.id);
    const a = after.filter((h) => h.id !== cand.id);
    if (b.length === a.length && b.every((h, i) => h.id === a[i].id)) {
      return cand.id;
    }
  }
  // Ambiguous (multiple rows shifted): default to the first row that changed
  // position, so we still write a single-habit generation rather than nothing.
  const i = after.findIndex((h, idx) => h.id !== before[idx]?.id);
  return i >= 0 ? after[i].id : null;
}

// Apply a tap-menu choice to one habit slot, preserving the tier cascade:
// completing a Case-B rung marks the easier ones done too (so Clear can step DOWN
// a rung); Clear on a done card uncompletes the highest done rung. Shared by the
// active card (dot + menu) and the completed-tray row so they behave identically.
type StatusAction = "COMPLETE" | "SKIP" | "MISS" | "CLEAR";
function applyStatusAction(
  habit: Habit,
  tierToSend: number | undefined,
  action: StatusAction,
  isDone: boolean,
  onStatus: (habitId: number, status: HabitStatus, tier?: number) => void,
) {
  if (action === "COMPLETE") {
    if (isCaseB(habit) && tierToSend != null) {
      for (const lvl of levelsUpTo(habit, tierToSend))
        onStatus(habit.id, "COMPLETED", lvl);
    } else {
      onStatus(habit.id, "COMPLETED", tierToSend);
    }
  } else if (action === "SKIP") {
    onStatus(habit.id, "SKIPPED", tierToSend);
  } else if (action === "MISS") {
    onStatus(habit.id, "MISSED", tierToSend);
  } else {
    // CLEAR -> back to pending. A done card steps DOWN from its highest done rung.
    const top =
      isDone && isCaseB(habit)
        ? (highestDoneLevel(habit) ?? tierToSend)
        : tierToSend;
    onStatus(habit.id, "PENDING", top);
  }
}

function HabitCard({
  habit,
  dayTier,
  completeTier,
  onStatus,
  onOpenNote,
  handle,
}: {
  habit: Habit;
  // The day's chosen tier, so this card can compute its own display value
  // (Case A: its own value; Case B: the value of the highest rung <= dayTier).
  dayTier: number;
  // The tier level this card's check should send, overriding the dayTier-derived
  // one. Used by a stretch card so its check completes ITS (harder) rung, not the
  // habit's "today" rung. undefined -> derive from the row + dayTier.
  completeTier?: number;
  onStatus: (habitId: number, status: HabitStatus, tier?: number) => void;
  // Open the per-day note editor for this habit.
  onOpenNote: (habit: Habit) => void;
  // Optional drag handle (a grip), rendered at the left inside the card.
  handle?: ReactNode;
}) {
  // This card is one tier-slot of a habit. When it carries a tier value (e.g.
  // "7:30" / "11am" / "5 min") we append it after the name so the slot reads as
  // "Wake up · 7:30"; an untiered slot has none and renders exactly as before.
  // A stretch card is pinned to one rung (completeTier), so it shows that rung's
  // value; otherwise the value follows the case + dayTier.
  // The rung this card SHOWS and acts on. A stretch card pins an explicit
  // completeTier. A Case-B inline card (no override) shows the habit's CURRENT
  // achievement — the highest done rung once you've reached today's, else today's
  // target rung — so after you do Growth it reads "· 12:30am" and undo steps it
  // back down. Case A uses its own tier; untiered: none.
  const caseBInline = completeTier == null && isCaseB(habit);
  const tierToSend =
    completeTier ??
    (caseBInline
      ? (caseBDisplayLevel(habit, dayTier) ?? undefined)
      : rowCompleteTier(habit, dayTier));
  const tierValue =
    tierToSend != null
      ? (habit.tiers?.find((t) => t.level === tierToSend)?.value ??
        habit.tier_value ??
        null)
      : rowDisplayValue(habit, dayTier);
  // Per-version state: this card shows ITS rung's status (cascade already folded
  // in by the backend), so completing the easy version never ticks the harder one.
  const cardStatus = slotStatus(habit, tierToSend);
  const done = cardStatus === "COMPLETED";
  const skipped = cardStatus === "SKIPPED";
  const missed = cardStatus === "MISSED";
  // Notes come from the new Note model; fall back to the legacy per-habit string
  // while /days/notes/ rolls out. `hasNotes` drives the note button's accent
  // (the notes themselves are viewed on the habit detail page).
  const dayNotes = habit.dayNotes ?? [];
  const legacyNote = habit.notes?.trim() ?? "";
  const hasNotes = dayNotes.length > 0 || legacyNote !== "";

  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      // A tap anywhere on the card opens the status menu (Complete / Skip / Miss
      // / Clear, plus note + Details). The grip and dot carry data-no-swipe +
      // their own stopPropagation, so they keep doing their own thing.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-no-swipe]")) return;
        setMenuOpen(true);
      }}
      className={`group flex select-none flex-col rounded-xl px-4 py-2 shadow-sm hover:shadow-md transition-shadow cursor-pointer ${
        done
          ? "bg-sage-50"
          : skipped
            ? "bg-stone-50"
            : missed
              ? "bg-clay-100"
              : "bg-white"
      }`}
    >
      <div className="flex items-center gap-3">
        {handle}
        {/* The name is a plain heading again, so a normal tap bubbles up and opens
          the habit detail page. A tier-slot appends its value (e.g. "· 7:30") in
          a lighter span, dimmed further once the slot is done. */}
        <div className="min-w-0 flex-1">
          <h3
            className={`break-words font-medium ${
              done
                ? "text-sage-400 line-through"
                : skipped
                  ? "text-stone-400"
                  : missed
                    ? "text-clay-400"
                    : "text-sage-900"
            }`}
          >
            {habit.name}
            {tierValue && (
              <span
                className={`font-normal ${
                  done ? "text-sage-300" : "text-stone-400"
                }`}
              >
                {" · "}
                {tierValue}
              </span>
            )}
          </h3>
        </div>

        {/* Status dot: shows the slot's state (✓ done · – skipped · ✗ missed),
          and a one-tap toggles Complete / undo. Skip / Miss / Clear / note /
          Details all live in the tap menu. */}
        <button
          type="button"
          data-no-swipe
          aria-label={done ? "Mark as not done today" : "Mark as done today"}
          aria-pressed={done}
          onClick={(e) => {
            e.stopPropagation();
            applyStatusAction(
              habit,
              tierToSend,
              done ? "CLEAR" : "COMPLETE",
              done,
              onStatus,
            );
          }}
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors ${
            done
              ? "border-sage-600 bg-sage-600 text-white"
              : skipped
                ? "border-stone-400 bg-stone-400 text-white"
                : missed
                  ? "border-clay-400 bg-clay-400 text-white"
                  : "border-sage-300 text-transparent hover:border-sage-500"
          }`}
        >
          {skipped ? <DashIcon /> : missed ? <XIcon /> : <CheckIcon />}
        </button>
      </div>

      <PlanStatusSheet
        open={menuOpen}
        title={habit.name}
        current={cardStatus}
        hasNotes={hasNotes}
        onPick={(action) => {
          applyStatusAction(habit, tierToSend, action, done, onStatus);
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

// The tap menu for a Plan-page habit slot: Skip / Complete / Miss in a row (plus
// Clear when a status is set), a note icon top-right, and the habit name as a
// link to its Details page. Portaled so the card's drag transforms can't clip
// it; a stopPropagation at the root keeps a click inside from bubbling back to
// the card and re-opening the menu.
function PlanStatusSheet({
  open,
  title,
  current,
  hasNotes,
  onPick,
  onNote,
  onDetails,
  onClose,
}: {
  open: boolean;
  title: string;
  current: ReadStatus;
  hasNotes: boolean;
  onPick: (action: "COMPLETE" | "SKIP" | "MISS" | "CLEAR") => void;
  onNote: () => void;
  onDetails: () => void;
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

  // The three primary statuses, shown side-by-side. Clear (back to pending) is
  // rendered separately below, and only when a status is actually set.
  const statuses: {
    action: "SKIP" | "COMPLETE" | "MISS";
    status: ReadStatus;
    label: string;
    className: string;
    ring: string;
  }[] = [
    {
      action: "SKIP",
      status: "SKIPPED",
      label: "Skip",
      className: "bg-stone-100 text-stone-600 hover:bg-stone-200",
      ring: "ring-stone-400",
    },
    {
      action: "COMPLETE",
      status: "COMPLETED",
      label: "Complete",
      className: "bg-sage-600 text-white hover:bg-sage-700",
      ring: "ring-sage-700",
    },
    {
      action: "MISS",
      status: "MISSED",
      label: "Miss",
      className: "bg-clay-100 text-clay-600 hover:bg-clay-200",
      ring: "ring-clay-400",
    },
  ];

  return createPortal(
    <div
      onClick={(e) => e.stopPropagation()}
      className="fixed inset-0 z-50 flex flex-col items-center justify-end gap-2 p-3 sm:justify-center"
    >
      <div
        className="animate-backdrop-in absolute inset-0 bg-sage-900/40"
        onClick={onClose}
        aria-hidden
      />

      {/* The sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Actions for ${title}`}
        className="animate-sheet-in relative w-full max-w-sm rounded-3xl bg-white p-4 shadow-xl"
      >
        {/* Grab-handle pill — reads as a bottom sheet on the phone. */}
        <div
          className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-sage-200"
          aria-hidden
        />

        {/* Header: the note icon gets its OWN row in the top-right, above the
          name; the habit name (centered, with a chevron) opens its page on tap. */}
        <div className="mb-8">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onNote}
              aria-label={hasNotes ? "Edit notes" : "Add note"}
              className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                hasNotes
                  ? "bg-sage-50 text-sage-600 hover:bg-sage-100"
                  : "text-sage-400 hover:bg-sage-50 hover:text-sage-600"
              }`}
            >
              <NoteIcon />
            </button>
          </div>
          <button
            type="button"
            onClick={onDetails}
            className="group -mt-1 flex w-full items-center justify-center gap-1 px-4"
          >
            <span className="min-w-0 truncate text-lg font-semibold text-sage-900 group-hover:text-sage-700">
              {title}
            </span>
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              className="h-4 w-4 shrink-0 text-sage-400 group-hover:text-sage-600"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 5l7 7-7 7"
              />
            </svg>
          </button>
        </div>

        {/* Skip / Complete / Miss, side by side. The current status keeps a ring. */}
        <div className="flex gap-2">
          {statuses.map((o) => (
            <button
              key={o.action}
              type="button"
              onClick={() => onPick(o.action)}
              className={`flex flex-1 items-center justify-center rounded-xl py-3.5 text-sm font-medium transition-colors ${
                o.className
              } ${current === o.status ? `ring-2 ring-offset-2 ring-offset-white ${o.ring}` : ""}`}
            >
              {o.label}
            </button>
          ))}
        </div>

        {/* Clear back to pending — only when a status is actually set. */}
        {current !== "PENDING" && (
          <button
            type="button"
            onClick={() => onPick("CLEAR")}
            className="mt-2 w-full rounded-xl py-2.5 text-sm font-medium text-sage-500 transition-colors hover:bg-sage-50"
          >
            Clear
          </button>
        )}
      </div>

      {/* Cancel — its own card, iOS action-sheet style. */}
      <button
        type="button"
        onClick={onClose}
        className="relative w-full max-w-sm rounded-2xl bg-white py-3.5 text-sm font-semibold text-stone-500 shadow-xl transition-colors hover:text-stone-700"
      >
        Cancel
      </button>
    </div>,
    document.body,
  );
}

// Shared layout. Chain steps get a numbered badge + connector line in a left
// rail (a label only — dragging happens via the grip inside the card).
// Standalone habits have no rail, so their card spans the full width.
function RowLayout({
  habit,
  dayTier,
  stepNumber,
  connectBelow,
  onStatus,
  onOpenNote,
  handle,
  nodeRef,
  style,
}: {
  habit: Habit;
  // Threaded to the card so it can compute its own per-case display value.
  dayTier: number;
  stepNumber: number | null;
  connectBelow: boolean;
  onStatus: (habitId: number, status: HabitStatus, tier?: number) => void;
  onOpenNote: (habit: Habit) => void;
  handle?: ReactNode;
  nodeRef?: (node: HTMLElement | null) => void;
  style?: CSSProperties;
}) {
  return (
    <div ref={nodeRef} style={style} className="flex gap-3">
      {stepNumber != null && (
        <div className="flex flex-col items-center">
          <span className="z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-sage-300 bg-sage-50 text-[10px] font-medium text-sage-500">
            {stepNumber}
          </span>
          {connectBelow && <span className="w-px grow bg-sage-200" />}
        </div>
      )}
      {/* min-w-0 lets this column shrink below the note's width so the note can
          truncate instead of pushing the card (and its ✓ button) off-screen. */}
      <div className="min-w-0 flex-1">
        <HabitCard
          habit={habit}
          dayTier={dayTier}
          onStatus={onStatus}
          onOpenNote={onOpenNote}
          handle={handle}
        />
      </div>
    </div>
  );
}

// A draggable habit row. The drag handle is a grip INSIDE the card; chain steps
// also show their number in the left rail (label only).
function SortableRow({
  habit,
  dayTier,
  stepNumber,
  connectBelow,
  onStatus,
  onOpenNote,
}: {
  habit: Habit;
  dayTier: number;
  stepNumber: number | null;
  connectBelow: boolean;
  onStatus: (habitId: number, status: HabitStatus, tier?: number) => void;
  onOpenNote: (habit: Habit) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    // Keyed by the per-day ROW (row_id), not the habit: a habit can sit in
    // several blocks (tier-slots at different times), so habit.id isn't unique
    // across the page-wide drag context. row_id is stable across the
    // template->frozen flip (schedule_id goes null on a frozen day). An Anytime
    // habit has no row yet, so it uses a "new-<habitId>" id the drop handler
    // recognizes as "place me".
  } = useSortable({
    id: habit.row_id != null ? habit.row_id : `new-${habit.id}`,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const handle = (
    <button
      type="button"
      data-no-swipe
      aria-label="Drag to reorder"
      {...attributes}
      {...listeners}
      // Don't let a tap on the grip open the habit's detail page.
      onClick={(e) => e.stopPropagation()}
      // -m-2 + p-2 doubles the tap target (16px -> 32px) without shifting the
      // layout. No `touch-none` here: a quick swipe on the grip should still
      // scroll the page; only a held press (see TouchSensor delay) starts a drag.
      className="-m-2 shrink-0 cursor-grab select-none p-2 text-sage-300 hover:text-sage-500 active:cursor-grabbing"
    >
      <GripIcon />
    </button>
  );

  return (
    <RowLayout
      habit={habit}
      dayTier={dayTier}
      stepNumber={stepNumber}
      connectBelow={connectBelow}
      onStatus={onStatus}
      onOpenNote={onOpenNote}
      handle={handle}
      nodeRef={setNodeRef}
      style={style}
    />
  );
}

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
      <span className="min-w-0 flex-1 truncate text-sm text-sage-400 line-through">
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
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-sage-500 bg-sage-500 text-white transition-colors hover:bg-sage-600"
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
function CompletedTray({
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
        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-sage-500 transition-colors hover:bg-sage-100 hover:text-sage-700"
      >
        <ChevronIcon open={open} />
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-sage-500 text-white">
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
function RoutineBlock({
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
          <span className="z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-sage-300 bg-sage-50 text-[10px] font-medium text-sage-500">
            {stepNumber}
          </span>
          {connectBelow && <span className="w-px grow bg-sage-200" />}
        </div>
      )}
      <div className="min-w-0 flex-1">
        {/* Header reads as a habit card (same chrome): name on the left, the
            complete circle on the right. A chevron marks that it expands into its
            members; the pencil opens the manage sheet. */}
        <div
          className={`flex items-center gap-3 rounded-xl px-4 py-2 shadow-sm transition-shadow hover:shadow-md ${
            allDone ? "bg-sage-50" : "bg-white"
          }`}
        >
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <span className="shrink-0 text-sage-400">
              <ChevronIcon open={open} />
            </span>
            <span className="min-w-0">
              <span
                className={`block break-words font-medium ${
                  allDone ? "text-sage-400 line-through" : "text-sage-900"
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
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sage-300 transition-colors hover:bg-sage-50 hover:text-sage-500"
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
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors ${
              allDone
                ? "border-sage-600 bg-sage-600 text-white"
                : "border-sage-300 text-transparent hover:border-sage-500"
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

// All of one plan's habits. Not-yet-completed habits show as the active list (a
// drag-to-reorder list for scheduled plans; a plain list for "Anytime"), and
// completed habits collapse into the tray below so they stop taking up space.
// Routine-tagged habits render as a collapsible block IN PLACE (so a routine
// stays put inside its chain), not lifted out of the order.
function PlanBoard({
  chain,
  dayTier,
  inlineTierByHabit,
  mainOnly,
  onStatus,
  onOpenNote,
  onRoutineLog,
  onEditRoutine,
  interactive,
}: {
  chain: Chain;
  // The day's chosen tier (Roots=1 / Growth=2). Tiered habits with no rung at or
  // below it are hidden for the day; threaded to each card for its shown rung.
  dayTier: number;
  // habit id -> its highest Case-A slot level <= dayTier (its "today" version), or
  // null. Drives which tier-slot renders inline vs. stretches vs. hides.
  inlineTierByHabit: Map<number, number | null>;
  // "Main only" view: when on, helper/support habits are hidden too (still kept
  // in place during reorder, like tier-hidden ones — never dropped).
  mainOnly: boolean;
  onStatus: (habitId: number, status: HabitStatus, tier?: number) => void;
  onOpenNote: (habit: Habit) => void;
  onRoutineLog: (routineId: number, status: HabitStatus) => void;
  onEditRoutine: (routineId: number, name: string) => void;
  // Reorderable on ANY viewed day: dragging now writes the per-day layer
  // (/days/arrange/ with the viewed date), so re-sorting "yesterday" or
  // "tomorrow" only touches that one day and never the recurring routine. Still
  // false for the "Anytime" group (no rows to reorder).
  interactive: boolean;
}) {
  const chainId = chain.id;
  // Register this block as a drop target so a row dragged out of another block
  // can land here — including on the empty space below the rows. The page-level
  // DndContext (in the main component) runs the actual move on drop.
  const { setNodeRef: setDropRef } = useDroppable({
    id: `plan-${chainId ?? "anytime"}`,
  });
  // Keep only the rows that belong INLINE for the day: untiered rows, the one
  // Case-A slot at the habit's highest tier <= today, and a Case-B row that has a
  // rung <= today. Stretch/hidden slots are simply absent here (their harder
  // versions surface in the Stretch section). "Important only" narrows further.
  // They're dropped from DISPLAY only — every list below (segments, active set,
  // drag rebuild) is built from this set, so reorder only touches what's shown;
  // the hidden ones are re-inserted in place when persisting (see handleDragEnd).
  const habits = chain.habits.filter(
    (habit) =>
      slotPlacement(habit, inlineTierByHabit, dayTier) === "inline" &&
      (!mainOnly || !habit.is_support),
  );

  // Not reorderable when it's the "Anytime" group (no schedule rows) or any day
  // that isn't today (see `interactive` above).
  // Anytime (chainId null) is draggable too, so you can drag a freshly-added
  // habit out of it onto a time block. It just isn't a reorder/move target —
  // dropping onto it is a no-op for now (removing a habit's time comes later).
  const canReorder = interactive;

  // Ordered segments: single active habits, in-place "done" groups, and routine
  // blocks — each rendered WHERE it sits in the order, so a routine stays inside
  // its chain. Drag reorders only the loose active habits; done + routine units
  // keep their exact spot.
  // A real time block (chainId set) is one chain → its habits render connected.
  // "Anytime" (chainId null) isn't a time, so it stays loose.
  const segments = buildSegments(habits, chainId != null);
  const activeHabits = habits.filter(
    (habit) => !isDone(habit) && habit.routine == null,
  );

  // Renders one collapsed done-group; shared by both branches below.
  const doneItem = (seg: Extract<Segment, { kind: "done" }>) => (
    <li key={seg.key}>
      <CompletedTray
        habits={seg.habits}
        onStatus={onStatus}
        onOpenNote={onOpenNote}
      />
    </li>
  );

  // Renders one routine block in place; shared by both branches below.
  const routineItem = (seg: Extract<Segment, { kind: "routine" }>) => (
    <li key={seg.key}>
      <RoutineBlock
        routineId={seg.routineId}
        name={seg.name}
        habits={seg.habits}
        dayTier={dayTier}
        stepNumber={seg.stepNumber}
        connectBelow={seg.connectBelow}
        onStatus={onStatus}
        onOpenNote={onOpenNote}
        onRoutineLog={onRoutineLog}
        onEdit={() => onEditRoutine(seg.routineId, seg.name)}
      />
    </li>
  );

  if (!canReorder) {
    return (
      <ul className="space-y-1.5">
        {segments.map((seg) =>
          seg.kind === "done" ? (
            doneItem(seg)
          ) : seg.kind === "routine" ? (
            routineItem(seg)
          ) : (
            <li key={seg.row.habit.id}>
              {/* Non-draggable, but still shows chain step numbers/connectors. */}
              <RowLayout
                habit={seg.row.habit}
                dayTier={dayTier}
                stepNumber={seg.row.stepNumber}
                connectBelow={seg.row.connectBelow}
                onStatus={onStatus}
                onOpenNote={onOpenNote}
              />
            </li>
          ),
        )}
      </ul>
    );
  }

  // Drag ids are row ids (unique page-wide, stable across the template->frozen
  // flip). The drop logic lives in the main component's page-level DndContext,
  // which can see every block at once — both within-block reorder and a move
  // into another block.
  const activeIds = activeHabits.map((habit) =>
    habit.row_id != null ? habit.row_id : `new-${habit.id}`,
  );

  return (
    <SortableContext items={activeIds} strategy={verticalListSortingStrategy}>
      <ul ref={setDropRef} className="space-y-1.5">
        {segments.length === 0 && (
          // A freshly-added (empty) block: a tall dashed target so it's easy to
          // drop a habit onto, with a hint of what to do.
          <li className="rounded-xl border border-dashed border-sage-200 px-3 py-5 text-center text-xs text-sage-400">
            Drag a habit here
          </li>
        )}
        {segments.map((seg) =>
          seg.kind === "done" ? (
            doneItem(seg)
          ) : seg.kind === "routine" ? (
            routineItem(seg)
          ) : (
            <li key={seg.row.habit.row_id ?? `new-${seg.row.habit.id}`}>
              <SortableRow
                habit={seg.row.habit}
                dayTier={dayTier}
                stepNumber={seg.row.stepNumber}
                connectBelow={seg.row.connectBelow}
                onStatus={onStatus}
                onOpenNote={onOpenNote}
              />
            </li>
          ),
        )}
      </ul>
    </SortableContext>
  );
}

// The ⏱ "running late" control on a time block. Pushing this chain later moves
// it AND everything after it that day (the backend cascades + clamps); it's a
// per-day override, so the recurring routine is untouched. Deliberately separate
// from drag-reorder, which moves just one habit without changing times.
function ShiftControl({
  chainId,
  onShift,
}: {
  chainId: number;
  onShift: (chainId: number, minutes: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(15);
  const ref = useRef<HTMLDivElement>(null);

  // Close the popover on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function apply(minutes: number) {
    if (!minutes) return;
    onShift(chainId, minutes);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Running late — shift this chain and everything after it"
        aria-expanded={open}
        className="flex h-6 w-6 items-center justify-center rounded-full text-sage-500 transition-colors hover:bg-sage-100 hover:text-sage-700"
      >
        <ClockIcon />
      </button>

      {open && (
        <div className="absolute right-0 top-7 z-50 w-60 rounded-xl border border-sage-200 bg-white p-3 text-left shadow-lg">
          <p className="text-xs font-semibold text-sage-700">Running late?</p>
          <p className="mb-2 text-[11px] leading-snug text-stone-400">
            Moves this chain and everything after it — today only.
          </p>

          <div className="flex gap-1.5">
            {[15, 30, 45].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => apply(m)}
                className="flex-1 rounded-lg bg-sage-100 py-1.5 text-xs font-medium text-sage-700 transition-colors hover:bg-sage-200"
              >
                +{m}
              </button>
            ))}
          </div>

          <div className="mt-2 flex items-center gap-1.5">
            <input
              type="number"
              min={1}
              value={custom}
              onChange={(e) =>
                setCustom(Math.max(1, parseInt(e.target.value, 10) || 0))
              }
              aria-label="Custom minutes"
              className="w-12 rounded-lg border border-sage-200 px-2 py-1 text-xs text-sage-700"
            />
            <span className="text-[11px] text-stone-400">min</span>
            <button
              type="button"
              onClick={() => apply(-custom)}
              className="flex-1 rounded-lg border border-sage-200 py-1 text-xs font-medium text-sage-600 transition-colors hover:bg-sage-50"
            >
              Earlier
            </button>
            <button
              type="button"
              onClick={() => apply(custom)}
              className="flex-1 rounded-lg border border-sage-200 py-1 text-xs font-medium text-sage-600 transition-colors hover:bg-sage-50"
            >
              Later
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Retime a single chain (ephemeral time ruler) ---------------------------
// The single-block companion to the "running late" shift. Grab a chain by its
// header strip and a slim time ruler fades in *just for the drag*: the dragged
// block rides the ruler so its position = its time (the calendar feel), then the
// ruler vanishes on drop — at rest it's still a plain habit list, never a grid.
// Sets one ABSOLUTE time for that one chain (no cascade), today only — a per-day
// override; tomorrow is normal again. Undo lives on a toast after each drop.

// Ruler scale: ~1.1px per minute (≈66px/hour), so 15-min steps are ~16px — easy
// to hit. The SAME scale drives the pointer→time mapping and the on-screen ruler,
// so the dragged chip tracks your finger. Times snap to a loose 15-min grid.
const RETIME_PX_PER_MIN = 1.1;
const RETIME_SNAP_MIN = 15;
const RETIME_DRAG_THRESHOLD = 4; // px of movement before a press counts as a drag
const DAY_END_MIN = 23 * 60 + 59; // 23:59 — the day's last valid minute

// Round to the nearest 5 minutes, then clamp inside the day so a long drag stops
// at 00:00 / 23:59 instead of running off either end.
function snapRetime(minutes: number): number {
  const snapped = Math.round(minutes / RETIME_SNAP_MIN) * RETIME_SNAP_MIN;
  return Math.max(0, Math.min(DAY_END_MIN, snapped));
}

// Keep two chains off the exact same minute — /plan/ renders same-time blocks as
// two stacked rows, which she didn't want. If `minutes` is already taken by
// another chain, step outward (just-after first, then just-before) to the nearest
// free minute so the dropped chain sorts beside its neighbor but stays its own
// block. Frontend owns this; the backend just stores whatever time we send.
function avoidRetimeCollision(minutes: number, takenMinutes: number[]): number {
  const taken = new Set(takenMinutes);
  if (!taken.has(minutes)) return minutes;
  for (let delta = 1; delta <= 60; delta++) {
    if (minutes + delta <= DAY_END_MIN && !taken.has(minutes + delta))
      return minutes + delta;
    if (minutes - delta >= 0 && !taken.has(minutes - delta))
      return minutes - delta;
  }
  return minutes; // every nearby minute taken (degenerate) — let it stack
}

// The ephemeral time ruler, shown only while a block is being dragged. A slim,
// translucent calendar surface: hour ticks + labels, cards for the day's other
// timed blocks (so you place this one relative to them), a dotted line at the
// block's original time, and the dragged block as a chip. Anchored so the
// block's start time sits at the press point (anchorY), at the same px/min as
// the pointer mapping — so the chip tracks your finger as it travels past the
// other chains. Portaled to <body> and pointer-events:none — the block's
// captured pointer handlers drive it; this is purely the visual.
function RetimeRuler({
  anchorY,
  startMin,
  previewMin,
  blockLabel,
  otherBlocks,
}: {
  anchorY: number;
  startMin: number;
  previewMin: number;
  blockLabel: string;
  otherBlocks: { min: number; name: string }[];
}) {
  // Screen Y for a minute, anchored so startMin sits at the press point — the
  // chip then tracks your finger while the other chains stay put as context.
  const yForMin = (min: number) =>
    anchorY + (min - startMin) * RETIME_PX_PER_MIN;
  const viewportH = window.innerHeight;
  // The ruler runs past the viewport both ways; only draw what's on screen.
  const onScreen = (y: number) => y > -48 && y < viewportH + 48;

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-50">
      {/* Dim the list so the ruler is the focus; both vanish on drop. */}
      <div className="absolute inset-0 bg-sage-900/30" />

      <div className="relative mx-auto h-full max-w-md overflow-hidden bg-white/60">
        <p className="absolute inset-x-0 top-0 z-10 bg-white/70 py-2 text-center text-[11px] font-medium uppercase tracking-wide text-sage-500">
          Drag to a time · release to set · today only
        </p>

        {/* Hour gridlines + labels. */}
        {Array.from({ length: 24 }, (_, h) => h).map((h) => {
          const y = yForMin(h * 60);
          if (!onScreen(y)) return null;
          return (
            <div
              key={`hour-${h}`}
              className="absolute inset-x-0 flex -translate-y-1/2 items-center gap-2 px-4"
              style={{ top: y }}
            >
              <span className="w-12 shrink-0 text-right text-[10px] tabular-nums text-sage-400">
                {formatTime(minutesToHHMM(h * 60))}
              </span>
              <span className="h-px flex-1 bg-sage-200" />
            </div>
          );
        })}

        {/* The day's other timed blocks, as light context markers. */}
        {otherBlocks.map((b) => {
          const y = yForMin(b.min);
          if (!onScreen(y)) return null;
          return (
            <div
              key={`${b.min}-${b.name}`}
              className="absolute inset-x-0 flex -translate-y-1/2 items-center px-4"
              style={{ top: y }}
            >
              <span className="ml-14 flex max-w-[70%] items-center gap-1.5 truncate rounded-lg bg-white px-2 py-1 text-[11px] text-sage-500 shadow-sm ring-1 ring-sage-200">
                <span className="shrink-0 tabular-nums text-sage-400">
                  {formatTime(minutesToHHMM(b.min))}
                </span>
                <span className="truncate">{b.name}</span>
              </span>
            </div>
          );
        })}

        {/* Dotted guide at the block's original time — drag back here to undo. */}
        {onScreen(yForMin(startMin)) && (
          <div
            className="absolute inset-x-0 -translate-y-1/2 px-4"
            style={{ top: yForMin(startMin) }}
          >
            <div className="ml-14 border-t border-dashed border-sage-300" />
          </div>
        )}

        {/* The dragged block itself, riding the ruler at its live time. */}
        <div
          className="absolute inset-x-0 -translate-y-1/2 px-4"
          style={{ top: yForMin(previewMin) }}
        >
          <div className="ml-12 flex items-center gap-2 rounded-xl bg-sage-600 px-3 py-2 text-white shadow-lg ring-2 ring-white">
            <span className="text-sm font-semibold tabular-nums">
              {formatTime(minutesToHHMM(previewMin))}
            </span>
            <span className="min-w-0 truncate text-xs text-sage-100">
              {blockLabel}
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// The chain's name, inline-editable. Shows `label` (the saved name, or the
// chainLabel fallback when unnamed) as a tappable title; tapping opens a small
// text input that saves on Enter/blur and cancels on Escape. Carries
// data-no-retime so a tap edits the name instead of starting the header's
// retime drag. Only rendered for timed blocks. `name` is the raw saved value
// ("" when unnamed) — what we seed the input with — while `label` is what we
// show when not editing.
function ChainNameControl({
  name,
  label,
  onSave,
}: {
  name: string;
  label: string;
  onSave: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus + select when the input opens so a rename overwrites cleanly.
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function open() {
    setDraft(name);
    setEditing(true);
  }

  // Save only when the value actually changed (Enter/blur both land here), then
  // close. The parent trims + persists.
  function commit() {
    setEditing(false);
    if (draft.trim() !== name.trim()) onSave(draft);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        data-no-retime
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
        onBlur={commit}
        placeholder="Name this chain"
        maxLength={100}
        aria-label="Chain name"
        className="min-w-0 flex-1 rounded-lg border border-sage-200 bg-white px-2 py-0.5 text-xs font-medium text-sage-900 focus:border-sage-500 focus:outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      data-no-retime
      onClick={open}
      title="Name this chain"
      aria-label={name ? `Rename chain "${name}"` : "Name this chain"}
      className="group inline-flex min-w-0 items-center gap-1 text-xs font-medium text-sage-600 transition-colors hover:text-sage-800"
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-sage-300 transition-colors group-hover:text-sage-500">
        <PencilIcon />
      </span>
    </button>
  );
}

// The retime gesture for a WHOLE timed chain. Grab the block by its header strip;
// past a small threshold the ephemeral RetimeRuler takes over and the block's
// position on it = its time, until you release. Grabbing the header (not the
// habit rows) leaves the within-block reorder + swipe-to-skip gestures untouched.
// `otherBlocks` give the ruler its context markers and break a same-minute tie on
// drop. Hand-rolled pointer events (like SwipeableCard), not dnd-kit.
function RetimeBlock({
  chainId,
  time,
  blockLabel,
  otherBlocks,
  onRetime,
  header,
  children,
}: {
  chainId: number;
  time: string;
  blockLabel: string;
  otherBlocks: { min: number; name: string }[];
  onRetime: (chainId: number, time: string) => void;
  // The time-label row — becomes the grab handle. Anything inside it that must
  // stay tappable (e.g. the ⏰ shift button) carries data-no-retime.
  header: ReactNode;
  // The block's habit list (PlanBoard) — sits under the ruler while dragging, but
  // keeps its own gestures since the drag only ever starts on the header.
  children: ReactNode;
}) {
  const startY = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  // The press point on screen, so the ruler can anchor the start time to it.
  const [anchorY, setAnchorY] = useState(0);
  // The minute the chain would land on right now (drives the chip + the save).
  const [previewMin, setPreviewMin] = useState<number | null>(null);

  // The block's current time in minutes. Derived from the `time` prop (stable
  // through a drag — no refetch happens until drop), so we never stash it in a
  // ref and read it during render.
  const startMin = timeToMinutes(time);

  function onPointerDown(e: ReactPointerEvent) {
    // A press on a control inside the header (the shift button) isn't a retime.
    if ((e.target as HTMLElement).closest("[data-no-retime]")) return;
    startY.current = e.clientY;
    setPreviewMin(startMin);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: ReactPointerEvent) {
    if (startY.current == null) return;
    const delta = e.clientY - startY.current;
    // Ignore tiny movements so a stray tap on the header doesn't start a retime.
    if (!dragging && Math.abs(delta) < RETIME_DRAG_THRESHOLD) return;
    if (!dragging) {
      setDragging(true);
      setAnchorY(startY.current); // ruler anchors the start time to the press point
    }
    // Down = later, up = earlier — same scale the ruler draws, so the chip tracks
    // the finger. snapRetime rounds to the grid and clamps inside the day.
    setPreviewMin(snapRetime(startMin + delta / RETIME_PX_PER_MIN));
  }

  function onPointerUp() {
    const target = previewMin;
    const moved = dragging;
    startY.current = null;
    setDragging(false);
    setPreviewMin(null);
    // A press without a real drag, or a release back on the start time, writes
    // nothing. (Dropping on the recurring time clears the override — the backend
    // handles that "drag home" case, so we just send the absolute time.)
    if (!moved || target == null || target === startMin) return;
    const taken = otherBlocks.map((b) => b.min);
    onRetime(chainId, minutesToHHMM(avoidRetimeCollision(target, taken)));
  }

  // A cancelled gesture (e.g. the OS steals the pointer) must NOT commit a move.
  function onPointerCancel() {
    startY.current = null;
    setDragging(false);
    setPreviewMin(null);
  }

  return (
    <div className="relative">
      {/* The header strip is the grab handle — a big target. */}
      <div
        aria-label={`Set time for this chain — now ${formatTime(
          time,
        )}. Drag up or down on the ruler to set a new time.`}
        title="Drag up or down to set this chain's time (today only)"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        className="cursor-grab touch-none select-none active:cursor-grabbing"
      >
        {header}
      </div>

      {children}

      {dragging && previewMin != null && (
        <RetimeRuler
          anchorY={anchorY}
          startMin={startMin}
          previewMin={previewMin}
          blockLabel={blockLabel}
          otherBlocks={otherBlocks}
        />
      )}
    </div>
  );
}

// Floating bottom-right controls: "Now" jumps to the current time block (the page
// auto-scrolls there on load, but you can re-center anytime), and "↑" goes back
// to the top. "Now" only shows on today's view, and hides once you're already
// parked on the now block (the same way "↑" hides at the top); "↑" appears once
// you've scrolled down.
function FloatingControls({
  onGoToNow,
  onGoToTop,
  getNowTop,
}: {
  onGoToNow?: () => void;
  onGoToTop: () => void;
  getNowTop?: () => number | null;
}) {
  const [scrolled, setScrolled] = useState(false);
  const [atNow, setAtNow] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 300);
      // We're "at now" once the now block's top sits at/near the viewport top —
      // the analogue of "at top" for the "↑" button. scrollToNow lands the block
      // at the top with a ~24px scroll-mt-6 offset, so a small threshold above
      // that absorbs that gap plus sub-pixel rounding.
      const nowTop = getNowTop?.() ?? null;
      setAtNow(nowTop != null && nowTop <= 80);
    };
    onScroll(); // we may already be scrolled (auto-scroll-to-now ran on load)
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [getNowTop]);

  const showNow = !!onGoToNow && !atNow;
  if (!showNow && !scrolled) return null;

  return (
    <div className="fixed bottom-28 right-6 z-20 flex flex-col items-end gap-2">
      {showNow && (
        <button
          type="button"
          onClick={onGoToNow}
          aria-label="Jump to now"
          className="flex h-10 items-center gap-1.5 rounded-full border border-sage-200 bg-white pl-2.5 pr-3 text-xs font-semibold text-sage-600 shadow-lg transition-colors hover:bg-sage-50"
        >
          <ClockIcon />
          Now
        </button>
      )}
      {scrolled && (
        <button
          type="button"
          onClick={onGoToTop}
          aria-label="Scroll to top"
          className="flex h-10 w-10 items-center justify-center rounded-full border border-sage-200 bg-white text-sage-600 shadow-lg transition-colors hover:bg-sage-50"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 15l7-7 7 7"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

// A bottom-sheet editor for a habit's per-day note. Seeded from the habit's
// current note; Save writes it, Clear empties it, and backdrop / Escape / Cancel
// close without saving. The note is per-DAY (this date's HabitLog), separate
// from the habit's permanent notes on the edit page.
function NoteSheet({
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
        className="animate-backdrop-in absolute inset-0 bg-sage-900/40"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Notes for ${habit.name}`}
        className="animate-sheet-in relative max-h-full w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-6 pb-8 shadow-xl sm:rounded-3xl"
      >
        {/* Grabber — a small affordance that this sheet came up from the bottom. */}
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-sage-200 sm:hidden" />
        <h2 className="font-heading text-2xl text-sage-900">{habit.name}</h2>
        <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-sage-500">
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
                    className="rounded-xl border border-sage-200 bg-white p-3"
                  >
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={3}
                      autoFocus
                      className="w-full resize-none rounded-lg border border-sage-200 bg-white px-3 py-2 text-sm text-sage-900 focus:border-sage-500 focus:outline-none"
                    />
                    {n.shared && (
                      <p className="mt-2 text-[11px] text-sage-500">
                        Shared with {others} other habit
                        {others === 1 ? "" : "s"} — save for…
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="rounded-lg px-3 py-1.5 text-xs font-medium text-sage-600 transition-colors hover:bg-sage-50"
                      >
                        Cancel
                      </button>
                      {n.shared ? (
                        <>
                          <button
                            type="button"
                            onClick={() => saveEdit(n.id, "one")}
                            disabled={editText.trim() === "" || editSaving}
                            className="rounded-lg border border-sage-300 px-4 py-1.5 text-xs font-medium text-sage-700 transition-colors hover:bg-sage-50 disabled:opacity-50"
                          >
                            Just this habit
                          </button>
                          <button
                            type="button"
                            onClick={() => saveEdit(n.id, "all")}
                            disabled={editText.trim() === "" || editSaving}
                            className="rounded-lg bg-sage-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sage-700 disabled:opacity-50"
                          >
                            All {n.habits.length} habits
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => saveEdit(n.id, "one")}
                          disabled={editText.trim() === "" || editSaving}
                          className="rounded-lg bg-sage-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sage-700 disabled:opacity-50"
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
                    className="rounded-xl border border-clay-200 bg-clay-100 p-3"
                  >
                    <p className="text-xs text-sage-700">
                      On {n.habits.length} habits — remove this note…
                    </p>
                    <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded-lg px-3 py-1.5 text-xs font-medium text-sage-600 transition-colors hover:bg-sage-50"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onDelete(n.id, "one");
                          setConfirmDeleteId(null);
                        }}
                        className="rounded-lg border border-sage-300 px-4 py-1.5 text-xs font-medium text-sage-700 transition-colors hover:bg-sage-50"
                      >
                        Just this habit
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onDelete(n.id, "all");
                          setConfirmDeleteId(null);
                        }}
                        className="rounded-lg bg-clay-500 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-clay-600"
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
                  className="flex items-start gap-2 rounded-xl border border-sage-100 bg-sage-50 px-3 py-2"
                >
                  {n.shared && (
                    <span
                      className="mt-0.5 text-sage-400"
                      title={`Shared across ${n.habits.length} habits`}
                    >
                      <SharedNoteIcon />
                    </span>
                  )}
                  <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-sage-800">
                    {n.body}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(n.id);
                      setEditText(n.body);
                    }}
                    className="shrink-0 text-xs font-medium text-sage-500 transition-colors hover:text-sage-700"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => requestDelete(n)}
                    className="shrink-0 text-xs font-medium text-clay-500 transition-colors hover:text-clay-600"
                  >
                    Delete
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-sage-400">
            No notes yet for this day.
          </p>
        )}

        <label className="mt-5 block text-[11px] font-medium uppercase tracking-wide text-sage-500">
          Add a note
        </label>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="How did it go? Why you skipped, how it felt…"
          className="mt-1.5 w-full resize-none rounded-xl border border-sage-200 bg-white px-4 py-3 text-sm text-sage-900 placeholder:text-sage-400 focus:border-sage-500 focus:outline-none"
        />

        {/* Optionally attach the new note to other habits too (write a reflection
            once, share it across everything it's about). This habit is always
            included; these are the extras. */}
        {otherHabits.length > 0 && (
          <div className="mt-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-sage-500">
              Also add to
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {otherHabits.map((h) => {
                const on = alsoHabitIds.includes(h.id);
                return (
                  <button
                    key={h.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setAlsoHabitIds((prev) =>
                        on ? prev.filter((id) => id !== h.id) : [...prev, h.id],
                      )
                    }
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      on
                        ? "border-sage-500 bg-sage-100 text-sage-700"
                        : "border-sage-200 text-sage-500 hover:bg-sage-50"
                    }`}
                  >
                    {h.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-4 py-2.5 text-sm font-medium text-sage-600 transition-colors hover:bg-sage-50"
          >
            Done
          </button>
          <button
            type="button"
            onClick={add}
            disabled={text.trim() === "" || saving}
            className="rounded-xl bg-sage-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-sage-700 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

// A bottom-sheet to create OR edit a routine: set its name and check which
// scheduled habits belong to it. In edit mode it can also delete the routine
// (members are ungrouped, never deleted). `habits` is every scheduled habit with
// its current routine, so we pre-check this routine's members and offer the loose
// (ungrouped) ones to add. Mirrors NoteSheet's overlay/keyboard handling.
function RoutineSheet({
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
        className="animate-backdrop-in absolute inset-0 bg-sage-900/40"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={routine ? `Edit ${routine.name}` : "New routine"}
        className="animate-sheet-in relative max-h-full w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-6 pb-8 shadow-xl sm:rounded-3xl"
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-sage-200 sm:hidden" />
        <h2 className="font-heading text-2xl text-sage-900">
          {routine ? "Edit routine" : "New routine"}
        </h2>
        <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-sage-500">
          A group of habits, done in any order
        </p>

        <label className="mt-4 block text-xs font-medium text-sage-600">
          Name
        </label>
        <input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Morning routine"
          maxLength={100}
          className="mt-1 w-full rounded-lg border border-sage-200 bg-white px-3 py-2 text-sm text-sage-900 focus:border-sage-500 focus:outline-none"
        />

        <p className="mt-4 text-xs font-medium text-sage-600">
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
                        ? "border-sage-300 bg-sage-50 text-sage-900"
                        : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50"
                    }`}
                  >
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${
                        on
                          ? "border-sage-600 bg-sage-600 text-white"
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
            <label className="block text-xs font-medium text-sage-600">
              Chain
            </label>
            <p className="mt-0.5 text-[11px] text-sage-400">
              Move the whole routine to another time block — applied on Save,
              every day from today.
            </p>
            <select
              value={chainId ?? ""}
              disabled={saving}
              onChange={(e) => setChainId(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-sage-200 bg-white px-3 py-2 text-sm text-sage-900 focus:border-sage-500 focus:outline-none disabled:opacity-50"
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
                className="rounded-lg bg-clay-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-clay-700"
              >
                Tap to confirm
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="rounded-lg px-3 py-2 text-xs font-medium text-clay-500 transition-colors hover:bg-clay-100"
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
              className="rounded-lg px-3 py-2 text-sm font-medium text-sage-600 transition-colors hover:bg-sage-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={name.trim() === "" || saving}
              className="rounded-lg bg-sage-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sage-700 disabled:opacity-50"
            >
              {routine ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PlanPage() {
  const [chains, setChains] = useState<Chain[]>([]);
  // The viewed day's notes from the new Note model (GET /days/notes/). Source of
  // truth for notes; grouped onto each habit via notesByHabit below.
  const [dayNotes, setDayNotes] = useState<DayNote[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // The day being viewed (default: today). ◀/▶ move it; we re-fetch /plan/ for
  // the new day and its statuses come from that day's logs.
  const [viewedDate, setViewedDate] = useState(() => startOfDay(new Date()));
  const isViewingToday = isSameDay(viewedDate, new Date());
  // A past day is frozen history — you can't add a habit to it (the recurring
  // add only ever reaches today forward), so the per-cycle "+ Add habit" control
  // is hidden there.
  const isPastDay = viewedDate.getTime() < startOfDay(new Date()).getTime();
  // Used by the per-cycle "+ Add habit" button to open the Add Habit page,
  // carrying which cycle to drop the new habit into.
  const navigate = useNavigate();

  // The day's chosen tier (Roots=1 / Growth=2), the bar every tiered habit is
  // shown + completed at. Defaults to Growth and persists across reloads, so the
  // toggle stays where you left it. A tiered habit shows its highest rung at or
  // below this; one with no qualifying rung is hidden for the day.
  const [dayTier, setDayTier] = useState<number>(
    () => Number(localStorage.getItem("dayTier")) || GROWTH_LEVEL,
  );
  useEffect(() => {
    localStorage.setItem("dayTier", String(dayTier));
  }, [dayTier]);

  // "Main only" view: when on, the plan hides the helper/support habits (a
  // low-energy day where you just want the main ones that matter). Pure display
  // filter — no refetch, nothing logged differently. Persisted like the day-tier.
  const [mainOnly, setMainOnly] = useState(
    () => localStorage.getItem("mainOnly") === "1",
  );
  useEffect(() => {
    localStorage.setItem("mainOnly", mainOnly ? "1" : "0");
  }, [mainOnly]);

  // Where the plan opens (and where the floating control parks you): at "now" (the
  // current time block, the default) or at the top. Set by whichever floating
  // button you last tapped, and persisted — so the app reopens where you left it.
  const [landingPref, setLandingPref] = useState<"now" | "top">(() =>
    localStorage.getItem("planLanding") === "top" ? "top" : "now",
  );
  useEffect(() => {
    localStorage.setItem("planLanding", landingPref);
  }, [landingPref]);

  // Bump to force a re-fetch of the current day (e.g. after a "running late" shift).
  const [reloadToken, setReloadToken] = useState(0);

  // "Apply to future days" — recurring scope for BOTH placement and time edits.
  // OFF by default and intentionally NOT persisted (every reload starts in
  // record-today mode), so a forward edit is always a deliberate, visible choice.
  // Only meaningful while viewing today: forward edits anchor to today, so the
  // toggle hides on any other day. When on, a placement gesture writes a dated
  // Schedule generation and a chain retime writes a dated PlanTime row — the
  // recurring routine from today forward — instead of just today's per-day layer.
  const [applyToFuture, setApplyToFuture] = useState(false);
  // Forward mode only applies on today, defended at three layers: the toggle is
  // only rendered on today (so it can only turn ON there); navigating away
  // drops out of it (the DateNav handlers below call leaveForwardMode, and an
  // effect below force-clears it whenever we're not on today); and every
  // placement routing guard re-checks `applyToFuture && isViewingToday` before
  // taking the forward path, so an edit can never anchor to the wrong day.
  const leaveForwardMode = () => setApplyToFuture(false);

  // Safety net: forward mode can never stay armed while its control is hidden.
  // The toggle only renders on today, so if the viewed day ever stops being
  // today (any path — DateNav, an external date change, a midnight rollover)
  // force forward mode off, so a stale "on" can't survive onto another day.
  useEffect(() => {
    if (!isViewingToday) setApplyToFuture(false);
  }, [isViewingToday]);

  // The clarity gate (Jennifer's #1 rule: nothing silently permanent). When a
  // forward edit is about to stick, we stash a one-line summary + the scope
  // detail (a sentence explaining exactly what does and doesn't change) + the
  // action here and show a confirm dialog. `detail` differs by edit kind —
  // placement ("where the habit sits") vs time ("when this chain runs") — so the
  // message is always honest about scope. null = nothing pending.
  const [pendingForward, setPendingForward] = useState<{
    summary: string;
    detail: string;
    run: () => void;
  } | null>(null);

  // The two scope sentences the clarity gate appends after the one-line summary,
  // so each edit kind reads honestly about what it touches (and leaves alone).
  const PLACEMENT_DETAIL =
    "This changes where the habit sits — not when your chains run. Past days stay exactly as they were.";
  const TIME_DETAIL =
    "This changes when this chain runs — not where any habit sits, and no other chain moves. Past days stay exactly as they were.";

  // The habit order the viewed day loaded with — the target "Reset order"
  // returns to ("back to before" = how the day looked when you opened it).
  const [baselineOrder, setBaselineOrder] = useState<Chain[] | null>(null);

  // The time block happening right now — used to badge it "Now" and to scroll
  // the page there on first load.
  const nowBlockId = useMemo(() => currentBlockId(chains), [chains]);

  // habit id -> that habit's notes for the day. A shared note lands under each
  // habit it's attached to. Built from the new Note model (dayNotes).
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

  // Flat list of every habit on the day, for the note composer's "also add to"
  // picker. A habit lives in one time block, so this is already deduped.
  const allHabits = useMemo(
    () =>
      chains.flatMap((chain) =>
        chain.habits.map((h) => ({ id: h.id, name: h.name })),
      ),
    [chains],
  );

  // Section keys (plan id, or "anytime") that are collapsed to just their time
  // header. Session-only: plain state, so it resets on reload. Default expanded.
  const [collapsedChains, setCollapsedChains] = useState<Set<string>>(
    new Set(),
  );
  // Toggle one section collapsed/expanded. Build a NEW Set so React re-renders.
  function toggleCollapsed(key: string) {
    setCollapsedChains((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // One DOM node per section, so we can scroll the current block into view.
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  // Only auto-scroll once (on first load) — not every time a toggle re-renders.
  const didAutoScroll = useRef(false);
  // Latest plans, mirrored into a ref so a delayed callback (a toast's Undo,
  // fired seconds after the action) reads current state, not a stale closure.
  const chainsRef = useRef(chains);
  useEffect(() => {
    chainsRef.current = chains;
  }, [chains]);

  const toast = useToast();

  // The habit whose per-day note is being edited (null = sheet closed), and
  // whether the "Skip day" confirmation dialog is open.
  const [editingNote, setEditingNote] = useState<Habit | null>(null);
  const [skipDayOpen, setSkipDayOpen] = useState(false);
  // The routine sheet: { mode: "create" } to make a new one, or
  // { mode: "edit", id, name } to manage an existing one; null = closed.
  const [routineSheet, setRoutineSheet] = useState<
    { mode: "create" } | { mode: "edit"; id: number; name: string } | null
  >(null);

  // Every scheduled habit (with its current routine) — the pool the routine
  // sheet picks members from. Unscheduled "Anytime" habits have no Schedule row
  // to tag, so they can't join a routine and are left out.
  const scheduledHabits = useMemo(
    () =>
      chains
        .flatMap((chain) => chain.habits)
        .flatMap((h) =>
          h.schedule_id != null
            ? [
                {
                  scheduleId: h.schedule_id,
                  name: h.name,
                  routineId: h.routine ?? null,
                },
              ]
            : [],
        ),
    [chains],
  );

  // Set a habit's status for today (complete / skip / reset). We update the UI
  // FIRST (optimistic) so it feels instant, then tell the backend. If the
  // request fails we restore the snapshot, so the UI never lies.
  async function setHabitStatus(
    habitId: number,
    status: HabitStatus,
    tier?: number,
  ) {
    const snapshot = chains;
    setChains((prev) => applyStatus(prev, habitId, status, tier));

    try {
      // Send the `tier` for EVERY status (not just completion) so skip / missed /
      // undo target THAT version's row, not the whole habit. Omitting it means the
      // untiered ("whole habit") row, exactly as before.
      const body: {
        status: HabitStatus;
        date?: string;
        tier?: number;
      } = isViewingToday ? { status } : { status, date: toYMD(viewedDate) };
      if (tier != null) body.tier = tier;

      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/habits/${habitId}/log/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Omit date on today so the server stamps its own "today" (its call to
          // make, per the contract); send it only when logging another day.
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw new Error("Request failed");
      // Un-completing a rung optimistically can't know which LOWER rungs were only
      // cascade-shown done (vs. completed in their own right), so reconcile an undo
      // from the server. Complete/skip/missed are exact optimistically — no reload.
      if (status === "PENDING" && tier != null) setReloadToken((t) => t + 1);
    } catch {
      setChains(snapshot);
    }
  }

  // Complete / skip / undo a whole routine block in one tap. The backend fans
  // the status out to every member habit for the viewed day; many habits change
  // at once, so we re-fetch instead of patching each one optimistically.
  async function setRoutineStatus(routineId: number, status: HabitStatus) {
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/routines/${routineId}/log/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isViewingToday ? { status } : { status, date: toYMD(viewedDate) },
          ),
        },
      );
      if (!res.ok) throw new Error("Request failed");
      setReloadToken((token) => token + 1);
    } catch {
      toast("Couldn't update the routine", { variant: "error" });
    }
  }

  // Create a routine from the sheet (name + the habits checked in it). Re-fetch
  // so the new block appears. Returns true so the sheet can close on success.
  async function createRoutine(
    name: string,
    scheduleIds: number[],
  ): Promise<boolean> {
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/routines/create/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, schedules: scheduleIds }),
        },
      );
      if (!res.ok) throw new Error("Request failed");
      setReloadToken((token) => token + 1);
      toast(`Created "${name}"`, { variant: "success" });
      return true;
    } catch {
      toast("Couldn't create the routine", { variant: "error" });
      return false;
    }
  }

  // Save edits from the sheet: rename, then apply membership changes (the sheet
  // diffs checked-vs-current into add/remove). We skip the members call when
  // nothing moved, since the endpoint requires a non-empty change.
  async function saveRoutine(
    routineId: number,
    name: string,
    addIds: number[],
    removeIds: number[],
  ): Promise<boolean> {
    try {
      const editRes = await fetch(
        `${import.meta.env.VITE_API_URL}/routines/${routineId}/edit/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      if (!editRes.ok) throw new Error("Request failed");

      if (addIds.length > 0 || removeIds.length > 0) {
        const memRes = await fetch(
          `${import.meta.env.VITE_API_URL}/routines/${routineId}/members/`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ add: addIds, remove: removeIds }),
          },
        );
        if (!memRes.ok) throw new Error("Request failed");
      }
      setReloadToken((token) => token + 1);
      return true;
    } catch {
      toast("Couldn't save the routine", { variant: "error" });
      return false;
    }
  }

  // Delete a routine — its habits are ungrouped (SET_NULL), not deleted. Close
  // the sheet and re-fetch.
  async function deleteRoutine(routineId: number) {
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/routines/${routineId}/delete/`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      if (!res.ok) throw new Error("Request failed");
      setRoutineSheet(null);
      setReloadToken((token) => token + 1);
      toast("Routine deleted", { variant: "info" });
    } catch {
      toast("Couldn't delete the routine", { variant: "error" });
    }
  }

  // Move a whole routine (all its member habits) into another chain, PERMANENTLY
  // from today — the menu twin of dragging a habit across blocks. Drag can't pick
  // up a routine (it stays put inside its chain by design), so this is how a
  // routine relocates. We KEEP the routine tag (the members stay grouped) and
  // reuse the forward writer, so the move lands every day from today AND is
  // mirrored into a frozen today (arrange_forward's reflect-today) instead of
  // silently skipping the day you're looking at. Members append to the bottom of
  // the target chain with consecutive orders, so the block lands in one piece.
  //
  // `memberScheduleIds` (from the sheet's Save) pins the members to the routine's
  // SAVED membership, so an add/remove made in the same Save is honored. When it's
  // omitted (the Undo path), we fall back to the current routine tag.
  async function moveRoutineToChain(
    routineId: number,
    targetPlanId: number,
    memberScheduleIds?: number[],
  ): Promise<boolean> {
    const current = chainsRef.current;
    const allHabits = current.flatMap((p) => p.habits);
    const members = memberScheduleIds
      ? memberScheduleIds
          .map((sid) => allHabits.find((h) => h.schedule_id === sid))
          .filter((h): h is Habit => h != null)
      : allHabits.filter((h) => h.routine === routineId);
    if (members.length === 0) return false;

    const sourcePlan = current.find(
      (p) => p.id != null && p.habits.some((h) => members.includes(h)),
    );
    const targetPlan = current.find((p) => p.id === targetPlanId);
    if (!targetPlan || targetPlan.id == null) return false;
    if (sourcePlan?.id === targetPlanId) return true; // already there — no-op

    // The target chain AFTER the move: its current habits + the routine members
    // appended (still tagged). forwardItemForMove numbers each member by its
    // index here, so they take consecutive orders at the bottom and read as one
    // block. We send ONLY the moved members; the per-slot forward read drops
    // their old-chain generation automatically, so they leave the source chain.
    const targetAfter = [...targetPlan.habits, ...members];
    const items = members.map((m) =>
      forwardItemForMove(m, targetPlanId, targetAfter, routineId),
    );

    const routineName =
      members.find((m) => m.routine_name)?.routine_name ?? "routine";
    const destLabel =
      targetPlan.name || chainLabel(targetPlan.habits, targetPlan.time);

    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/schedules/arrange-forward/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from_date: toYMD(new Date()), items }),
        },
      );
      if (!res.ok) throw new Error("Request failed");
      setReloadToken((token) => token + 1);
      const backTo = sourcePlan?.id ?? null;
      toast(
        `Moved "${routineName}" to ${destLabel}`,
        backTo != null
          ? {
              action: {
                label: "Undo",
                onClick: () => void moveRoutineToChain(routineId, backTo),
              },
            }
          : undefined,
      );
      return true;
    } catch {
      toast("Couldn't move the routine", { variant: "error" });
      return false;
    }
  }

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

  // The toggle-ON placement writer (fix #3: PER-MOVED-HABIT scope). Sends exactly
  // ONE item — the moved habit's new slot — read off the OPTIMISTIC post-move
  // state, to /schedules/arrange-forward/, anchored to today (from_date defaults
  // to today; we send it explicitly for clarity). `arrange_forward` upserts only
  // that habit's dated generation, so the OTHER habits in the chain keep whatever
  // forward placement they already had — we never rewrite them. On success we
  // re-fetch /plan/ so the day reflects the new generation (today is mirrored
  // even when frozen). On failure we roll the optimistic state back. Placement
  // only — never touches time/status.
  async function persistForward(
    optimisticPlans: Chain[],
    habitId: number,
    targetPlanId: number | null,
    snapshot: Chain[],
  ): Promise<boolean> {
    const item = forwardItemForPlan(optimisticPlans, habitId, targetPlanId);
    if (!item) {
      // The moved habit isn't where we expected in the optimistic state — bail
      // without writing anything rather than send a malformed payload.
      setChains(snapshot);
      return false;
    }
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/schedules/arrange-forward/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from_date: toYMD(new Date()), items: [item] }),
        },
      );
      if (!res.ok) throw new Error("Request failed");
      // The forward write re-projects today (and forward) — re-fetch so row_ids,
      // ordering, and the mirrored-into-today copy all reconcile.
      setReloadToken((token) => token + 1);
      return true;
    } catch {
      setChains(snapshot);
      toast("Couldn't apply that change", { variant: "error" });
      return false;
    }
  }

  // Open the clarity gate for a forward placement: show a placement-only,
  // one-line summary ("... — every day from today") and run the writer only on
  // confirm. Cancel leaves everything untouched (nothing optimistic happened
  // yet). This is the single funnel every toggle-ON gesture passes through.
  // `habitId` + `targetPlanId` name the ONE habit being moved (fix #3): only its
  // forward generation is written; siblings are left alone.
  function confirmForward(
    summary: string,
    optimistic: () => Chain[],
    habitId: number,
    targetPlanId: number | null,
  ) {
    setPendingForward({
      summary,
      detail: PLACEMENT_DETAIL, // placement funnel: never mentions time
      run: () => {
        const snapshot = chainsRef.current;
        const next = optimistic();
        setChains(next);
        void persistForward(next, habitId, targetPlanId, snapshot);
      },
    });
  }

  // Persist a plan's habit order for the VIEWED DAY only (no toast). Optimistic,
  // with a snapshot we restore if the save fails. Shared by a drag and its Undo.
  // Writes the per-day layer via /days/arrange/ — never the recurring template.
  async function postReorder(chainId: number, orderedHabits: Habit[]) {
    if (orderedHabits.length === 0) return;
    const snapshot = chainsRef.current;
    setChains((prev) => applyPlanOrder(prev, chainId, orderedHabits));

    // /days/arrange/ keys on row_id (the day's stable per-row key) and wants the
    // whole list with fresh 1..N orders. A not-yet-saved row (placed this
    // session, no row_id) is sent as a {habit, plan, order} placement instead of
    // an {id: null} move — which the backend rejects — so the reorder persists.
    const items = orderedHabits.map((habit, i) =>
      habit.row_id != null
        ? { id: habit.row_id, order: i + 1 }
        : { habit: habit.id, chain: chainId, order: i + 1 },
    );

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/days/arrange/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: toYMD(viewedDate), items }),
      });
      if (!res.ok) throw new Error("Request failed");
      // A frozen day forks template rows into ScheduleDay rows (new row_ids), so
      // re-fetch /plan/ to pick up the day's real keys + reconcile.
      setReloadToken((token) => token + 1);
    } catch {
      // Don't silently snap back — surface it so a rejected save is visible.
      setChains(snapshot);
      toast("Couldn't reorder — try again", { variant: "error" });
    }
  }

  // Drag entry point: remember the block's order *before* the move, apply it,
  // then offer a one-tap Undo (the app's standard toast pattern, same as retime)
  // that puts the habit back where it was.
  //
  // Forward mode (toggle on) instead routes the within-chain reorder through the
  // clarity gate and the recurring forward-writer — no optimistic move happens
  // until she confirms.
  async function reorderPlan(chainId: number, orderedHabits: Habit[]) {
    if (orderedHabits.length === 0) return;
    if (applyToFuture && isViewingToday) {
      const chainPlan = chains.find((p) => p.id === chainId);
      // fix #3: a within-chain reorder still moves exactly ONE habit. Find it by
      // diffing the new order against the old (the one row whose removal makes
      // the two lists equal) and write only that habit's forward generation —
      // the siblings keep their existing forward placement.
      const movedId = movedHabitId(chainPlan?.habits ?? [], orderedHabits);
      if (movedId == null) return; // no net move (e.g. dropped in place)
      confirmForward(
        `Reorder ${chainLabel(chainPlan?.habits ?? orderedHabits, chainPlan?.time ?? null)} — every day from today`,
        () => applyPlanOrder(chainsRef.current, chainId, orderedHabits),
        movedId,
        chainId,
      );
      return;
    }
    const previousHabits = chains.find((p) => p.id === chainId)?.habits ?? [];
    await postReorder(chainId, orderedHabits);
    if (previousHabits.length === 0) return;
    toast("Habit moved", {
      action: {
        label: "Undo",
        onClick: () => postReorder(chainId, previousHabits),
      },
    });
  }

  // The row being dragged right now (schedule id), so a DragOverlay can render a
  // solid copy that follows your finger — otherwise a row dragged out of its
  // block fades in place and you can't see where you're moving it.
  const [dragId, setDragId] = useState<string | null>(null);

  // Blocks just made with "＋ Add time" that are still empty. Empty blocks are
  // normally filtered out of the render (so historical bare time labels don't
  // show), but a brand-new one must stay visible so you can drag a habit into
  // it. Once it has a habit it survives on its own; this set only keeps the
  // empty window open. Also drives the inline add-time input.
  const [newPlanIds, setNewPlanIds] = useState<Set<number>>(() => new Set());
  const [addingTime, setAddingTime] = useState(false);
  const [newTime, setNewTime] = useState("");
  // Keep a block if it has habits OR it's a freshly-added (still-empty) one.
  const keepBlock = (chain: Chain) =>
    chain.habits.length > 0 || (chain.id != null && newPlanIds.has(chain.id));

  // One shared drag context spans every block (lifted out of PlanBoard) so a row
  // can be dragged from one time block into another.
  const planSensors = useSensors(
    // Mouse: a tiny 6px threshold so a plain click still toggles / opens detail.
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // Touch: press-and-HOLD ~450ms (close to native iOS) to pick a row up. Any
    // finger movement over `tolerance` (5px) before the delay elapses keeps it a
    // scroll, so it never grabs a habit by accident — the standard mobile gesture.
    useSensor(TouchSensor, {
      activationConstraint: { delay: 450, tolerance: 5 },
    }),
  );

  // The loose, movable rows of a block — the same subset PlanBoard makes
  // draggable: shown inline for the day, not main-only-hidden, not done, not
  // routine-grouped. Done/routine/hidden rows keep their spot and never move.
  const activeRowsOf = (habits: Habit[]) =>
    habits.filter(
      (h) =>
        slotPlacement(h, inlineTierByHabit, dayTier) === "inline" &&
        (!mainOnly || !h.is_support) &&
        !isDone(h) &&
        h.routine == null,
    );

  // Fire-and-forget POST of an explicit items list to /days/arrange/ for the
  // viewed day. Returns ok; the caller owns optimistic state + rollback. Writes
  // the per-day layer only — never the recurring template.
  async function persistItems(
    items: Array<Record<string, number | null>>,
  ): Promise<boolean> {
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/days/arrange/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: toYMD(viewedDate), items }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // Move one row (`rid` = its row_id) out of `fromChain` into `toChain` for the
  // viewed day only, dropping its routine (a same-block tag) and
  // landing it before `overRid` (or at the end when dropped on empty block
  // space). Persists BOTH blocks in one /days/arrange/ batch, optimistic with
  // rollback, and offers an Undo that puts it back.
  async function moveAcrossBlocks(
    fromChain: Chain,
    toChain: Chain,
    rid: number,
    overRid: number | null,
  ) {
    if (fromChain.id == null || toChain.id == null) return;
    const moved = fromChain.habits.find((h) => h.row_id === rid);
    if (!moved) return;

    const snapshot = chainsRef.current;
    const origFrom = fromChain.habits;
    const origTo = toChain.habits;

    const newFrom = origFrom.filter((h) => h.row_id !== rid);
    const movedNew: Habit = { ...moved, routine: null };
    const at =
      overRid != null ? origTo.findIndex((h) => h.row_id === overRid) : -1;
    const idx = at >= 0 ? at : origTo.length;
    const newTo = [...origTo.slice(0, idx), movedNew, ...origTo.slice(idx)];

    // Forward mode: route the cross-chain move through the clarity gate + the
    // recurring forward-writer. fix #3: only the MOVED habit (`rid` -> habit
    // `moved.id`) gets a forward generation, landing in the target chain. The
    // source chain's siblings and the target chain's siblings keep their existing
    // forward placement — we don't renumber either. No optimistic move until she
    // confirms.
    if (applyToFuture && isViewingToday) {
      const fromId = fromChain.id;
      const toId = toChain.id;
      confirmForward(
        `Move "${moved.name}" into ${chainLabel(toChain.habits, toChain.time)} — every day from today`,
        () =>
          chainsRef.current.map((p) =>
            p.id === fromId
              ? {
                  ...p,
                  habits: newFrom.map((h, i) => ({ ...h, order: i + 1 })),
                }
              : p.id === toId
                ? {
                    ...p,
                    habits: newTo.map((h, i) => ({ ...h, order: i + 1 })),
                  }
                : p,
          ),
        moved.id,
        toId,
      );
      return;
    }

    setChains((prev) =>
      prev.map((p) =>
        p.id === fromChain.id
          ? { ...p, habits: newFrom.map((h, i) => ({ ...h, order: i + 1 })) }
          : p.id === toChain.id
            ? { ...p, habits: newTo.map((h, i) => ({ ...h, order: i + 1 })) }
            : p,
      ),
    );

    const items = [
      ...newFrom.map((h, i) => ({ id: h.row_id ?? null, order: i + 1 })),
      ...newTo.map((h, i) =>
        h.row_id === rid
          ? { id: rid, order: i + 1, chain: toChain.id, routine: null }
          : { id: h.row_id ?? null, order: i + 1 },
      ),
    ];
    const ok = await persistItems(items);
    if (!ok) {
      setChains(snapshot);
      toast("Couldn't move that habit", { variant: "error" });
      return;
    }
    // A frozen day reassigns row_ids (template -> ScheduleDay); re-fetch /plan/
    // so the optimistic rows pick up the day's real keys.
    setReloadToken((token) => token + 1);

    toast("Habit moved", {
      action: {
        label: "Undo",
        onClick: () => {
          setChains(snapshot);
          // Put the row back in its old block, time, and routine tag.
          persistItems([
            ...origFrom.map((h, i) =>
              h.row_id === rid
                ? {
                    id: rid,
                    order: i + 1,
                    chain: fromChain.id,
                    routine: h.routine ?? null,
                  }
                : { id: h.row_id ?? null, order: i + 1 },
            ),
            ...origTo.map((h, i) => ({ id: h.row_id ?? null, order: i + 1 })),
          ]).then(() => setReloadToken((token) => token + 1));
        },
      },
    });
  }

  // Place an Anytime habit onto a real block FOR THE VIEWED DAY, AT THE DROP
  // POSITION. We send the WHOLE target chain to /days/arrange/ with fresh 1..N
  // orders — the placed habit as a {habit, plan, order} placement, the siblings
  // as {id, order} moves — so it lands exactly where it was dropped (before
  // `beforeRowId`, or appended when that's null) and never collides with a
  // sibling's order. Optimistic, then re-fetch /plan/ to pick up the new row_id.
  async function placeHabit(
    habitId: number,
    chainId: number,
    beforeRowId: number | null = null,
  ) {
    const snapshot = chainsRef.current;
    // The optimistic move: pull the habit out of Anytime and insert it into the
    // target chain at the drop position. Shared by both scopes (per-day below,
    // forward via the gate).
    const moveOut = (chains: Chain[]): Chain[] => {
      const habit = chains
        .find((p) => p.id == null)
        ?.habits.find((h) => h.id === habitId);
      if (!habit) return chains;
      const placed: Habit = { ...habit, routine: null };
      return chains.map((p) => {
        if (p.id == null)
          return { ...p, habits: p.habits.filter((h) => h.id !== habitId) };
        if (p.id !== chainId) return p;
        const at =
          beforeRowId != null
            ? p.habits.findIndex((h) => h.row_id === beforeRowId)
            : -1;
        const idx = at >= 0 ? at : p.habits.length;
        return {
          ...p,
          habits: [...p.habits.slice(0, idx), placed, ...p.habits.slice(idx)],
        };
      });
    };

    // Forward mode: confirm, then write ONLY the placed habit's forward
    // generation (fix #3) — at its drop-position order; the chain's existing
    // members keep their forward placement, we don't renumber them.
    if (applyToFuture && isViewingToday) {
      const habit = snapshot
        .find((p) => p.id == null)
        ?.habits.find((h) => h.id === habitId);
      const targetPlan = snapshot.find((p) => p.id === chainId);
      if (!habit || !targetPlan) return;
      confirmForward(
        `Move "${habit.name}" into ${chainLabel(targetPlan.habits, targetPlan.time)} — every day from today`,
        () => moveOut(chainsRef.current),
        habitId,
        chainId,
      );
      return;
    }

    // Per-day: optimistic insert, then persist the whole target chain's order so
    // the drop position sticks (the placed habit as a placement, the siblings as
    // ordered moves).
    const next = moveOut(snapshot);
    setChains(next);
    const block = next.find((p) => p.id === chainId);
    const items = (block?.habits ?? []).map(
      (h, i): Record<string, number | null> => {
        if (h.row_id == null)
          return { habit: h.id, chain: chainId, order: i + 1 };
        // An existing row in this block; force the placed habit's plan so it
        // actually moves in even if it already had a row elsewhere (Anytime).
        return h.id === habitId
          ? { id: h.row_id, order: i + 1, chain: chainId, routine: null }
          : { id: h.row_id, order: i + 1 };
      },
    );
    const ok = await persistItems(items);
    if (!ok) {
      setChains(snapshot);
      toast("Couldn't place that habit", { variant: "error" });
      return;
    }
    // The freeze assigns the new row its row_id; re-fetch to reconcile.
    setReloadToken((token) => token + 1);
    toast("Habit placed");
  }

  // "＋ Add time": make an empty time block (or reuse the one already at that
  // time) so you can drag a habit into it. Drops the new block into state in time
  // order and keeps it visible while empty (newPlanIds).
  async function addTime(timeStr: string) {
    if (!timeStr) return;
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/chains/create/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ time: timeStr }),
        },
      );
      if (!res.ok) throw new Error("Request failed");
      const data = await res.json(); // { id, time, created }
      setNewPlanIds((prev) => new Set(prev).add(data.id));
      setChains((prev) => {
        if (prev.some((p) => p.id === data.id)) return prev; // reused an existing block
        const block: Chain = {
          id: data.id,
          time: data.time,
          name: "",
          habits: [],
        };
        const timed = prev.filter((p) => p.id != null);
        const anytime = prev.filter((p) => p.id == null);
        const merged = [...timed, block].sort(
          (a, b) => timeToMinutes(a.time ?? "") - timeToMinutes(b.time ?? ""),
        );
        return [...merged, ...anytime];
      });
    } catch {
      toast("Couldn't add that time", { variant: "error" });
    }
  }

  // The page-level drop handler. The dragged id is a row_id (stable across the
  // template->frozen flip); the drop target is either another row (its row_id)
  // or a block's empty space (`plan-<id>`). Same block -> reorder; different
  // block -> move across. Both write the per-day layer via /days/arrange/.
  function handlePlanDragEnd(event: DragEndEvent) {
    setDragId(null); // drop finished — tear down the overlay
    const { active, over } = event;
    if (!over) return;

    // The dragged row is either a numeric row_id (already on the timeline) or
    // "new-<habitId>" — an Anytime habit with no row yet.
    const rawActive = String(active.id);
    const newHabitId = rawActive.startsWith("new-")
      ? Number(rawActive.slice("new-".length))
      : null;
    const activeRid = newHabitId == null ? Number(active.id) : null;

    // Which block was it dropped on? A block's empty space ("plan-<id>" /
    // "plan-anytime"), another timed row (its row_id), or an Anytime row.
    let overRid: number | null = null;
    let targetPlanId: number | null = null;
    const rawOver = String(over.id);
    if (rawOver.startsWith("plan-")) {
      const raw = rawOver.slice("plan-".length);
      targetPlanId = raw === "anytime" ? null : Number(raw);
    } else if (rawOver.startsWith("new-")) {
      targetPlanId = null; // dropped onto an Anytime row -> the Anytime group
    } else {
      overRid = Number(over.id);
      targetPlanId =
        chains.find(
          (p) => p.id != null && p.habits.some((h) => h.row_id === overRid),
        )?.id ?? null;
    }

    // Placing a habit out of Anytime onto a real block, at the drop position
    // (`overRid` = the row it landed on, or null when dropped on empty space).
    if (newHabitId != null) {
      if (targetPlanId != null) placeHabit(newHabitId, targetPlanId, overRid);
      return; // anytime -> anytime is a no-op
    }

    // An existing timed row. Dragging it back to Anytime (removing its time)
    // isn't built yet, so ignore that drop for now.
    if (targetPlanId == null || activeRid == null) return;

    const sourcePlan = chains.find(
      (p) => p.id != null && p.habits.some((h) => h.row_id === activeRid),
    );
    if (!sourcePlan || sourcePlan.id == null) return;

    if (sourcePlan.id === targetPlanId) {
      // Within-block reorder — rebuild the full list keeping non-active rows put.
      if (overRid == null || activeRid === overRid) return;
      const active2 = activeRowsOf(sourcePlan.habits);
      const from = active2.findIndex((h) => h.row_id === activeRid);
      const to = active2.findIndex((h) => h.row_id === overRid);
      if (from < 0 || to < 0) return;
      const newActive = arrayMove(active2, from, to);
      let next = 0;
      const newFull = sourcePlan.habits.map((h) =>
        slotPlacement(h, inlineTierByHabit, dayTier) !== "inline" ||
        (mainOnly && h.is_support) ||
        isDone(h) ||
        h.routine != null
          ? h
          : newActive[next++],
      );
      reorderPlan(sourcePlan.id, newFull);
    } else {
      const targetPlan = chains.find((p) => p.id === targetPlanId);
      if (!targetPlan) return;
      moveAcrossBlocks(sourcePlan, targetPlan, activeRid, overRid);
    }
  }

  // Reorder every schedulable plan to match a template's order, mapping the
  // CURRENT habit objects (so statuses/notes set since aren't clobbered) onto
  // the template's id order. Persists only the plans that actually changed.
  async function applyOrderTemplate(template: Chain[]) {
    for (const chain of chainsRef.current) {
      if (chain.id == null) continue; // "Anytime" has no schedule rows to order
      const tpl = template.find((p) => p.id === chain.id);
      if (!tpl) continue;
      const order = tpl.habits.map((h) => h.id);
      const reordered = [...chain.habits].sort(
        (a, b) => order.indexOf(a.id) - order.indexOf(b.id),
      );
      const changed = reordered.some((h, i) => h.id !== chain.habits[i].id);
      if (changed) await postReorder(chain.id, reordered);
    }
  }

  // "Reset order": return the whole day to the order it loaded with ("be like
  // before"), with its own Undo back to the pre-reset arrangement.
  async function resetOrder() {
    const baseline = baselineOrder;
    if (!baseline) return;
    const beforeReset = chainsRef.current;
    await applyOrderTemplate(baseline);
    toast("Order reset", {
      action: {
        label: "Undo",
        onClick: () => applyOrderTemplate(beforeReset),
      },
    });
  }

  // Has the user reordered anything away from the day's load-time order? Drives
  // whether the "Reset order" control shows. Recomputes with plans; the baseline
  // ref only changes alongside a fetch (which also updates plans).
  const orderChanged = useMemo(() => {
    const baseline = baselineOrder;
    if (!baseline) return false;
    return chains.some((chain) => {
      if (chain.id == null) return false;
      const tpl = baseline.find((p) => p.id === chain.id);
      if (!tpl) return false;
      const now = chain.habits.map((h) => h.id);
      const was = tpl.habits.map((h) => h.id);
      return now.length !== was.length || now.some((id, i) => id !== was[i]);
    });
  }, [chains, baselineOrder]);

  useEffect(() => {
    async function fetchPlan() {
      setIsLoading(true);
      setError("");

      // Omit ?date on today (identical to the original behaviour); pass it only
      // when browsing another day.
      const today = isSameDay(viewedDate, new Date());
      const suffix = today ? "" : `?date=${toYMD(viewedDate)}`;
      const url = `${import.meta.env.VITE_API_URL}/plan/${suffix}`;
      const notesUrl = `${import.meta.env.VITE_API_URL}/days/notes/${suffix}`;

      try {
        // /plan/ and /days/notes/ are independent reads for the same day — fetch
        // them together so notes don't add a serial round-trip.
        const [res, notesRes] = await Promise.all([
          fetch(url, { method: "GET", headers: {} }),
          fetch(notesUrl, { method: "GET", headers: {} }),
        ]);

        const data: Chain[] = await res.json();
        if (!res.ok) {
          setError((data as unknown as { error?: string }).error ?? "");
          return;
        }

        // A frozen /plan/ now returns the day's never-placed unscheduled habits in
        // the Anytime group itself (see habits/views.plan), so the screen matches a
        // fresh GET every time — no client-side re-attach needed, and a refresh is
        // truthful on its own.
        setChains(data);
        // The order this day loaded with — what "Reset order" returns to.
        setBaselineOrder(data);

        // Notes are additive: if the endpoint isn't live yet or errors, fall back
        // to the legacy per-habit string by clearing the new-model notes.
        setDayNotes(notesRes.ok ? await notesRes.json() : []);
      } catch (error) {
        setError(
          error instanceof Error ? error.message : "An unknown error occurred",
        );
      } finally {
        setIsLoading(false);
      }
    }
    fetchPlan();
    // Re-runs when the viewed day changes, or reloadToken is bumped (e.g. after
    // a "running late" shift) to pull the day's new effective times.
  }, [viewedDate, reloadToken]);

  // "Running late": push a chain (and everything after it that day) to a later
  // time — negative minutes pulls it earlier. The backend stores a per-day
  // override, never touching the recurring routine. We re-fetch afterward
  // because /plan/ returns the day's new effective times, already re-sorted.
  async function shiftFromPlan(chainId: number, minutes: number) {
    const today = isSameDay(viewedDate, new Date());
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/chains/shift/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          today
            ? { from_chain: chainId, minutes }
            : { from_chain: chainId, minutes, date: toYMD(viewedDate) },
        ),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Couldn't shift the day");
      }
      setReloadToken((token) => token + 1); // re-fetch the day's new times
    } catch (err) {
      // The shift didn't apply (nothing to roll back) — surface why, since this
      // used to fail silently.
      toast(err instanceof Error ? err.message : "Couldn't shift the day", {
        variant: "error",
      });
    }
  }

  // POST one chain's new absolute time (a per-day override, like the shift, no
  // cascade) and re-fetch the day — /plan/ returns the new effective times,
  // already re-sorted, so we don't hand-apply. Returns true on success; shared by
  // a drag and by its Undo.
  async function postRetime(chainId: number, time: string): Promise<boolean> {
    const today = isSameDay(viewedDate, new Date());
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/chains/retime/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            today
              ? { chain: chainId, time }
              : { chain: chainId, time, date: toYMD(viewedDate) },
          ),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Couldn't move that chain");
      }
      setReloadToken((token) => token + 1); // re-fetch the day's new times
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't move that chain", {
        variant: "error",
      });
      return false;
    }
  }

  // POST one chain's new absolute time PERMANENTLY from today forward (a dated
  // PlanTime row) and re-fetch — /plan/ returns the new effective times (today is
  // mirrored even when frozen), already re-sorted. The forward-time twin of
  // postRetime; writes ONLY this chain's time, never any placement.
  async function postRetimeForward(chainId: number, time: string) {
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/chains/retime-forward/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // from_date defaults to today server-side; send it explicitly for clarity.
          body: JSON.stringify({
            chain: chainId,
            time,
            from_date: toYMD(new Date()),
          }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Couldn't move that chain");
      }
      setReloadToken((token) => token + 1); // re-fetch the day's new times
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't move that chain", {
        variant: "error",
      });
    }
  }

  // Drag handler: remember the block's time *before* the move, apply it, then
  // offer a one-tap Undo (the app's standard toast pattern, same as Skip day)
  // that puts it back. When there was no override, the previous effective time IS
  // the recurring time — so undoing all the way home clears the override.
  //
  // Forward mode (toggle on, on today): instead of a per-day override, route the
  // retime through the clarity gate and the recurring forward-writer so the new
  // time sticks every day from today. Time-only — never touches placement, and
  // (unlike shift) only THIS chain moves. No optimistic move until she confirms.
  async function retimePlan(chainId: number, time: string) {
    if (applyToFuture && isViewingToday) {
      const chainPlan = chains.find((p) => p.id === chainId);
      const label =
        chainPlan?.name ||
        chainLabel(chainPlan?.habits ?? [], chainPlan?.time ?? null);
      setPendingForward({
        summary: `Move ${label} to ${formatTime(time)} — every day from today`,
        detail: TIME_DETAIL,
        run: () => void postRetimeForward(chainId, time),
      });
      return;
    }
    const previousTime = chains.find((p) => p.id === chainId)?.time ?? null;
    const ok = await postRetime(chainId, time);
    if (!ok || previousTime == null) return;
    toast(`Moved to ${formatTime(time)}`, {
      action: {
        label: "Undo",
        onClick: () => postRetime(chainId, previousTime),
      },
    });
  }

  // Name (or rename/clear) a timed chain. Optimistic: drop the trimmed name into
  // the block right away, then reconcile from the 200's saved name (the backend
  // trims/echoes it). On failure, restore the snapshot and toast. Only timed
  // blocks reach here — the "Anytime" group has no endpoint.
  async function renamePlan(chainId: number, name: string) {
    const trimmed = name.trim();
    const snapshot = chainsRef.current;
    setChains((prev) =>
      prev.map((p) => (p.id === chainId ? { ...p, name: trimmed } : p)),
    );
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/chains/${chainId}/name/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        },
      );
      if (!res.ok) throw new Error("Request failed");
      const data = await res.json(); // { id, name }
      setChains((prev) =>
        prev.map((p) =>
          p.id === chainId ? { ...p, name: data.name ?? "" } : p,
        ),
      );
    } catch {
      setChains(snapshot);
      toast("Couldn't rename that chain", { variant: "error" });
    }
  }

  // Reset a day's per-day adjustments (skips + running-late shifts) back to
  // default, keeping completions and notes. Powers the "Undo" on the skip toast.
  // Takes the date explicitly so Undo targets the day that was skipped even if
  // the user has since navigated away.
  async function clearDay(date: Date) {
    const today = isSameDay(date, new Date());
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/days/clear/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(today ? {} : { date: toYMD(date) }),
      });
      if (!res.ok) throw new Error("Request failed");
      setReloadToken((token) => token + 1);
    } catch {
      toast("Couldn't undo — try again", { variant: "error" });
    }
  }

  // Skip every habit for the viewed day in one go (e.g. you're out of town).
  // The backend keeps anything already completed; we re-fetch to show the result
  // and offer an Undo (which clears the day back to default).
  async function confirmSkipDay() {
    setSkipDayOpen(false);
    const skippedDate = viewedDate;
    const today = isSameDay(skippedDate, new Date());
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/days/skip/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(today ? {} : { date: toYMD(skippedDate) }),
      });
      if (!res.ok) throw new Error("Request failed");
      setReloadToken((token) => token + 1); // re-fetch to show everything skipped
      toast("All habits skipped for this day", {
        action: { label: "Undo", onClick: () => clearDay(skippedDate) },
      });
    } catch {
      toast("Couldn't skip the day", { variant: "error" });
    }
  }

  // After the first load, open the page where you last left the floating control:
  // at the time block happening now (default), or at the top — so "now" users land
  // on their current habits, and "top" users start at the beginning of the day.
  useEffect(() => {
    if (didAutoScroll.current || isLoading || chains.length === 0) return;
    // "top" preference: nothing to scroll — the page already loads at the top.
    if (landingPref === "top") {
      didAutoScroll.current = true;
      return;
    }
    // "Now" only means anything on today's view.
    if (!isViewingToday || nowBlockId == null) return;
    const el = sectionRefs.current[String(nowBlockId)];
    if (el) {
      el.scrollIntoView({ block: "start" });
      didAutoScroll.current = true;
    }
  }, [chains, isLoading, nowBlockId, isViewingToday, landingPref]);

  // Re-center on the current time block (the "Now" button).
  function scrollToNow() {
    if (nowBlockId == null) return;
    sectionRefs.current[String(nowBlockId)]?.scrollIntoView({
      block: "start",
      behavior: "smooth",
    });
  }

  // A past day can come back with fewer habits (ones added later didn't exist
  // yet), and a time block can be empty — skip empty blocks so we don't render
  // a bare time label with nothing under it.
  // Drop empty blocks, and attach each habit's day-notes (from the new Note
  // model) so the row components can read habit.dayNotes the way they read
  // habit.notes today — no extra prop threading through the tree.
  const visibleChains = useMemo(
    () =>
      chains.filter(keepBlock).map((chain) => ({
        ...chain,
        habits: chain.habits.map((habit) => ({
          ...habit,
          dayNotes: notesByHabit.get(habit.id) ?? [],
        })),
      })),
    [chains, notesByHabit, newPlanIds],
  );

  // habit id -> the highest Case-A tier-slot level (h.tier, the non-null ones)
  // that is <= dayTier, or null when none qualify. This picks which of a habit's
  // several tier-slots is its "today" version: the one that renders inline, while
  // lower slots are cascade-hidden and higher ones stretch. Untiered + Case-B
  // rows aren't in here (they carry no per-slot tier); slotPlacement handles them.
  const inlineTierByHabit = useMemo(() => {
    const byHabit = new Map<number, number[]>();
    for (const chain of visibleChains)
      for (const h of chain.habits)
        if (h.tier != null) {
          const a = byHabit.get(h.id) ?? [];
          a.push(h.tier);
          byHabit.set(h.id, a);
        }
    const inline = new Map<number, number | null>();
    for (const [hid, tiers] of byHabit) {
      const ok = tiers.filter((t) => t <= dayTier);
      inline.set(hid, ok.length ? Math.max(...ok) : null);
    }
    return inline;
  }, [visibleChains, dayTier]);

  // The same plans, but keeping only the rows that render INLINE for the day:
  // untiered rows, each habit's one Case-A slot at its highest tier <= today, and
  // a Case-B row with a rung <= today. Stretch/hidden slots are dropped; any chain
  // thereby emptied is removed. This is what we COUNT and decide emptiness from, so
  // headers, the skip-day logic, and the empty state all match what the cards
  // render. PlanBoard still gets the FULL `visibleChains` list (it filters for
  // display itself) so a reorder never drops a hidden habit from state — only what
  // shows is affected, never what's stored.
  const tierVisibleChains = useMemo(
    () =>
      visibleChains
        .map((chain) => ({
          ...chain,
          habits: chain.habits.filter(
            (habit) =>
              slotPlacement(habit, inlineTierByHabit, dayTier) === "inline",
          ),
        }))
        .filter(keepBlock),
    [visibleChains, inlineTierByHabit, dayTier, newPlanIds],
  );

  // What actually renders: the tier-visible plans, further narrowed to main
  // habits when "Main only" is on (empty groups dropped). A pure view filter
  // layered on top of the tier filter — the skip-day/empty logic below still uses
  // the full `tierVisibleChains`, so the toggle never changes what's stored.
  const shownChains = useMemo(
    () =>
      !mainOnly
        ? tierVisibleChains
        : tierVisibleChains
            .map((chain) => ({
              ...chain,
              habits: chain.habits.filter((habit) => !habit.is_support),
            }))
            .filter(keepBlock),
    [tierVisibleChains, mainOnly, newPlanIds],
  );

  // The "Stretch" section: harder versions she can opt into. Two sources, in plan
  // order: (1) Case-A slots that placed as "stretch" (a tier above today that lives
  // at its own time), each completed at its own `tier`; (2) synthesized entries for
  // every Case-B rung ABOVE today (level > dayTier) — same habit, that rung's value,
  // completed at that level. `level` is the tier each card shows + sends. Honors
  // "Main only" like the inline groups.
  const stretchSlots = useMemo(() => {
    const out: { habit: Habit; level: number }[] = [];
    for (const chain of visibleChains) {
      for (const habit of chain.habits) {
        if (mainOnly && habit.is_support) continue;
        if (habit.tier != null) {
          // Case A: this slot stretches when it's a harder tier than today.
          if (slotPlacement(habit, inlineTierByHabit, dayTier) === "stretch")
            out.push({ habit, level: habit.tier });
        } else if (isCaseB(habit)) {
          // Case B: one synthesized "do more" card per rung above what the inline
          // card already shows — i.e. above the highest DONE rung (so a completed
          // harder rung isn't also listed as a stretch), or above today when
          // nothing's done yet.
          const done = highestDoneLevel(habit);
          const covered = done != null ? Math.max(dayTier, done) : dayTier;
          for (const t of habit.tiers ?? [])
            if (t.level > covered) out.push({ habit, level: t.level });
        }
      }
    }
    return out;
  }, [visibleChains, inlineTierByHabit, dayTier, mainOnly]);

  // Has the whole day been skipped? (every habit resolved to skipped or done,
  // with at least one skip). If so, the day-level control flips from "Skip day"
  // to a persistent "Reset day" undo — so you can un-skip even after the toast
  // has faded, not just in the few seconds it's on screen.
  const anySkipped = tierVisibleChains.some((chain) =>
    chain.habits.some((habit) => isSkipped(habit)),
  );
  const dayFullySkipped =
    anySkipped &&
    tierVisibleChains.every((chain) =>
      chain.habits.every((habit) => isSkipped(habit) || isDone(habit)),
    );

  // Has this day been rearranged into a per-day ("frozen") arrangement? On a
  // frozen day each placed habit comes from the ScheduleDay layer, so it has a
  // row_id (the copy) but no schedule_id (the template row). "Anytime" habits
  // have BOTH null, so they don't count. If any visible scheduled habit looks
  // like that, the day has something to reset even when nothing was skipped.
  const dayHasArrangement = tierVisibleChains.some((chain) =>
    chain.habits.some(
      (habit) => habit.schedule_id == null && habit.row_id != null,
    ),
  );

  let body: ReactNode;
  if (isLoading && chains.length === 0) {
    // First load only — when switching days we keep the current list visible
    // (dimmed) instead of flashing a spinner.
    body = <LoadingSpinner label="habits" />;
  } else if (error) {
    body = <ErrorBanner error={error} />;
  } else if (chains.length === 0) {
    body = (
      <EmptyState
        title="No habits yet"
        subtitle="Create your first habit to push your limits"
      />
    );
  } else if (tierVisibleChains.length === 0 && stretchSlots.length === 0) {
    // plans isn't empty here, so it's a day with nothing scheduled.
    body = (
      <EmptyState
        title="Nothing this day"
        subtitle="No habits were scheduled for this day"
      />
    );
  } else {
    const draggingHabit =
      dragId != null
        ? (shownChains
            .flatMap((p) => p.habits)
            .find((h) =>
              dragId.startsWith("new-")
                ? h.id === Number(dragId.slice("new-".length))
                : h.row_id === Number(dragId),
            ) ?? null)
        : null;
    body = (
      <>
        <DndContext
          sensors={planSensors}
          collisionDetection={closestCorners}
          onDragStart={(e) => setDragId(String(e.active.id))}
          onDragCancel={() => setDragId(null)}
          onDragEnd={handlePlanDragEnd}
        >
          <div
            className={`space-y-6 ${isLoading ? "opacity-60 transition-opacity" : ""}`}
          >
            {shownChains.map((chain) => {
              const key = chain.id ?? "anytime";
              const isNow =
                isViewingToday && chain.id != null && chain.id === nowBlockId;
              // Session-only collapse: hide this chain's habit list and show just
              // its time + progress in the header. Default expanded.
              const collapsed = collapsedChains.has(String(key));
              // Progress for the collapsed header — a member counts as handled when
              // it's done OR skipped (same rule RoutineBlock uses). Counts the
              // shown habits, so the header matches the cards (a Roots day excludes
              // hidden Growth; "Main only" excludes the helpers).
              const total = chain.habits.length;
              const handled = chain.habits.filter(
                (h) => isDone(h) || isSkipped(h),
              ).length;
              // PlanBoard renders from the FULL plan (all this chain's habits, hidden
              // ones included) and does its own tier filtering for display — so a
              // reorder rebuilds the whole list and never drops a hidden habit from
              // state. Fall back to the tier-filtered `plan` if no full match (can't
              // happen, but keeps the type non-null).
              const fullChain =
                visibleChains.find((p) => p.id === chain.id) ?? chain;
              // The habit list is identical whether or not the block is retime-able;
              // build it once and drop it into the right wrapper below. Drag the grip
              // to reorder, swipe a card left to skip, tap the circle to complete,
              // tap the note icon to jot a day note; completed ones collapse in place.
              const planBoard = (
                <PlanBoard
                  chain={fullChain}
                  dayTier={dayTier}
                  inlineTierByHabit={inlineTierByHabit}
                  mainOnly={mainOnly}
                  onStatus={setHabitStatus}
                  onOpenNote={setEditingNote}
                  onRoutineLog={setRoutineStatus}
                  onEditRoutine={(id, name) =>
                    setRoutineSheet({ mode: "edit", id, name })
                  }
                  // Drag works on any viewed day — it writes the per-day layer
                  // (/days/arrange/), not the recurring template.
                  interactive
                />
              );
              return (
                <section
                  key={key}
                  ref={(el) => {
                    sectionRefs.current[String(key)] = el;
                  }}
                  // Leave a little breathing room above the block when we scroll to it.
                  className="scroll-mt-6"
                >
                  {chain.id != null && chain.time ? (
                    // Timed chain: the whole block is the unit you retime — grab the
                    // header strip and it lifts to a new time. OFF = today only; with
                    // "Apply to future days" ON it sticks every day from today.
                    <RetimeBlock
                      chainId={chain.id}
                      time={chain.time}
                      blockLabel={
                        chain.name || chainLabel(chain.habits, chain.time)
                      }
                      otherBlocks={visibleChains.flatMap((p) =>
                        p.id !== chain.id && p.time
                          ? [
                              {
                                min: timeToMinutes(p.time),
                                name: p.name || chainLabel(p.habits, p.time),
                              },
                            ]
                          : [],
                      )}
                      onRetime={retimePlan}
                      header={
                        <div className="flex items-center gap-3 mb-2">
                          {/* Collapse/expand this chain. Carries data-no-retime so
                          tapping it toggles instead of starting a time-drag. */}
                          <button
                            type="button"
                            data-no-retime
                            onClick={() => toggleCollapsed(String(key))}
                            aria-expanded={!collapsed}
                            aria-label={
                              collapsed
                                ? `Expand ${formatTime(chain.time)}`
                                : `Collapse ${formatTime(chain.time)}`
                            }
                            className="shrink-0 text-sage-400 transition-colors hover:text-sage-600"
                          >
                            <ChevronIcon open={!collapsed} />
                          </button>
                          {/* Time label + a drag hint; the whole strip is grabbable. */}
                          <span
                            className={`inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide ${
                              isNow ? "text-sage-700" : "text-sage-600"
                            }`}
                          >
                            {formatTime(chain.time)}
                            {collapsed ? (
                              <span className="normal-case tracking-normal text-sage-400">
                                · {handled}/{total} done
                              </span>
                            ) : (
                              <span className="text-sage-300">
                                <RetimeHandleIcon />
                              </span>
                            )}
                          </span>
                          {/* The chain's name (or the chainLabel fallback when
                          unnamed) — tap to name/rename. data-no-retime inside,
                          so editing doesn't start the header's time-drag. */}
                          {!collapsed && (
                            <ChainNameControl
                              name={chain.name ?? ""}
                              label={
                                chain.name
                                  ? chain.name
                                  : chainLabel(chain.habits, chain.time)
                              }
                              onSave={(n) => renamePlan(chain.id!, n)}
                            />
                          )}
                          {isNow && (
                            <span className="rounded-full bg-honey-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                              Now
                            </span>
                          )}
                          <div className="flex-1 h-px bg-sage-200" />
                          {/* "Running late" shift stays tappable — opt it out of the
                          block's retime drag. */}
                          <div data-no-retime>
                            <ShiftControl
                              chainId={chain.id}
                              onShift={shiftFromPlan}
                            />
                          </div>
                        </div>
                      }
                    >
                      {collapsed ? null : (
                        <>
                          {planBoard}
                          {!isPastDay && chain.id != null && (
                            <AddHabitButton
                              onClick={() =>
                                navigate(
                                  `/habits/new?chain=${chain.id}&order=${
                                    fullChain.habits.length + 1
                                  }`,
                                )
                              }
                            />
                          )}
                        </>
                      )}
                    </RetimeBlock>
                  ) : (
                    // "Anytime" group: no time, so nothing to retime.
                    <>
                      <div className="flex items-center gap-3 mb-2">
                        {/* Collapse/expand toggle (no retime here, so no opt-out). */}
                        <button
                          type="button"
                          onClick={() => toggleCollapsed(String(key))}
                          aria-expanded={!collapsed}
                          aria-label={
                            collapsed
                              ? `Expand ${formatTime(chain.time)}`
                              : `Collapse ${formatTime(chain.time)}`
                          }
                          className="shrink-0 text-sage-400 transition-colors hover:text-sage-600"
                        >
                          <ChevronIcon open={!collapsed} />
                        </button>
                        <span className="inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-sage-600">
                          {formatTime(chain.time)}
                          {collapsed && (
                            <span className="normal-case tracking-normal text-sage-400">
                              · {handled}/{total} done
                            </span>
                          )}
                        </span>
                        <div className="flex-1 h-px bg-sage-200" />
                      </div>
                      {!collapsed && (
                        <>
                          {planBoard}
                          {!isPastDay && chain.id != null && (
                            <AddHabitButton
                              onClick={() =>
                                navigate(
                                  `/habits/new?chain=${chain.id}&order=${
                                    fullChain.habits.length + 1
                                  }`,
                                )
                              }
                            />
                          )}
                        </>
                      )}
                    </>
                  )}
                </section>
              );
            })}

            {/* Stretch: the day's harder versions, gathered at the bottom. A Case-A
            slot above today plus each Case-B rung above today shows here as a
            standalone card — swipe to skip, star, tap to open, and a check that
            completes THAT rung (completeTier). Only rendered when there's at least
            one, so a plain day shows nothing extra. */}
            {stretchSlots.length > 0 && (
              <section className="pt-1">
                <div className="mb-2 flex items-baseline gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-lavender-500">
                    Stretch
                  </span>
                  <span className="text-[11px] text-stone-300">
                    harder versions — do more if you want
                  </span>
                </div>
                <ul className="space-y-1.5">
                  {stretchSlots.map(({ habit, level }) => (
                    <li key={`stretch-${habit.id}-${level}`}>
                      <HabitCard
                        habit={habit}
                        dayTier={dayTier}
                        completeTier={level}
                        onStatus={setHabitStatus}
                        onOpenNote={setEditingNote}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
          {/* Floating copy that follows the finger so the dragged habit stays
            visible as it crosses between blocks. */}
          <DragOverlay>
            {draggingHabit ? (
              <div className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm text-stone-800 shadow-lg ring-1 ring-sage-200">
                <span className="text-sage-400">
                  <GripIcon />
                </span>
                {draggingHabit.name}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>

        {/* ＋ Add time: make a new (empty) chain at a time you pick, then drag a
          habit into it. Reuses the block if one already exists at that time. */}
        <div className="mt-6">
          {addingTime ? (
            <div className="flex items-center gap-2">
              <input
                type="time"
                value={newTime}
                onChange={(e) => setNewTime(e.target.value)}
                className="rounded-lg border border-sage-200 px-2 py-1.5 text-sm text-stone-800"
              />
              <button
                type="button"
                onClick={() => {
                  addTime(newTime);
                  setAddingTime(false);
                  setNewTime("");
                }}
                disabled={!newTime}
                className="rounded-lg bg-sage-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => {
                  setAddingTime(false);
                  setNewTime("");
                }}
                className="rounded-lg px-2 py-1.5 text-sm text-sage-500"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAddingTime(true)}
              className="w-full rounded-xl border border-dashed border-sage-300 px-3 py-2.5 text-sm font-medium text-sage-500 transition-colors hover:border-sage-400 hover:text-sage-700"
            >
              ＋ Add time
            </button>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="max-w-md mx-auto">
        {/* The date selector doubles as the page header — the big day label is
            the title, so there's no separate hero taking up space. */}
        <DateNav
          date={viewedDate}
          onPrev={() => {
            leaveForwardMode();
            setViewedDate((d) => addDays(d, -1));
          }}
          onNext={() => {
            leaveForwardMode();
            setViewedDate((d) => addDays(d, 1));
          }}
          onToday={() => {
            leaveForwardMode();
            setViewedDate(startOfDay(new Date()));
          }}
        />

        {/* Shortcut to the recurring "everyday routine" editor — the default
            schedule that plays every day, separate from this day-by-day view. */}
        <Link
          to="/routine"
          className="mb-3 flex items-center justify-center gap-1 rounded-xl border border-sage-200 py-2 text-sm font-medium text-sage-600 transition-colors hover:border-sage-400"
        >
          Everyday routine ›
        </Link>

        {/* Day-level controls: the tier picker, the main-only filter, and
            the rare actions (new routine / skip day / reset), grouped into one
            compact bar. See ./plan/PlanToolbar. */}
        {visibleChains.length > 0 && (
          <PlanToolbar
            dayTier={dayTier}
            onTierChange={setDayTier}
            mainOnly={mainOnly}
            onToggleMainOnly={() => setMainOnly((v) => !v)}
            onNewRoutine={() => setRoutineSheet({ mode: "create" })}
            showResetOrder={isViewingToday && orderChanged}
            onResetOrder={resetOrder}
            showResetDay={dayFullySkipped || dayHasArrangement}
            showSkipDay={!dayFullySkipped}
            onSkipDay={() => setSkipDayOpen(true)}
            onResetDay={() => clearDay(viewedDate)}
          />
        )}
        {body}
      </div>

      <FloatingControls
        onGoToNow={
          isViewingToday && nowBlockId != null
            ? () => {
                setLandingPref("now");
                scrollToNow();
              }
            : undefined
        }
        onGoToTop={() => {
          setLandingPref("top");
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
        getNowTop={() =>
          nowBlockId != null
            ? (sectionRefs.current[String(nowBlockId)]?.getBoundingClientRect()
                .top ?? null)
            : null
        }
      />

      {/* Per-day note editor (bottom sheet). */}
      {editingNote && (
        <NoteSheet
          key={editingNote.id}
          habit={editingNote}
          allHabits={allHabits}
          notes={notesByHabit.get(editingNote.id) ?? []}
          dateLabel={dayLabel(viewedDate)}
          onCreate={(body, habitIds) => createNote(habitIds, body)}
          onEdit={(noteId, body, scope) =>
            editNote(noteId, editingNote.id, body, scope)
          }
          onDelete={(noteId, scope) =>
            deleteNote(noteId, editingNote.id, scope)
          }
          onClose={() => setEditingNote(null)}
        />
      )}

      {/* Create / edit a routine (bottom sheet). Keyed so switching between
          create and a specific routine remounts with fresh state. */}
      {routineSheet && (
        <RoutineSheet
          key={routineSheet.mode === "edit" ? `r${routineSheet.id}` : "new"}
          routine={
            routineSheet.mode === "edit"
              ? { id: routineSheet.id, name: routineSheet.name }
              : null
          }
          habits={scheduledHabits}
          chains={chains
            .filter((p) => p.id != null)
            .map((p) => ({
              id: p.id!,
              label: p.name || chainLabel(p.habits, p.time),
            }))}
          currentChainId={
            routineSheet.mode === "edit"
              ? (chains.find(
                  (p) =>
                    p.id != null &&
                    p.habits.some((h) => h.routine === routineSheet.id),
                )?.id ?? null)
              : null
          }
          onCreate={createRoutine}
          onSave={saveRoutine}
          onDelete={deleteRoutine}
          onMoveChain={moveRoutineToChain}
          onClose={() => setRoutineSheet(null)}
        />
      )}

      {/* Confirm before a bulk skip — replaces the old window.confirm. */}
      <ConfirmDialog
        open={skipDayOpen}
        title="Skip this day?"
        message="Every habit for this day gets marked skipped. Anything already done stays done — and you can undo it."
        confirmLabel="Skip day"
        destructive
        onConfirm={confirmSkipDay}
        onCancel={() => setSkipDayOpen(false)}
      />

      {/* The clarity gate for a forward edit (Jennifer's #1 rule): show exactly
          what's changing and the scope before it sticks. The `detail` sentence is
          honest per edit kind — placement ("where the habit sits") vs time ("when
          this chain runs") — so neither overstates what it touches. */}
      <ConfirmDialog
        open={pendingForward != null}
        title="Apply to future days?"
        message={
          pendingForward
            ? `${pendingForward.summary}. ${pendingForward.detail}`
            : undefined
        }
        confirmLabel="Apply going forward"
        onConfirm={() => {
          pendingForward?.run();
          setPendingForward(null);
        }}
        onCancel={() => setPendingForward(null)}
      />
    </>
  );
}

export default PlanPage;
