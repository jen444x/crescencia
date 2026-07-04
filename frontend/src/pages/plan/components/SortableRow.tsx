import type { Habit, HabitStatus } from "../types";
import type { CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripIcon } from "../../../components/icons";
import { RowLayout } from "./RowLayout";

// A draggable habit row. The drag handle is a grip INSIDE the card; chain steps
// also show their number in the left rail (label only).
export function SortableRow({
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
    opacity: isDragging ? 0.85 : 1,
    zIndex: isDragging ? 30 : undefined,
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
      className="-m-2 shrink-0 cursor-grab select-none p-2 text-calm-300 hover:text-calm-500 active:cursor-grabbing"
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
