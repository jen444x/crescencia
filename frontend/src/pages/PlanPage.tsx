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
import { useNavigate } from "react-router-dom";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// The statuses we can WRITE for a day. Matches the backend's HabitLog.Status.
type HabitStatus = "PENDING" | "COMPLETED" | "SKIPPED";
// What the server can REPORT: adds MISSED — a derived, read-only state the
// backend returns for a *past* day's untouched habit. We render it but never
// send it (the log endpoint only accepts the three writable statuses above).
type ReadStatus = HabitStatus | "MISSED";

type Plan = {
  // null for the "Anytime" group (habits with no schedule) — that group
  // can't be reordered.
  id: number | null;
  time: string | null;
  habits: Habit[];
};
type Habit = {
  id: number;
  // The Schedule row that holds this habit's position (order + chain).
  // It's what we send to /schedules/reorder/ when the habit is dragged.
  schedule_id?: number | null;
  name: string;
  chain?: number | null;
  // The Routine (group) this habit belongs to + its display name, for the
  // collapsible block on the Plan page. null when the habit isn't grouped.
  // Independent of `chain`: a habit can be in a routine, a chain, both, or neither.
  routine?: number | null;
  routine_name?: string | null;
  order?: number;
  // The day's status from the backend. `done_today` is the convenience boolean
  // (status === "COMPLETED"); we keep both since the API sends both. Can be
  // "MISSED" on past days, which we render but never send back.
  status?: ReadStatus;
  done_today?: boolean;
  // LEGACY: that day's free-text note (HabitLog.notes), "" when none. Superseded
  // by the new Note model (`dayNotes` below); kept as a fallback while the
  // /days/notes/ endpoint rolls out. Per-DAY, distinct from the habit's own
  // permanent `notes` edited on the habit page.
  notes?: string;
  // That day's notes from the new Note model, attached client-side from
  // /days/notes/ (see notesByHabit). A shared note appears on each of its habits.
  dayNotes?: DayNote[];
  // Starred "one I care about completing" (vs a planning/helper habit). Drives a
  // star + the "Important only" filter; nothing about tracking changes.
  is_important?: boolean;
  // This row is ONE tier-slot of a habit (a habit can have several at different
  // times). Backend derives status/done_today per slot.
  // tier != null  -> Case A: this row IS that tier-slot, at its own time. Show
  //                  tier_name + tier_value; complete sends `tier`.
  // tier == null + tiers non-empty -> Case B: a single same-time slot that carries
  //                  the habit's whole ladder; the row shows the value for the
  //                  highest tier <= dayTier and completes at that level.
  // tier == null + tiers empty -> untiered: a plain card, no tier sent.
  tier?: number | null;        // 1=Roots, 2=Growth; null = untiered OR Case B
  tier_name?: string | null;
  tier_value?: string | null;  // Case A only: this slot's value, e.g. "7:30"
  // The habit's full tier list (every level it has). [] = untiered. Used to look
  // up a value by level (Case A fallback) and to drive Case B's rung + stretch.
  tiers?: { level: number; name: string; value: string }[];
  achieved_tier?: number | null;
};

// A per-day note from the new Note model (GET /days/notes/). Unlike the legacy
// `Habit.notes` string, it has its own id, can carry several habits, and can be
// shared across them (`shared` === habits.length > 1).
type DayNote = {
  id: number;
  body: string;
  date: string;
  habits: number[];
  shared: boolean;
  created_at: string;
  updated_at: string;
};

// The day-tier toggle's two settings. Roots = the hard/minimum day; Growth = the
// everyday bar. Levels match the backend's tier levels.
const ROOTS_LEVEL = 1;
const GROWTH_LEVEL = 2;

type SlotPlacement = "inline" | "stretch" | "hidden";

// True when a row carries no tiers at all — a plain habit that renders and
// completes exactly as it always has (no tier label, no tier sent).
function isUntiered(habit: Habit): boolean {
  return habit.tier == null && (habit.tiers?.length ?? 0) === 0;
}

// Case B: a single same-time slot (tier null) that still carries the habit's
// ladder, so ONE row shows the rung for today and we synthesize stretch cards for
// the harder rungs. (Untiered habits are tier null too, hence the tiers check.)
function isCaseB(habit: Habit): boolean {
  return habit.tier == null && (habit.tiers?.length ?? 0) > 0;
}

// Case B's "today" rung: the highest tier level <= dayTier, or null if the habit
// has no rung at/below today (then its inline row is dropped — it only stretches).
function caseBInlineLevel(habit: Habit, dayTier: number): number | null {
  const at = (habit.tiers ?? [])
    .map((t) => t.level)
    .filter((lvl) => lvl <= dayTier);
  return at.length ? Math.max(...at) : null;
}

// The value to print after a row's name (the lighter "· 5 min" span), per case:
//   Case A: this slot's own value (tier_value, or look it up in tiers by level).
//   Case B: the value of the highest rung <= dayTier (its "today" version).
//   untiered: none.
function rowDisplayValue(habit: Habit, dayTier: number): string | null {
  if (habit.tier != null) {
    if (habit.tier_value) return habit.tier_value;
    return habit.tiers?.find((t) => t.level === habit.tier)?.value ?? null;
  }
  if (isCaseB(habit)) {
    const level = caseBInlineLevel(habit, dayTier);
    if (level == null) return null;
    return habit.tiers?.find((t) => t.level === level)?.value ?? null;
  }
  return null;
}

// The tier level a row's complete button should send (undefined = send none):
//   Case A: this slot's tier.
//   Case B inline: the highest rung <= dayTier.
//   untiered: undefined.
function rowCompleteTier(habit: Habit, dayTier: number): number | undefined {
  if (habit.tier != null) return habit.tier;
  if (isCaseB(habit)) return caseBInlineLevel(habit, dayTier) ?? undefined;
  return undefined;
}

// Where a slot renders for the chosen day-tier. inlineTierByHabit maps a habit id
// to the highest Case-A slot level <= dayTier (its "today version"), or null.
//   untiered -> always inline.
//   Case A   -> inline at its habit's highest tier <= today; stretch if harder than
//               today; otherwise hidden (a lower, cascade-covered rung).
//   Case B   -> inline when it has a rung <= today (one row for the day); plus
//               separate synthesized stretch cards for its harder rungs (built at
//               the page level, not here). With no rung <= today it isn't inline.
function slotPlacement(
  habit: Habit,
  inlineTierByHabit: Map<number, number | null>,
  dayTier: number,
): SlotPlacement {
  if (isUntiered(habit)) return "inline";               // untiered slot, always shown
  if (isCaseB(habit))
    return caseBInlineLevel(habit, dayTier) != null ? "inline" : "stretch";
  const inline = inlineTierByHabit.get(habit.id) ?? null;
  if (habit.tier === inline) return "inline";           // the highest tier <= today
  if ((habit.tier ?? 0) > dayTier) return "stretch";    // harder than today -> bottom
  return "hidden";                                      // lower, cascade-covered
}

// Read a habit's state, tolerating an older payload that only had done_today.
function isDone(habit: Habit) {
  return habit.status ? habit.status === "COMPLETED" : !!habit.done_today;
}
function isSkipped(habit: Habit) {
  return habit.status === "SKIPPED";
}
// A past day's habit that was never completed or skipped. Derived + read-only:
// the backend sends this status; we never POST it.
function isMissed(habit: Habit) {
  return habit.status === "MISSED";
}

// "08:00:00" -> "8:00 AM"; null/empty -> "Anytime"
function formatTime(time: string | null) {
  if (!time) return "Anytime";
  const [hourStr, minute] = time.split(":");
  const hour = parseInt(hourStr, 10);
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${minute} ${period}`;
}

// A short label for a whole cycle: its first habit, plus "+N" when it holds more
// (so a multi-habit block reads as more than just its first item). Falls back to
// the time if a block somehow has no habits.
function cycleLabel(habits: Habit[], time: string | null): string {
  const first = habits[0]?.name;
  if (!first) return formatTime(time);
  return habits.length > 1 ? `${first} +${habits.length - 1}` : first;
}

// "08:30:00" -> 510 (minutes since midnight). Used to find which time block
// is "now" so we can open the page there.
function timeToMinutes(time: string): number {
  const [hourStr, minuteStr] = time.split(":");
  return parseInt(hourStr, 10) * 60 + parseInt(minuteStr, 10);
}

// 510 -> "08:30". The inverse of timeToMinutes — the absolute time we send to
// /plans/retime/ when a cycle's time header is dragged.
function minutesToHHMM(total: number): string {
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// Which time block is happening right now? The latest block whose start time has
// already passed (at 9:10, the "9:00 AM" block is current). Before the day's
// first block, fall back to it so the page still opens somewhere sensible.
// Returns the plan id to scroll to, or null if there are no timed blocks.
function currentBlockId(plans: Plan[]): number | null {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  let currentId: number | null = null;
  let currentMinutes = -1;
  let earliestId: number | null = null;
  let earliestMinutes = Infinity;

  for (const plan of plans) {
    if (plan.id == null || !plan.time) continue;
    const minutes = timeToMinutes(plan.time);
    if (minutes <= nowMinutes && minutes > currentMinutes) {
      currentMinutes = minutes;
      currentId = plan.id;
    }
    if (minutes < earliestMinutes) {
      earliestMinutes = minutes;
      earliestId = plan.id;
    }
  }
  return currentId ?? earliestId;
}

// --- Day navigation (browse other days) -------------------------------------

// Local midnight — the canonical value we compare/store a viewed day by.
function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Local "YYYY-MM-DD" for the API. NOT toISOString() — that's UTC and can land on
// the wrong calendar day near midnight.
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

// A row to render for one habit. `stepNumber` is its position within a chain
// (1, 2, 3...) or null if it's a standalone habit. `connectBelow` draws the
// little connector line down to the next step when they're in the same chain.
type Row = {
  habit: Habit;
  stepNumber: number | null;
  connectBelow: boolean;
};

// A time block renders as an ordered list of segments, IN PLACE (display order):
//   - "active":  a single not-yet-completed habit
//   - "done":    a RUN of consecutive completed habits, collapsed into one chip
//   - "routine": a RUN of consecutive habits sharing a routine, shown as one
//     collapsible block — so a routine stays put inside its cycle (e.g. between
//     "shower" and "lotion") instead of being lifted out of the order.
// A routine counts as ONE step in its chain, so step numbers stay sensible
// (shower 1 · morning routine 2 · lotion 3), and completed routine members stay
// in their block rather than collapsing into the "done" chip.
type Segment =
  | { kind: "active"; row: Row }
  | { kind: "done"; key: string; habits: Habit[] }
  | {
      kind: "routine";
      key: string;
      routineId: number;
      name: string;
      stepNumber: number | null;
      connectBelow: boolean;
      habits: Habit[];
    };

function buildSegments(habits: Habit[]): Segment[] {
  // 1) Collapse into ordered "units": consecutive habits sharing a routine
  //    become one routine unit; every other habit is its own unit.
  type Unit =
    | { type: "habit"; habit: Habit }
    | { type: "routine"; routineId: number; name: string; habits: Habit[] };
  const units: Unit[] = [];
  for (const habit of habits) {
    const last = units[units.length - 1];
    if (habit.routine != null) {
      if (last && last.type === "routine" && last.routineId === habit.routine) {
        last.habits.push(habit);
      } else {
        units.push({
          type: "routine",
          routineId: habit.routine,
          name: habit.routine_name ?? "Routine",
          habits: [habit],
        });
      }
    } else {
      units.push({ type: "habit", habit });
    }
  }

  // A unit's chain is its (first) habit's chain — for step numbers + connectors.
  const unitChain = (u: Unit): number | null =>
    (u.type === "habit" ? u.habit.chain : u.habits[0].chain) ?? null;

  // 2) Chain step numbers, counting a whole routine unit as a single step.
  const counts = new Map<number, number>();
  const stepNumbers = units.map((u) => {
    const chain = unitChain(u);
    if (chain == null) return null;
    const n = (counts.get(chain) ?? 0) + 1;
    counts.set(chain, n);
    return n;
  });

  // 3) Emit segments in order, grouping consecutive completed single habits into
  //    one "done" chip. Routine units never collapse.
  const segments: Segment[] = [];
  let run: Habit[] = [];
  const flushRun = () => {
    if (run.length > 0) {
      segments.push({ kind: "done", key: `done-${run[0].id}`, habits: run });
      run = [];
    }
  };

  units.forEach((u, i) => {
    const chain = unitChain(u);
    const next = units[i + 1];
    // Connect down to the next unit only when it's the immediately-following step
    // of the same chain and not a collapsed done habit (so a line never dangles).
    const connectBelow =
      chain != null &&
      next != null &&
      unitChain(next) === chain &&
      !(next.type === "habit" && isDone(next.habit));

    if (u.type === "routine") {
      flushRun();
      segments.push({
        kind: "routine",
        key: `routine-${u.routineId}-${u.habits[0].id}`,
        routineId: u.routineId,
        name: u.name,
        stepNumber: stepNumbers[i],
        connectBelow,
        habits: u.habits,
      });
      return;
    }

    if (isDone(u.habit)) {
      run.push(u.habit);
      return;
    }
    flushRun();
    segments.push({
      kind: "active",
      row: { habit: u.habit, stepNumber: stepNumbers[i], connectBelow },
    });
  });
  flushRun();

  return segments;
}

// Return a NEW plans array with one habit's status set (and done_today kept in
// sync). Pure + immutable, so React reliably re-renders.
function applyStatus(
  plans: Plan[],
  habitId: number,
  status: HabitStatus,
): Plan[] {
  return plans.map((plan) => ({
    ...plan,
    habits: plan.habits.map((habit) =>
      habit.id === habitId
        ? { ...habit, status, done_today: status === "COMPLETED" }
        : habit,
    ),
  }));
}

// Return a NEW plans array with one plan's habits set to `orderedHabits`,
// renumbered 1..N. Pure + immutable, like applyStatus above.
function applyPlanOrder(
  plans: Plan[],
  planId: number,
  orderedHabits: Habit[],
): Plan[] {
  return plans.map((plan) =>
    plan.id === planId
      ? {
          ...plan,
          habits: orderedHabits.map((habit, i) => ({ ...habit, order: i + 1 })),
        }
      : plan,
  );
}

function CheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-4 w-4"
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
  );
}

function GripIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

// A chevron that points right when collapsed, down when expanded.
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2.5}
        d="M9 5l7 7-7 7"
      />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15.232 5.232l3.536 3.536M9 11l6.232-6.232a2 2 0 112.828 2.828L11.828 14H9v-3z"
      />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <circle cx="12" cy="12" r="9" strokeWidth={2} />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 7v5l3 2"
      />
    </svg>
  );
}

// A pencil-on-paper glyph for the per-day note affordance.
function NoteIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
      />
    </svg>
  );
}

// Two linked rings — marks a note shared across more than one habit.
function SharedNoteIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-3 w-3 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 17H7A5 5 0 017 7h2M15 7h2a5 5 0 010 10h-2M8 12h8"
      />
    </svg>
  );
}

// A U-turn arrow for "un-skip": send a skipped/missed habit back to today's list.
function RestoreIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3"
      />
    </svg>
  );
}

// Filled star marking an "important" habit. Filled (not outline) so it reads as
// a clear marker at a glance next to the name.
function StarIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-4 w-4"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M9.05 2.93c.3-.92 1.6-.92 1.9 0l1.42 4.38a1 1 0 00.95.69h4.6c.97 0 1.37 1.24.59 1.81l-3.73 2.71a1 1 0 00-.36 1.12l1.42 4.38c.3.92-.75 1.69-1.54 1.12l-3.72-2.71a1 1 0 00-1.18 0l-3.72 2.71c-.79.57-1.84-.2-1.54-1.12l1.42-4.38a1 1 0 00-.36-1.12L1.48 9.81c-.78-.57-.38-1.81.59-1.81h4.6a1 1 0 00.95-.69L9.05 2.93z" />
    </svg>
  );
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
  const skipped = isSkipped(habit);
  const missed = isMissed(habit);
  // This card is one tier-slot of a habit. When it carries a tier value (e.g.
  // "7:30" / "11am" / "5 min") we append it after the name so the slot reads as
  // "Wake up · 7:30"; an untiered slot has none and renders exactly as before.
  // A stretch card is pinned to one rung (completeTier), so it shows that rung's
  // value; otherwise the value follows the case + dayTier.
  const tierValue =
    completeTier != null
      ? (habit.tiers?.find((t) => t.level === completeTier)?.value ?? null)
      : rowDisplayValue(habit, dayTier);
  // The level this card completes at: an explicit override (stretch card) or the
  // row's own dayTier-derived level (Case A: its tier; Case B inline: rung <=
  // today; untiered: none).
  const tierToSend = completeTier ?? rowCompleteTier(habit, dayTier);
  // Done is per-RUNG, not per-habit: a tiered card reads done when the habit's
  // achieved_tier reaches THIS card's rung — so completing the easy version never
  // ticks the harder stretch card, and completing the hard one cascades to mark
  // the easier ones done. Untiered cards fall back to the plain log status.
  const done =
    tierToSend != null
      ? habit.achieved_tier != null && habit.achieved_tier >= tierToSend
      : isDone(habit);
  // Notes come from the new Note model; fall back to the legacy per-habit string
  // while /days/notes/ rolls out. `hasNotes` drives the note button's accent
  // (the notes themselves are viewed on the habit detail page).
  const dayNotes = habit.dayNotes ?? [];
  const legacyNote = habit.notes?.trim() ?? "";
  const hasNotes = dayNotes.length > 0 || legacyNote !== "";
  return (
    <div
      className={`group flex flex-col rounded-xl px-4 py-3 shadow-sm hover:shadow-md transition-shadow cursor-pointer ${
        done
          ? "bg-calm-50"
          : skipped
            ? "bg-stone-50"
            : missed
              ? "bg-rose-50"
              : "bg-white"
      }`}
    >
      <div className="flex items-center gap-3">
      {handle}
      {/* Star marks an "important" habit (one she cares about completing). Dimmed
          once the habit is done so it doesn't compete with the struck-out name. */}
      {habit.is_important && (
        <span className={`shrink-0 ${done ? "text-amber-300" : "text-amber-400"}`}>
          <StarIcon />
        </span>
      )}
      {/* The name is a plain heading again, so a normal tap bubbles up and opens
          the habit detail page. A tier-slot appends its value (e.g. "· 7:30") in
          a lighter span, dimmed further once the slot is done. */}
      <div className="min-w-0 flex-1">
        <h3
          className={`break-words font-medium ${
            done
              ? "text-calm-400 line-through"
              : skipped
                ? "text-stone-400"
                : missed
                  ? "text-rose-400"
                  : "text-calm-900"
          }`}
        >
          {habit.name}
          {tierValue && (
            <span
              className={`font-normal ${
                done ? "text-calm-300" : "text-stone-400"
              }`}
            >
              {" · "}
              {tierValue}
            </span>
          )}
        </h3>
      </div>

      {skipped && (
        <span className="shrink-0 rounded-full bg-stone-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stone-500">
          Skipped
        </span>
      )}

      {missed && (
        <span className="shrink-0 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-500">
          Missed
        </span>
      )}

      {/* Per-day note. data-no-swipe + stopPropagation so it doesn't start a
          swipe or open the detail page. Accented once a note exists. */}
      <button
        type="button"
        data-no-swipe
        aria-label={hasNotes ? "Edit notes" : "Add note"}
        onClick={(e) => {
          e.stopPropagation();
          onOpenNote(habit);
        }}
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors ${
          hasNotes
            ? "text-calm-600 hover:bg-calm-100"
            : "text-calm-300 hover:bg-calm-50 hover:text-calm-500"
        }`}
      >
        <NoteIcon />
      </button>

      {/* Skipped/missed habits are "parked": the right button restores them to
          today's list (PENDING) so they can be acted on again. Active habits get
          the usual complete toggle. Both are data-no-swipe + stopPropagation so a
          tap neither starts a swipe nor opens the detail page. */}
      {skipped || missed ? (
        <button
          type="button"
          data-no-swipe
          aria-label="Move back to today"
          onClick={(e) => {
            e.stopPropagation();
            onStatus(habit.id, "PENDING");
          }}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors ${
            skipped
              ? "border-stone-300 text-stone-400 hover:border-stone-500 hover:text-stone-600"
              : "border-rose-300 text-rose-400 hover:border-rose-500 hover:text-rose-600"
          }`}
        >
          <RestoreIcon />
        </button>
      ) : (
        <button
          type="button"
          data-no-swipe
          aria-label={done ? "Mark as not done today" : "Mark as done today"}
          aria-pressed={done}
          onClick={(e) => {
            e.stopPropagation();
            // Complete THIS card at its own level (Case A: its tier; Case B inline:
            // the rung <= today; stretch card: its pinned rung). An untiered card
            // sends no `tier`, exactly as before.
            onStatus(
              habit.id,
              done ? "PENDING" : "COMPLETED",
              done ? undefined : tierToSend,
            );
          }}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors ${
            done
              ? "border-calm-600 bg-calm-600 text-white"
              : "border-calm-300 text-transparent hover:border-calm-500"
          }`}
        >
          <CheckIcon />
        </button>
      )}
      </div>
    </div>
  );
}

// Wraps a habit card with a left-swipe gesture to SKIP it. A plain tap opens the
// habit. We hand-roll this with pointer events so it coexists with the drag
// handle (grip) and the complete button, both of which are marked data-no-swipe
// and ignored here.
const SWIPE_TRIGGER = 70; // px past which a release fires the action
const SWIPE_MAX = 110; // px the card is allowed to follow your finger

function SwipeableCard({
  habit,
  dayTier,
  completeTier,
  onStatus,
  onOpenNote,
  handle,
}: {
  habit: Habit;
  dayTier: number;
  completeTier?: number;
  onStatus: (habitId: number, status: HabitStatus, tier?: number) => void;
  onOpenNote: (habit: Habit) => void;
  handle?: ReactNode;
}) {
  const navigate = useNavigate();
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startX = useRef<number | null>(null);
  const moved = useRef(false);

  function onPointerDown(e: ReactPointerEvent) {
    // Ignore presses that begin on the grip or the complete toggle.
    if ((e.target as HTMLElement).closest("[data-no-swipe]")) return;
    startX.current = e.clientX;
    moved.current = false;
    setDragging(true);
  }
  function onPointerMove(e: ReactPointerEvent) {
    if (startX.current == null) return;
    const delta = e.clientX - startX.current;
    if (Math.abs(delta) > 6) moved.current = true;
    // Left-only: clamp to <= 0 so a rightward drag does nothing.
    setDx(Math.max(-SWIPE_MAX, Math.min(0, delta)));
  }
  function onPointerEnd() {
    if (startX.current == null) return;
    if (dx <= -SWIPE_TRIGGER) onStatus(habit.id, "SKIPPED");
    startX.current = null;
    setDragging(false);
    setDx(0); // animate back to rest
  }
  function onClick() {
    // A swipe shouldn't also count as a tap.
    if (moved.current) {
      moved.current = false;
      return;
    }
    navigate(`/habits/${habit.id}`);
  }

  return (
    <div
      className={`relative overflow-hidden rounded-xl transition-colors ${
        dx < -8 ? "bg-amber-100" : ""
      }`}
    >
      {/* Always-visible "swipe left to skip" affordance on the right edge.
          Faint at rest; intensifies to the amber Skip treatment as you drag. */}
      <div
        className={`pointer-events-none absolute inset-0 flex items-center justify-end gap-1 px-5 text-xs font-semibold uppercase tracking-wide transition-colors ${
          dx < -8 ? "text-amber-700" : "text-stone-300/70"
        }`}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2.5}
            d="M15 19l-7-7 7-7"
          />
        </svg>
        <span>Skip</span>
      </div>

      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClick={onClick}
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging ? undefined : "transform 150ms ease",
          touchAction: "pan-y", // let vertical scroll through; we take horizontal
        }}
      >
        <HabitCard
          habit={habit}
          dayTier={dayTier}
          completeTier={completeTier}
          onStatus={onStatus}
          onOpenNote={onOpenNote}
          handle={handle}
        />
      </div>
    </div>
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
          <span className="z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-calm-600 text-[11px] font-medium text-white">
            {stepNumber}
          </span>
          {connectBelow && <span className="w-px grow bg-calm-300" />}
        </div>
      )}
      {/* min-w-0 lets this column shrink below the note's width so the note can
          truncate instead of pushing the card (and its ✓ button) off-screen. */}
      <div className="min-w-0 flex-1 pb-1.5">
        <SwipeableCard
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
  } = useSortable({ id: habit.id });
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
      className="shrink-0 cursor-grab touch-none text-calm-300 hover:text-calm-500 active:cursor-grabbing"
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
// The filled check resets it to PENDING and sends it back up to the active list.
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
  // Prefer the new Note model; fall back to the legacy per-habit string while
  // /days/notes/ rolls out. (Step 2 shows multiple notes; this shows the first
  // as a one-line preview, matching the old single-note behavior.)
  const note = (habit.dayNotes?.[0]?.body ?? habit.notes ?? "").trim();
  return (
    <div
      onClick={() => navigate(`/habits/${habit.id}`)}
      className="flex cursor-pointer items-center gap-3 rounded-lg px-4 py-2 hover:bg-white"
    >
      <span className="min-w-0 flex-1 truncate text-sm text-calm-400 line-through">
        {habit.name}
      </span>
      {/* Jot a reflection even after it's done ("felt great after"). */}
      <button
        type="button"
        aria-label={note ? "Edit note" : "Add note"}
        onClick={(e) => {
          e.stopPropagation();
          onOpenNote(habit);
        }}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors ${
          note
            ? "text-calm-600 hover:bg-calm-100"
            : "text-calm-300 hover:bg-calm-100 hover:text-calm-500"
        }`}
      >
        <NoteIcon />
      </button>
      <button
        type="button"
        aria-label="Mark as not done today"
        aria-pressed={true}
        onClick={(e) => {
          e.stopPropagation();
          onStatus(habit.id, "PENDING");
        }}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-calm-500 bg-calm-500 text-white transition-colors hover:bg-calm-600"
      >
        <CheckIcon />
      </button>
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
  // Chain step number + connector, when the routine sits inside a cycle. null
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
          step in the cycle (e.g. between shower and lotion). Null step = the
          routine isn't in a chain, and the block spans the full width. */}
      {stepNumber != null && (
        <div className="flex flex-col items-center">
          <span className="z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-calm-600 text-[11px] font-medium text-white">
            {stepNumber}
          </span>
          {connectBelow && <span className="w-px grow bg-calm-300" />}
        </div>
      )}
      <div className="min-w-0 flex-1 pb-1.5">
        {/* Header reads as a habit card (same chrome): name on the left, the
            complete circle on the right. A chevron marks that it expands into its
            members; the pencil opens the manage sheet. */}
        <div
          className={`flex items-center gap-3 rounded-xl px-4 py-3 shadow-sm transition-shadow hover:shadow-md ${
            allDone ? "bg-calm-50" : "bg-white"
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
                className={`block break-words font-medium ${
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
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-calm-300 transition-colors hover:bg-calm-50 hover:text-calm-500"
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
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors ${
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

// All of one plan's habits. Not-yet-completed habits show as the active list (a
// drag-to-reorder list for scheduled plans; a plain list for "Anytime"), and
// completed habits collapse into the tray below so they stop taking up space.
// Routine-tagged habits render as a collapsible block IN PLACE (so a routine
// stays put inside its cycle), not lifted out of the order.
function PlanBoard({
  plan,
  dayTier,
  inlineTierByHabit,
  importantOnly,
  onStatus,
  onOpenNote,
  onReorder,
  onRoutineLog,
  onEditRoutine,
  interactive,
}: {
  plan: Plan;
  // The day's chosen tier (Roots=1 / Growth=2). Tiered habits with no rung at or
  // below it are hidden for the day; threaded to each card for its shown rung.
  dayTier: number;
  // habit id -> its highest Case-A slot level <= dayTier (its "today" version), or
  // null. Drives which tier-slot renders inline vs. stretches vs. hides.
  inlineTierByHabit: Map<number, number | null>;
  // "Important only" view: when on, non-important habits are hidden too (still
  // kept in place during reorder, like tier-hidden ones — never dropped).
  importantOnly: boolean;
  onStatus: (habitId: number, status: HabitStatus, tier?: number) => void;
  onOpenNote: (habit: Habit) => void;
  onReorder: (planId: number, orderedHabits: Habit[]) => void;
  onRoutineLog: (routineId: number, status: HabitStatus) => void;
  onEditRoutine: (routineId: number, name: string) => void;
  // Only today is reorderable: dragging writes the *recurring* order (the
  // reorder API has no date), so we don't let it happen while you're looking at
  // another day — otherwise re-sorting "yesterday" would silently rearrange
  // every day's routine.
  interactive: boolean;
}) {
  // Require a 6px drag before a pointer-down counts as a drag, so a plain tap
  // still works as a click (toggle / open detail).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const planId = plan.id;
  // Keep only the rows that belong INLINE for the day: untiered rows, the one
  // Case-A slot at the habit's highest tier <= today, and a Case-B row that has a
  // rung <= today. Stretch/hidden slots are simply absent here (their harder
  // versions surface in the Stretch section). "Important only" narrows further.
  // They're dropped from DISPLAY only — every list below (segments, active set,
  // drag rebuild) is built from this set, so reorder only touches what's shown;
  // the hidden ones are re-inserted in place when persisting (see handleDragEnd).
  const habits = plan.habits.filter(
    (habit) =>
      slotPlacement(habit, inlineTierByHabit, dayTier) === "inline" &&
      (!importantOnly || habit.is_important),
  );

  // Not reorderable when it's the "Anytime" group (no schedule rows) or any day
  // that isn't today (see `interactive` above).
  const canReorder = planId != null && interactive;

  // Ordered segments: single active habits, in-place "done" groups, and routine
  // blocks — each rendered WHERE it sits in the order, so a routine stays inside
  // its cycle. Drag reorders only the loose active habits; done + routine units
  // keep their exact spot.
  const segments = buildSegments(habits);
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
      <ul>
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

  const activeIds = activeHabits.map((habit) => habit.id);

  // On drop we rebuild the FULL list — active habits in their new order, while
  // completed and routine-grouped habits stay exactly where they were — so
  // reorderPlan can renumber and persist the whole block in one POST.
  function handleDragEnd(event: DragEndEvent) {
    if (planId == null) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = activeHabits.findIndex((h) => h.id === Number(active.id));
    const to = activeHabits.findIndex((h) => h.id === Number(over.id));
    if (from < 0 || to < 0) return;

    const newActive = arrayMove(activeHabits, from, to);
    let next = 0;
    // Rebuild the FULL list so the persisted order stays coherent: routine and
    // done members keep their spot, non-inline slots (stretch/hidden) and
    // important-only-hidden rows stay put (not shown, not reordered, but must NOT
    // be dropped from the order), and the loose visible actives take their new
    // order. The condition mirrors the `habits` display filter above.
    const newFull = plan.habits.map((habit) =>
      habit.routine != null ||
      isDone(habit) ||
      slotPlacement(habit, inlineTierByHabit, dayTier) !== "inline" ||
      (importantOnly && !habit.is_important)
        ? habit
        : newActive[next++],
    );
    onReorder(planId, newFull);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={activeIds} strategy={verticalListSortingStrategy}>
        <ul>
          {segments.map((seg) =>
            seg.kind === "done" ? (
              doneItem(seg)
            ) : seg.kind === "routine" ? (
              routineItem(seg)
            ) : (
              <li key={seg.row.habit.id}>
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
    </DndContext>
  );
}

// The ◀ [day] ▶ bar above the plan, for browsing other days. The layout is the
// same every day; only each habit's done/skipped state changes. "Jump to today"
// only appears once you've navigated away.
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
  return (
    <div className="mb-6 flex items-center justify-between">
      <button
        type="button"
        onClick={onPrev}
        aria-label="Previous day"
        className="flex h-9 w-9 items-center justify-center rounded-full text-calm-600 transition-colors hover:bg-calm-100"
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
        <span className="font-heading text-2xl leading-tight text-calm-900">
          {dayLabel(date)}
        </span>
        {!viewingToday && (
          <button
            type="button"
            onClick={onToday}
            className="text-[11px] font-medium uppercase tracking-wide text-calm-500 transition-colors hover:text-calm-700"
          >
            Jump to today
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={onNext}
        aria-label="Next day"
        className="flex h-9 w-9 items-center justify-center rounded-full text-calm-600 transition-colors hover:bg-calm-100"
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

// The ⏱ "running late" control on a time block. Pushing this cycle later moves
// it AND everything after it that day (the backend cascades + clamps); it's a
// per-day override, so the recurring routine is untouched. Deliberately separate
// from drag-reorder, which moves just one habit without changing times.
function ShiftControl({
  planId,
  onShift,
}: {
  planId: number;
  onShift: (planId: number, minutes: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(15);
  const ref = useRef<HTMLDivElement>(null);

  // Close the popover on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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
    onShift(planId, minutes);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Running late — shift this cycle and everything after it"
        aria-expanded={open}
        className="flex h-6 w-6 items-center justify-center rounded-full text-calm-500 transition-colors hover:bg-calm-100 hover:text-calm-700"
      >
        <ClockIcon />
      </button>

      {open && (
        <div className="absolute right-0 top-7 z-50 w-60 rounded-xl border border-calm-200 bg-white p-3 text-left shadow-lg">
          <p className="text-xs font-semibold text-calm-700">Running late?</p>
          <p className="mb-2 text-[11px] leading-snug text-stone-400">
            Moves this cycle and everything after it — today only.
          </p>

          <div className="flex gap-1.5">
            {[15, 30, 45].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => apply(m)}
                className="flex-1 rounded-lg bg-calm-100 py-1.5 text-xs font-medium text-calm-700 transition-colors hover:bg-calm-200"
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
              className="w-12 rounded-lg border border-calm-200 px-2 py-1 text-xs text-calm-700"
            />
            <span className="text-[11px] text-stone-400">min</span>
            <button
              type="button"
              onClick={() => apply(-custom)}
              className="flex-1 rounded-lg border border-calm-200 py-1 text-xs font-medium text-calm-600 transition-colors hover:bg-calm-50"
            >
              Earlier
            </button>
            <button
              type="button"
              onClick={() => apply(custom)}
              className="flex-1 rounded-lg border border-calm-200 py-1 text-xs font-medium text-calm-600 transition-colors hover:bg-calm-50"
            >
              Later
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Retime a single cycle (ephemeral time ruler) ---------------------------
// The single-block companion to the "running late" shift. Grab a cycle by its
// header strip and a slim time ruler fades in *just for the drag*: the dragged
// block rides the ruler so its position = its time (the calendar feel), then the
// ruler vanishes on drop — at rest it's still a plain habit list, never a grid.
// Sets one ABSOLUTE time for that one cycle (no cascade), today only — a per-day
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

// Keep two cycles off the exact same minute — /plan/ renders same-time blocks as
// two stacked rows, which she didn't want. If `minutes` is already taken by
// another cycle, step outward (just-after first, then just-before) to the nearest
// free minute so the dropped cycle sorts beside its neighbor but stays its own
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

// A faint up/down chevron hinting the block can be dragged to a new time.
function RetimeHandleIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2.5}
        d="M8 9l4-4 4 4M8 15l4 4 4-4"
      />
    </svg>
  );
}

// The ephemeral time ruler, shown only while a block is being dragged. A slim,
// translucent calendar surface: hour ticks + labels, cards for the day's other
// timed blocks (so you place this one relative to them), a dotted line at the
// block's original time, and the dragged block as a chip. Anchored so the
// block's start time sits at the press point (anchorY), at the same px/min as
// the pointer mapping — so the chip tracks your finger as it travels past the
// other cycles. Portaled to <body> and pointer-events:none — the block's
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
  // chip then tracks your finger while the other cycles stay put as context.
  const yForMin = (min: number) =>
    anchorY + (min - startMin) * RETIME_PX_PER_MIN;
  const viewportH = window.innerHeight;
  // The ruler runs past the viewport both ways; only draw what's on screen.
  const onScreen = (y: number) => y > -48 && y < viewportH + 48;

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-50">
      {/* Dim the list so the ruler is the focus; both vanish on drop. */}
      <div className="absolute inset-0 bg-calm-900/30" />

      <div className="relative mx-auto h-full max-w-md overflow-hidden bg-white/60">
        <p className="absolute inset-x-0 top-0 z-10 bg-white/70 py-2 text-center text-[11px] font-medium uppercase tracking-wide text-calm-500">
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
              <span className="w-12 shrink-0 text-right text-[10px] tabular-nums text-calm-400">
                {formatTime(minutesToHHMM(h * 60))}
              </span>
              <span className="h-px flex-1 bg-calm-200" />
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
              <span className="ml-14 flex max-w-[70%] items-center gap-1.5 truncate rounded-lg bg-white px-2 py-1 text-[11px] text-calm-500 shadow-sm ring-1 ring-calm-200">
                <span className="shrink-0 tabular-nums text-calm-400">
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
            <div className="ml-14 border-t border-dashed border-calm-300" />
          </div>
        )}

        {/* The dragged block itself, riding the ruler at its live time. */}
        <div
          className="absolute inset-x-0 -translate-y-1/2 px-4"
          style={{ top: yForMin(previewMin) }}
        >
          <div className="ml-12 flex items-center gap-2 rounded-xl bg-calm-600 px-3 py-2 text-white shadow-lg ring-2 ring-white">
            <span className="text-sm font-semibold tabular-nums">
              {formatTime(minutesToHHMM(previewMin))}
            </span>
            <span className="min-w-0 truncate text-xs text-calm-100">
              {blockLabel}
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// The retime gesture for a WHOLE timed cycle. Grab the block by its header strip;
// past a small threshold the ephemeral RetimeRuler takes over and the block's
// position on it = its time, until you release. Grabbing the header (not the
// habit rows) leaves the within-block reorder + swipe-to-skip gestures untouched.
// `otherBlocks` give the ruler its context markers and break a same-minute tie on
// drop. Hand-rolled pointer events (like SwipeableCard), not dnd-kit.
function RetimeBlock({
  planId,
  time,
  blockLabel,
  otherBlocks,
  onRetime,
  header,
  children,
}: {
  planId: number;
  time: string;
  blockLabel: string;
  otherBlocks: { min: number; name: string }[];
  onRetime: (planId: number, time: string) => void;
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
  // The minute the cycle would land on right now (drives the chip + the save).
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
    onRetime(planId, minutesToHHMM(avoidRetimeCollision(target, taken)));
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
        aria-label={`Set time for this cycle — now ${formatTime(
          time,
        )}. Drag up or down on the ruler to set a new time.`}
        title="Drag up or down to set this cycle's time (today only)"
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
  getNowTop,
}: {
  onGoToNow?: () => void;
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
          className="flex h-10 items-center gap-1.5 rounded-full border border-calm-200 bg-white pl-2.5 pr-3 text-xs font-semibold text-calm-600 shadow-lg transition-colors hover:bg-calm-50"
        >
          <ClockIcon />
          Now
        </button>
      )}
      {scrolled && (
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          aria-label="Scroll to top"
          className="flex h-10 w-10 items-center justify-center rounded-full border border-calm-200 bg-white text-calm-600 shadow-lg transition-colors hover:bg-calm-50"
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
        className="animate-backdrop-in absolute inset-0 bg-calm-900/40"
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
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-calm-200 sm:hidden" />
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
                    className="rounded-xl border border-calm-200 bg-white p-3"
                  >
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={3}
                      autoFocus
                      className="w-full resize-none rounded-lg border border-calm-200 bg-white px-3 py-2 text-sm text-calm-900 focus:border-calm-500 focus:outline-none"
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
                        className="rounded-lg px-3 py-1.5 text-xs font-medium text-calm-600 transition-colors hover:bg-calm-50"
                      >
                        Cancel
                      </button>
                      {n.shared ? (
                        <>
                          <button
                            type="button"
                            onClick={() => saveEdit(n.id, "one")}
                            disabled={editText.trim() === "" || editSaving}
                            className="rounded-lg border border-calm-300 px-4 py-1.5 text-xs font-medium text-calm-700 transition-colors hover:bg-calm-50 disabled:opacity-50"
                          >
                            Just this habit
                          </button>
                          <button
                            type="button"
                            onClick={() => saveEdit(n.id, "all")}
                            disabled={editText.trim() === "" || editSaving}
                            className="rounded-lg bg-calm-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-calm-700 disabled:opacity-50"
                          >
                            All {n.habits.length} habits
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => saveEdit(n.id, "one")}
                          disabled={editText.trim() === "" || editSaving}
                          className="rounded-lg bg-calm-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-calm-700 disabled:opacity-50"
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
                        className="rounded-lg px-3 py-1.5 text-xs font-medium text-calm-600 transition-colors hover:bg-calm-50"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onDelete(n.id, "one");
                          setConfirmDeleteId(null);
                        }}
                        className="rounded-lg border border-calm-300 px-4 py-1.5 text-xs font-medium text-calm-700 transition-colors hover:bg-calm-50"
                      >
                        Just this habit
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onDelete(n.id, "all");
                          setConfirmDeleteId(null);
                        }}
                        className="rounded-lg bg-rose-500 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-rose-600"
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
                  className="flex items-start gap-2 rounded-xl border border-calm-100 bg-calm-50 px-3 py-2"
                >
                  {n.shared && (
                    <span
                      className="mt-0.5 text-calm-400"
                      title={`Shared across ${n.habits.length} habits`}
                    >
                      <SharedNoteIcon />
                    </span>
                  )}
                  <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-calm-800">
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
          <p className="mt-4 text-sm text-calm-400">No notes yet for this day.</p>
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
          className="mt-1.5 w-full resize-none rounded-xl border border-calm-200 bg-white px-4 py-3 text-sm text-calm-900 placeholder:text-calm-400 focus:border-calm-500 focus:outline-none"
        />

        {/* Optionally attach the new note to other habits too (write a reflection
            once, share it across everything it's about). This habit is always
            included; these are the extras. */}
        {otherHabits.length > 0 && (
          <div className="mt-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-calm-500">
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
                        on
                          ? prev.filter((id) => id !== h.id)
                          : [...prev, h.id],
                      )
                    }
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      on
                        ? "border-calm-500 bg-calm-100 text-calm-700"
                        : "border-calm-200 text-calm-500 hover:bg-calm-50"
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

// A bottom-sheet to create OR edit a routine: set its name and check which
// scheduled habits belong to it. In edit mode it can also delete the routine
// (members are ungrouped, never deleted). `habits` is every scheduled habit with
// its current routine, so we pre-check this routine's members and offer the loose
// (ungrouped) ones to add. Mirrors NoteSheet's overlay/keyboard handling.
function RoutineSheet({
  routine,
  habits,
  onCreate,
  onSave,
  onDelete,
  onClose,
}: {
  routine: { id: number; name: string } | null; // null = create mode
  habits: { scheduleId: number; name: string; routineId: number | null }[];
  onCreate: (name: string, scheduleIds: number[]) => Promise<boolean>;
  onSave: (
    routineId: number,
    name: string,
    addIds: number[],
    removeIds: number[],
  ) => Promise<boolean>;
  onDelete: (routineId: number) => void;
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
  const nameRef = useRef<HTMLInputElement>(null);

  // Habits you can put in this routine: its own members plus any loose
  // (ungrouped) ones. Habits already in a DIFFERENT routine are left out — it's
  // one routine per habit, so you'd remove them from the other one first.
  const choices = habits.filter(
    (h) => h.routineId == null || (routine != null && h.routineId === routine.id),
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
        className="animate-backdrop-in absolute inset-0 bg-calm-900/40"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={routine ? `Edit ${routine.name}` : "New routine"}
        className="animate-sheet-in relative max-h-full w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-6 pb-8 shadow-xl sm:rounded-3xl"
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-calm-200 sm:hidden" />
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
          className="mt-1 w-full rounded-lg border border-calm-200 bg-white px-3 py-2 text-sm text-calm-900 focus:border-calm-500 focus:outline-none"
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
                        ? "border-calm-300 bg-calm-50 text-calm-900"
                        : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50"
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

function PlansPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  // The viewed day's notes from the new Note model (GET /days/notes/). Source of
  // truth for notes; grouped onto each habit via notesByHabit below.
  const [dayNotes, setDayNotes] = useState<DayNote[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // The day being viewed (default: today). ◀/▶ move it; we re-fetch /plan/ for
  // the new day and its statuses come from that day's logs.
  const [viewedDate, setViewedDate] = useState(() => startOfDay(new Date()));
  const isViewingToday = isSameDay(viewedDate, new Date());

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

  // "Important only" view: when on, the plan hides every non-important habit (a
  // low-energy day where you just want the few that matter). Pure display filter
  // — no refetch, nothing logged differently. Persisted like the day-tier.
  const [importantOnly, setImportantOnly] = useState(
    () => localStorage.getItem("importantOnly") === "1",
  );
  useEffect(() => {
    localStorage.setItem("importantOnly", importantOnly ? "1" : "0");
  }, [importantOnly]);

  // Bump to force a re-fetch of the current day (e.g. after a "running late" shift).
  const [reloadToken, setReloadToken] = useState(0);

  // The habit order the viewed day loaded with — the target "Reset order"
  // returns to ("back to before" = how the day looked when you opened it).
  const [baselineOrder, setBaselineOrder] = useState<Plan[] | null>(null);

  // The time block happening right now — used to badge it "Now" and to scroll
  // the page there on first load.
  const nowBlockId = useMemo(() => currentBlockId(plans), [plans]);

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
      plans.flatMap((plan) =>
        plan.habits.map((h) => ({ id: h.id, name: h.name })),
      ),
    [plans],
  );

  // Section keys (plan id, or "anytime") that are collapsed to just their time
  // header. Session-only: plain state, so it resets on reload. Default expanded.
  const [collapsedCycles, setCollapsedCycles] = useState<Set<string>>(
    new Set(),
  );
  // Toggle one section collapsed/expanded. Build a NEW Set so React re-renders.
  function toggleCollapsed(key: string) {
    setCollapsedCycles((prev) => {
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
  const plansRef = useRef(plans);
  useEffect(() => {
    plansRef.current = plans;
  }, [plans]);

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
      plans
        .flatMap((plan) => plan.habits)
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
    [plans],
  );

  // Set a habit's status for today (complete / skip / reset). We update the UI
  // FIRST (optimistic) so it feels instant, then tell the backend. If the
  // request fails we restore the snapshot, so the UI never lies.
  async function setHabitStatus(
    habitId: number,
    status: HabitStatus,
    tier?: number,
  ) {
    const snapshot = plans;
    setPlans((prev) => applyStatus(prev, habitId, status));

    try {
      // Build the body, then add the optional `tier` only on a tiered completion
      // (the backend honors it just with COMPLETED). Untiered habits pass no
      // tier and POST exactly as before.
      const body: {
        status: HabitStatus;
        date?: string;
        tier?: number;
      } = isViewingToday ? { status } : { status, date: toYMD(viewedDate) };
      if (status === "COMPLETED" && tier != null) body.tier = tier;

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
    } catch {
      setPlans(snapshot);
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
            scope === "all" ? { scope: "all" } : { scope: "one", habit: habitId },
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

  // Persist a plan's habit order (no toast). Optimistic, with a snapshot we
  // restore if the save fails. Shared by a drag, its Undo, and Reset order.
  async function postReorder(planId: number, orderedHabits: Habit[]) {
    if (orderedHabits.length === 0) return;
    const snapshot = plansRef.current;
    setPlans((prev) => applyPlanOrder(prev, planId, orderedHabits));

    // Backend keys on schedule_id (NOT habit id) and wants the whole list
    // with fresh 1..N orders. We keep each habit's chain as-is.
    const items = orderedHabits.map((habit, i) => ({
      id: habit.schedule_id,
      order: i + 1,
      chain: habit.chain ?? null,
    }));

    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/schedules/reorder/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items }),
        },
      );
      if (!res.ok) throw new Error("Request failed");
    } catch {
      setPlans(snapshot);
    }
  }

  // Drag entry point: remember the block's order *before* the move, apply it,
  // then offer a one-tap Undo (the app's standard toast pattern, same as retime)
  // that puts the habit back where it was.
  async function reorderPlan(planId: number, orderedHabits: Habit[]) {
    if (orderedHabits.length === 0) return;
    const previousHabits = plans.find((p) => p.id === planId)?.habits ?? [];
    await postReorder(planId, orderedHabits);
    if (previousHabits.length === 0) return;
    toast("Habit moved", {
      action: {
        label: "Undo",
        onClick: () => postReorder(planId, previousHabits),
      },
    });
  }

  // Reorder every schedulable plan to match a template's order, mapping the
  // CURRENT habit objects (so statuses/notes set since aren't clobbered) onto
  // the template's id order. Persists only the plans that actually changed.
  async function applyOrderTemplate(template: Plan[]) {
    for (const plan of plansRef.current) {
      if (plan.id == null) continue; // "Anytime" has no schedule rows to order
      const tpl = template.find((p) => p.id === plan.id);
      if (!tpl) continue;
      const order = tpl.habits.map((h) => h.id);
      const reordered = [...plan.habits].sort(
        (a, b) => order.indexOf(a.id) - order.indexOf(b.id),
      );
      const changed = reordered.some((h, i) => h.id !== plan.habits[i].id);
      if (changed) await postReorder(plan.id, reordered);
    }
  }

  // "Reset order": return the whole day to the order it loaded with ("be like
  // before"), with its own Undo back to the pre-reset arrangement.
  async function resetOrder() {
    const baseline = baselineOrder;
    if (!baseline) return;
    const beforeReset = plansRef.current;
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
    return plans.some((plan) => {
      if (plan.id == null) return false;
      const tpl = baseline.find((p) => p.id === plan.id);
      if (!tpl) return false;
      const now = plan.habits.map((h) => h.id);
      const was = tpl.habits.map((h) => h.id);
      return now.length !== was.length || now.some((id, i) => id !== was[i]);
    });
  }, [plans, baselineOrder]);

  useEffect(() => {
    async function fetchPlans() {
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

        const data = await res.json();
        if (!res.ok) {
          setError(data.error);
          return;
        }
        setPlans(data);
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
    fetchPlans();
    // Re-runs when the viewed day changes, or reloadToken is bumped (e.g. after
    // a "running late" shift) to pull the day's new effective times.
  }, [viewedDate, reloadToken]);

  // "Running late": push a cycle (and everything after it that day) to a later
  // time — negative minutes pulls it earlier. The backend stores a per-day
  // override, never touching the recurring routine. We re-fetch afterward
  // because /plan/ returns the day's new effective times, already re-sorted.
  async function shiftFromPlan(planId: number, minutes: number) {
    const today = isSameDay(viewedDate, new Date());
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/plans/shift/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          today
            ? { from_plan: planId, minutes }
            : { from_plan: planId, minutes, date: toYMD(viewedDate) },
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

  // POST one cycle's new absolute time (a per-day override, like the shift, no
  // cascade) and re-fetch the day — /plan/ returns the new effective times,
  // already re-sorted, so we don't hand-apply. Returns true on success; shared by
  // a drag and by its Undo.
  async function postRetime(planId: number, time: string): Promise<boolean> {
    const today = isSameDay(viewedDate, new Date());
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/plans/retime/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          today
            ? { plan: planId, time }
            : { plan: planId, time, date: toYMD(viewedDate) },
        ),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Couldn't move that cycle");
      }
      setReloadToken((token) => token + 1); // re-fetch the day's new times
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't move that cycle", {
        variant: "error",
      });
      return false;
    }
  }

  // Drag handler: remember the block's time *before* the move, apply it, then
  // offer a one-tap Undo (the app's standard toast pattern, same as Skip day)
  // that puts it back. When there was no override, the previous effective time IS
  // the recurring time — so undoing all the way home clears the override.
  async function retimePlan(planId: number, time: string) {
    const previousTime = plans.find((p) => p.id === planId)?.time ?? null;
    const ok = await postRetime(planId, time);
    if (!ok || previousTime == null) return;
    toast(`Moved to ${formatTime(time)}`, {
      action: { label: "Undo", onClick: () => postRetime(planId, previousTime) },
    });
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

  // After the first load, open the page at the time block happening now, so the
  // user doesn't scroll past the whole morning to reach their current habits.
  useEffect(() => {
    if (didAutoScroll.current || isLoading || plans.length === 0) return;
    // "Now" only means anything on today's view.
    if (!isViewingToday || nowBlockId == null) return;
    const el = sectionRefs.current[String(nowBlockId)];
    if (el) {
      el.scrollIntoView({ block: "start" });
      didAutoScroll.current = true;
    }
  }, [plans, isLoading, nowBlockId, isViewingToday]);

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
  const visiblePlans = useMemo(
    () =>
      plans
        .filter((plan) => plan.habits.length > 0)
        .map((plan) => ({
          ...plan,
          habits: plan.habits.map((habit) => ({
            ...habit,
            dayNotes: notesByHabit.get(habit.id) ?? [],
          })),
        })),
    [plans, notesByHabit],
  );

  // habit id -> the highest Case-A tier-slot level (h.tier, the non-null ones)
  // that is <= dayTier, or null when none qualify. This picks which of a habit's
  // several tier-slots is its "today" version: the one that renders inline, while
  // lower slots are cascade-hidden and higher ones stretch. Untiered + Case-B
  // rows aren't in here (they carry no per-slot tier); slotPlacement handles them.
  const inlineTierByHabit = useMemo(() => {
    const byHabit = new Map<number, number[]>();
    for (const plan of visiblePlans)
      for (const h of plan.habits)
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
  }, [visiblePlans, dayTier]);

  // The same plans, but keeping only the rows that render INLINE for the day:
  // untiered rows, each habit's one Case-A slot at its highest tier <= today, and
  // a Case-B row with a rung <= today. Stretch/hidden slots are dropped; any cycle
  // thereby emptied is removed. This is what we COUNT and decide emptiness from, so
  // headers, the skip-day logic, and the empty state all match what the cards
  // render. PlanBoard still gets the FULL `visiblePlans` list (it filters for
  // display itself) so a reorder never drops a hidden habit from state — only what
  // shows is affected, never what's stored.
  const tierVisiblePlans = useMemo(
    () =>
      visiblePlans
        .map((plan) => ({
          ...plan,
          habits: plan.habits.filter(
            (habit) =>
              slotPlacement(habit, inlineTierByHabit, dayTier) === "inline",
          ),
        }))
        .filter((plan) => plan.habits.length > 0),
    [visiblePlans, inlineTierByHabit, dayTier],
  );

  // What actually renders: the tier-visible plans, further narrowed to important
  // habits when "Important only" is on (empty groups dropped). A pure view filter
  // layered on top of the tier filter — the skip-day/empty logic below still uses
  // the full `tierVisiblePlans`, so the toggle never changes what's stored.
  const shownPlans = useMemo(
    () =>
      !importantOnly
        ? tierVisiblePlans
        : tierVisiblePlans
            .map((plan) => ({
              ...plan,
              habits: plan.habits.filter((habit) => habit.is_important),
            }))
            .filter((plan) => plan.habits.length > 0),
    [tierVisiblePlans, importantOnly],
  );

  // The "Stretch" section: harder versions she can opt into. Two sources, in plan
  // order: (1) Case-A slots that placed as "stretch" (a tier above today that lives
  // at its own time), each completed at its own `tier`; (2) synthesized entries for
  // every Case-B rung ABOVE today (level > dayTier) — same habit, that rung's value,
  // completed at that level. `level` is the tier each card shows + sends. Honors
  // "Important only" like the inline groups.
  const stretchSlots = useMemo(() => {
    const out: { habit: Habit; level: number }[] = [];
    for (const plan of visiblePlans) {
      for (const habit of plan.habits) {
        if (importantOnly && !habit.is_important) continue;
        if (habit.tier != null) {
          // Case A: this slot stretches when it's a harder tier than today.
          if (slotPlacement(habit, inlineTierByHabit, dayTier) === "stretch")
            out.push({ habit, level: habit.tier });
        } else if (isCaseB(habit)) {
          // Case B: one synthesized card per rung above today ("do more").
          for (const t of habit.tiers ?? [])
            if (t.level > dayTier) out.push({ habit, level: t.level });
        }
      }
    }
    return out;
  }, [visiblePlans, inlineTierByHabit, dayTier, importantOnly]);

  // Has the whole day been skipped? (every habit resolved to skipped or done,
  // with at least one skip). If so, the day-level control flips from "Skip day"
  // to a persistent "Reset day" undo — so you can un-skip even after the toast
  // has faded, not just in the few seconds it's on screen.
  const anySkipped = tierVisiblePlans.some((plan) =>
    plan.habits.some((habit) => isSkipped(habit)),
  );
  const dayFullySkipped =
    anySkipped &&
    tierVisiblePlans.every((plan) =>
      plan.habits.every((habit) => isSkipped(habit) || isDone(habit)),
    );

  let body: ReactNode;
  if (isLoading && plans.length === 0) {
    // First load only — when switching days we keep the current list visible
    // (dimmed) instead of flashing a spinner.
    body = (
      <div className="flex items-center justify-center py-12">
        <div className="w-6 h-6 border-2 border-calm-300 border-t-calm-600 rounded-full animate-spin"></div>
        <span className="ml-3 text-stone-400 text-sm">Loading habits...</span>
      </div>
    );
  } else if (error) {
    body = (
      <div className="bg-red-50 rounded-xl p-4 text-center">
        <p className="text-red-500 text-sm">{error}</p>
      </div>
    );
  } else if (tierVisiblePlans.length === 0 && stretchSlots.length === 0) {
    body = (
      <div className="bg-white rounded-2xl p-10 text-center shadow-sm">
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-accent-100 flex items-center justify-center">
          <span className="text-3xl">&#x1F331;</span>
        </div>
        <h3 className="font-heading text-xl text-stone-900 mb-2">
          {plans.length === 0 ? "No habits yet" : "Nothing this day"}
        </h3>
        <p className="text-stone-400 text-sm">
          {plans.length === 0
            ? "Create your first habit to push your limits"
            : "No habits were scheduled for this day"}
        </p>
      </div>
    );
  } else {
    body = (
      <div
        className={`space-y-6 ${isLoading ? "opacity-60 transition-opacity" : ""}`}
      >
        {shownPlans.map((plan) => {
          const key = plan.id ?? "anytime";
          const isNow =
            isViewingToday && plan.id != null && plan.id === nowBlockId;
          // Session-only collapse: hide this cycle's habit list and show just
          // its time + progress in the header. Default expanded.
          const collapsed = collapsedCycles.has(String(key));
          // Progress for the collapsed header — a member counts as handled when
          // it's done OR skipped (same rule RoutineBlock uses). Counts the
          // shown habits, so the header matches the cards (a Roots day excludes
          // hidden Growth; "Important only" excludes the rest).
          const total = plan.habits.length;
          const handled = plan.habits.filter(
            (h) => isDone(h) || isSkipped(h),
          ).length;
          // PlanBoard renders from the FULL plan (all this cycle's habits, hidden
          // ones included) and does its own tier filtering for display — so a
          // reorder rebuilds the whole list and never drops a hidden habit from
          // state. Fall back to the tier-filtered `plan` if no full match (can't
          // happen, but keeps the type non-null).
          const fullPlan = visiblePlans.find((p) => p.id === plan.id) ?? plan;
          // The habit list is identical whether or not the block is retime-able;
          // build it once and drop it into the right wrapper below. Drag the grip
          // to reorder, swipe a card left to skip, tap the circle to complete,
          // tap the note icon to jot a day note; completed ones collapse in place.
          const planBoard = (
            <PlanBoard
              plan={fullPlan}
              dayTier={dayTier}
              inlineTierByHabit={inlineTierByHabit}
              importantOnly={importantOnly}
              onStatus={setHabitStatus}
              onOpenNote={setEditingNote}
              onReorder={reorderPlan}
              onRoutineLog={setRoutineStatus}
              onEditRoutine={(id, name) =>
                setRoutineSheet({ mode: "edit", id, name })
              }
              interactive={isViewingToday}
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
              {plan.id != null && plan.time ? (
                // Timed cycle: the whole block is the unit you retime — grab the
                // header strip and it lifts to a new time (today only).
                <RetimeBlock
                  planId={plan.id}
                  time={plan.time}
                  blockLabel={cycleLabel(plan.habits, plan.time)}
                  otherBlocks={visiblePlans.flatMap((p) =>
                    p.id !== plan.id && p.time
                      ? [
                          {
                            min: timeToMinutes(p.time),
                            name: cycleLabel(p.habits, p.time),
                          },
                        ]
                      : [],
                  )}
                  onRetime={retimePlan}
                  header={
                    <div className="flex items-center gap-3 mb-2">
                      {/* Collapse/expand this cycle. Carries data-no-retime so
                          tapping it toggles instead of starting a time-drag. */}
                      <button
                        type="button"
                        data-no-retime
                        onClick={() => toggleCollapsed(String(key))}
                        aria-expanded={!collapsed}
                        aria-label={
                          collapsed
                            ? `Expand ${formatTime(plan.time)}`
                            : `Collapse ${formatTime(plan.time)}`
                        }
                        className="shrink-0 text-calm-400 transition-colors hover:text-calm-600"
                      >
                        <ChevronIcon open={!collapsed} />
                      </button>
                      {/* Time label + a drag hint; the whole strip is grabbable. */}
                      <span
                        className={`inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide ${
                          isNow ? "text-calm-700" : "text-calm-600"
                        }`}
                      >
                        {formatTime(plan.time)}
                        {collapsed ? (
                          <span className="normal-case tracking-normal text-calm-400">
                            · {handled}/{total} done
                          </span>
                        ) : (
                          <span className="text-calm-300">
                            <RetimeHandleIcon />
                          </span>
                        )}
                      </span>
                      {isNow && (
                        <span className="rounded-full bg-calm-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                          Now
                        </span>
                      )}
                      <div className="flex-1 h-px bg-calm-200" />
                      {/* "Running late" shift stays tappable — opt it out of the
                          block's retime drag. */}
                      <div data-no-retime>
                        <ShiftControl planId={plan.id} onShift={shiftFromPlan} />
                      </div>
                    </div>
                  }
                >
                  {collapsed ? null : planBoard}
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
                          ? `Expand ${formatTime(plan.time)}`
                          : `Collapse ${formatTime(plan.time)}`
                      }
                      className="shrink-0 text-calm-400 transition-colors hover:text-calm-600"
                    >
                      <ChevronIcon open={!collapsed} />
                    </button>
                    <span className="inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-calm-600">
                      {formatTime(plan.time)}
                      {collapsed && (
                        <span className="normal-case tracking-normal text-calm-400">
                          · {handled}/{total} done
                        </span>
                      )}
                    </span>
                    <div className="flex-1 h-px bg-calm-200" />
                  </div>
                  {!collapsed && planBoard}
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
              <span className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">
                Stretch
              </span>
              <span className="text-[11px] text-stone-300">
                harder versions — do more if you want
              </span>
            </div>
            <ul className="space-y-1.5">
              {stretchSlots.map(({ habit, level }) => (
                <li key={`stretch-${habit.id}-${level}`}>
                  <SwipeableCard
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
    );
  }

  return (
    <>
      <div className="max-w-md mx-auto">
        {/* The date selector doubles as the page header — the big day label is
            the title, so there's no separate hero taking up space. */}
        <DateNav
          date={viewedDate}
          onPrev={() => setViewedDate((d) => addDays(d, -1))}
          onNext={() => setViewedDate((d) => addDays(d, 1))}
          onToday={() => setViewedDate(startOfDay(new Date()))}
        />
        {/* Day-level control. Skip the whole day at once, or — once it's
            skipped — a persistent "Reset day" to undo it (no time limit, unlike
            the toast). Per-habit skip is still the swipe gesture. */}
        {visiblePlans.length > 0 && (
          <div className="-mt-2 mb-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setRoutineSheet({ mode: "create" })}
                className="text-[11px] font-medium uppercase tracking-wide text-calm-500 transition-colors hover:text-calm-700"
              >
                + New routine
              </button>
              {/* Day-tier toggle: Roots = the hard/minimum day, Growth = the
                  everyday bar. Sets which rung every tiered habit shows + logs
                  at; a Growth-only habit hides on a Roots day. The active side is
                  highlighted; same small uppercase chrome as the row's controls. */}
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setDayTier(ROOTS_LEVEL)}
                  aria-pressed={dayTier === ROOTS_LEVEL}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide transition-colors ${
                    dayTier === ROOTS_LEVEL
                      ? "bg-calm-100 text-calm-700"
                      : "text-calm-400 hover:text-calm-600"
                  }`}
                >
                  Roots
                </button>
                <button
                  type="button"
                  onClick={() => setDayTier(GROWTH_LEVEL)}
                  aria-pressed={dayTier === GROWTH_LEVEL}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide transition-colors ${
                    dayTier === GROWTH_LEVEL
                      ? "bg-calm-100 text-calm-700"
                      : "text-calm-400 hover:text-calm-600"
                  }`}
                >
                  Growth
                </button>
              </div>
              {/* "Important only": hide everything except starred habits, for a
                  low-energy day when you just want the few that matter. Pure view
                  filter — toggles instantly, persists, changes nothing stored. */}
              <button
                type="button"
                onClick={() => setImportantOnly((v) => !v)}
                aria-pressed={importantOnly}
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide transition-colors ${
                  importantOnly
                    ? "bg-amber-100 text-amber-700"
                    : "text-calm-400 hover:text-calm-600"
                }`}
              >
                Important only
              </button>
              {/* Only today is reorderable, so only offer the reset there, and
                  only once something has actually moved from the load order. */}
              {isViewingToday && orderChanged && (
                <button
                  type="button"
                  onClick={resetOrder}
                  className="text-[11px] font-medium uppercase tracking-wide text-calm-500 transition-colors hover:text-calm-700"
                >
                  Reset order
                </button>
              )}
            </div>
            {dayFullySkipped ? (
              <button
                type="button"
                onClick={() => clearDay(viewedDate)}
                className="text-[11px] font-medium uppercase tracking-wide text-calm-500 transition-colors hover:text-calm-700"
              >
                Reset day
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setSkipDayOpen(true)}
                className="text-[11px] font-medium uppercase tracking-wide text-stone-400 transition-colors hover:text-rose-500"
              >
                Skip day
              </button>
            )}
          </div>
        )}
        {body}
      </div>

      <FloatingControls
        onGoToNow={
          isViewingToday && nowBlockId != null ? scrollToNow : undefined
        }
        getNowTop={() =>
          nowBlockId != null
            ? sectionRefs.current[String(nowBlockId)]?.getBoundingClientRect()
                .top ?? null
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
          onCreate={createRoutine}
          onSave={saveRoutine}
          onDelete={deleteRoutine}
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
    </>
  );
}

export default PlansPage;
