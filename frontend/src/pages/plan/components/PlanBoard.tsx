import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { Chain, Habit, HabitStatus, Segment } from "../types";
import { slotPlacement } from "../tier";
import { isDone } from "../status";
import { buildSegments } from "../segments";
import { RowLayout } from "./RowLayout";
import { SortableRow } from "./SortableRow";
import { CompletedTray, RoutineBlock } from "./PlanBlocks";

// All of one plan's habits. Not-yet-completed habits show as the active list (a
// drag-to-reorder list for scheduled plans; a plain list for "Anytime"), and
// completed habits collapse into the tray below so they stop taking up space.
// Routine-tagged habits render as a collapsible block IN PLACE (so a routine
// stays put inside its chain), not lifted out of the order.
export function PlanBoard({
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
          <li className="rounded-xl border border-dashed border-calm-200 px-3 py-5 text-center text-xs text-calm-400">
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
