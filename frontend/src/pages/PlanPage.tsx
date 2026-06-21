import {
  useState,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
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

// "08:30:00" -> 510 (minutes since midnight). Used to find which time block
// is "now" so we can open the page there.
function timeToMinutes(time: string): number {
  const [hourStr, minuteStr] = time.split(":");
  return parseInt(hourStr, 10) * 60 + parseInt(minuteStr, 10);
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

// Walk a plan's habits (already in display order) and tag each one with its
// chain step number + whether it links to the next row.
function buildRows(habits: Habit[]): Row[] {
  const counts = new Map<number, number>(); // chain id -> steps seen so far
  return habits.map((habit, i) => {
    let stepNumber: number | null = null;
    if (habit.chain != null) {
      const n = (counts.get(habit.chain) ?? 0) + 1;
      counts.set(habit.chain, n);
      stepNumber = n;
    }
    const next = habits[i + 1];
    const connectBelow =
      habit.chain != null && next != null && next.chain === habit.chain;
    return { habit, stepNumber, connectBelow };
  });
}

// A time block renders as an ordered list of segments: either a single active
// (not-yet-completed) habit, or a "done" group — a RUN of consecutive completed
// habits collapsed together IN PLACE. So finishing the top 3 makes one "3 done"
// group at the top; if a pending habit sits between completed ones, you get two
// separate groups in their own spots (they don't merge across the gap).
type Segment =
  | { kind: "active"; row: Row }
  | { kind: "done"; key: string; habits: Habit[] };

function buildSegments(habits: Habit[]): Segment[] {
  const rows = buildRows(habits); // true step numbers, over the full list
  const segments: Segment[] = [];
  let run: Habit[] = []; // the completed habits piling up since the last active one

  const flushRun = () => {
    if (run.length > 0) {
      segments.push({ kind: "done", key: `done-${run[0].id}`, habits: run });
      run = [];
    }
  };

  rows.forEach((row, i) => {
    if (isDone(row.habit)) {
      run.push(row.habit);
      return;
    }
    flushRun();
    // Only connect down to the next habit when it's the immediately-following,
    // still-active step of the same chain — so the connector never dangles into
    // a collapsed group below it.
    const next = habits[i + 1];
    const connectBelow =
      row.habit.chain != null &&
      next != null &&
      !isDone(next) &&
      next.chain === row.habit.chain;
    segments.push({ kind: "active", row: { ...row, connectBelow } });
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

// How many of a habit's notes to preview inline before collapsing to "+N more".
const MAX_PREVIEW_NOTES = 3;

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

function HabitCard({
  habit,
  onStatus,
  onOpenNote,
  handle,
}: {
  habit: Habit;
  onStatus: (habitId: number, status: HabitStatus) => void;
  // Open the per-day note editor for this habit.
  onOpenNote: (habit: Habit) => void;
  // Optional drag handle (a grip), rendered at the left inside the card.
  handle?: ReactNode;
}) {
  const done = isDone(habit);
  const skipped = isSkipped(habit);
  const missed = isMissed(habit);
  // Notes come from the new Note model; fall back to the legacy per-habit string
  // while /days/notes/ rolls out (shown as a single unshared line). `hasNotes`
  // drives the icon accent; the preview shows up to MAX_PREVIEW_NOTES lines.
  const dayNotes = habit.dayNotes ?? [];
  const legacyNote = habit.notes?.trim() ?? "";
  const hasNotes = dayNotes.length > 0 || legacyNote !== "";
  const shownNotes = dayNotes.slice(0, MAX_PREVIEW_NOTES);
  const extraNotes = dayNotes.length - shownNotes.length;
  return (
    <div
      className={`group flex items-center gap-3 rounded-xl px-4 py-3 shadow-sm hover:shadow-md transition-shadow cursor-pointer ${
        done
          ? "bg-calm-50"
          : skipped
            ? "bg-stone-50"
            : missed
              ? "bg-rose-50"
              : "bg-white"
      }`}
    >
      {handle}
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
        </h3>
        {/* A glance at the day's notes; tap the note button to edit them. A
            shared note (attached to more than one habit) gets a link glyph. */}
        {dayNotes.length > 0 ? (
          <ul className="mt-0.5 space-y-0.5">
            {shownNotes.map((n) => (
              <li
                key={n.id}
                className="flex items-center gap-1 text-xs italic text-stone-400"
                title={n.shared ? "Shared across habits" : undefined}
              >
                {n.shared && <SharedNoteIcon />}
                <span className="min-w-0 truncate">{n.body.trim()}</span>
              </li>
            ))}
            {extraNotes > 0 && (
              <li className="text-xs italic text-stone-400">+{extraNotes} more</li>
            )}
          </ul>
        ) : (
          legacyNote && (
            <p className="mt-0.5 truncate text-xs italic text-stone-400">
              {legacyNote}
            </p>
          )
        )}
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
            onStatus(habit.id, done ? "PENDING" : "COMPLETED");
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
  onStatus,
  onOpenNote,
  handle,
}: {
  habit: Habit;
  onStatus: (habitId: number, status: HabitStatus) => void;
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
      {/* "Skip" hint revealed on the right as the card slides left. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-end px-5 text-xs font-semibold uppercase tracking-wide">
        <span className={dx < -8 ? "text-amber-700" : "opacity-0"}>Skip</span>
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
  stepNumber,
  connectBelow,
  onStatus,
  onOpenNote,
  handle,
  nodeRef,
  style,
}: {
  habit: Habit;
  stepNumber: number | null;
  connectBelow: boolean;
  onStatus: (habitId: number, status: HabitStatus) => void;
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
  stepNumber,
  connectBelow,
  onStatus,
  onOpenNote,
}: {
  habit: Habit;
  stepNumber: number | null;
  connectBelow: boolean;
  onStatus: (habitId: number, status: HabitStatus) => void;
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
  onStatus: (habitId: number, status: HabitStatus) => void;
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
  onStatus: (habitId: number, status: HabitStatus) => void;
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

// All of one plan's habits. Not-yet-completed habits show as the active list (a
// drag-to-reorder list for scheduled plans; a plain list for "Anytime"), and
// completed habits collapse into the tray below so they stop taking up space.
function PlanBoard({
  plan,
  onStatus,
  onOpenNote,
  onReorder,
  interactive,
}: {
  plan: Plan;
  onStatus: (habitId: number, status: HabitStatus) => void;
  onOpenNote: (habit: Habit) => void;
  onReorder: (planId: number, orderedHabits: Habit[]) => void;
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
  const habits = plan.habits;
  // Not reorderable when it's the "Anytime" group (no schedule rows) or any day
  // that isn't today (see `interactive` above).
  const canReorder = planId != null && interactive;

  // Split the block into ordered segments: single active habits + in-place
  // "done" groups (runs of consecutive completed habits). Drag still reorders
  // only the active habits; completed ones keep their exact spot.
  const segments = buildSegments(habits);
  const activeHabits = habits.filter((habit) => !isDone(habit));

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

  if (!canReorder) {
    return (
      <ul>
        {segments.map((seg) =>
          seg.kind === "done" ? (
            doneItem(seg)
          ) : (
            <li key={seg.row.habit.id}>
              {/* Non-draggable, but still shows chain step numbers/connectors. */}
              <RowLayout
                habit={seg.row.habit}
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

  // On drop we rebuild the FULL list — active habits in their new order,
  // completed ones left exactly where they were — so reorderPlan can renumber
  // and persist the whole block in one POST.
  function handleDragEnd(event: DragEndEvent) {
    if (planId == null) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = activeHabits.findIndex((h) => h.id === Number(active.id));
    const to = activeHabits.findIndex((h) => h.id === Number(over.id));
    if (from < 0 || to < 0) return;

    const newActive = arrayMove(activeHabits, from, to);
    let next = 0;
    const newFull = habits.map((habit) =>
      isDone(habit) ? habit : newActive[next++],
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
            ) : (
              <li key={seg.row.habit.id}>
                <SortableRow
                  habit={seg.row.habit}
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

// Floating bottom-right controls: "Now" jumps to the current time block (the page
// auto-scrolls there on load, but you can re-center anytime), and "↑" goes back
// to the top. "Now" only shows on today's view; "↑" appears once you've scrolled
// down.
function FloatingControls({ onGoToNow }: { onGoToNow?: () => void }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 300);
    onScroll(); // we may already be scrolled (auto-scroll-to-now ran on load)
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!onGoToNow && !scrolled) return null;

  return (
    <div className="fixed bottom-28 right-6 z-20 flex flex-col items-end gap-2">
      {onGoToNow && (
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
  notes,
  dateLabel,
  onCreate,
  onEdit,
  onDelete,
  onClose,
}: {
  habit: Habit;
  // LIVE notes for this habit (from notesByHabit) — re-read each render so the
  // list stays current as notes are added/removed while the sheet is open.
  notes: DayNote[];
  dateLabel: string;
  onCreate: (body: string) => Promise<boolean>;
  onEdit: (noteId: number, body: string) => Promise<boolean>;
  onDelete: (noteId: number) => void;
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
  const taRef = useRef<HTMLTextAreaElement>(null);

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
    const ok = await onCreate(body);
    setSaving(false);
    if (ok) {
      setText("");
      taRef.current?.focus();
    }
  }

  // Save an inline edit; close the editor only if the save sticks.
  async function saveEdit(noteId: number) {
    const body = editText.trim();
    if (!body || editSaving) return;
    setEditSaving(true);
    const ok = await onEdit(noteId, body);
    setEditSaving(false);
    if (ok) setEditingId(null);
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
            marked; deleting it here detaches just this habit. Editing arrives in
            the next step — for now a note is add-or-delete. */}
        {notes.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {notes.map((n) =>
              editingId === n.id ? (
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
                  <div className="mt-2 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="rounded-lg px-3 py-1.5 text-xs font-medium text-calm-600 transition-colors hover:bg-calm-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => saveEdit(n.id)}
                      disabled={editText.trim() === "" || editSaving}
                      className="rounded-lg bg-calm-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-calm-700 disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                </li>
              ) : (
                <li
                  key={n.id}
                  className="flex items-start gap-2 rounded-xl border border-calm-100 bg-calm-50 px-3 py-2"
                >
                  {n.shared && (
                    <span
                      className="mt-0.5 text-calm-400"
                      title="Shared across habits"
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
                    onClick={() => onDelete(n.id)}
                    className="shrink-0 text-xs font-medium text-rose-500 transition-colors hover:text-rose-600"
                  >
                    Delete
                  </button>
                </li>
              ),
            )}
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

  // Bump to force a re-fetch of the current day (e.g. after a "running late" shift).
  const [reloadToken, setReloadToken] = useState(0);

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

  // One DOM node per section, so we can scroll the current block into view.
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  // Only auto-scroll once (on first load) — not every time a toggle re-renders.
  const didAutoScroll = useRef(false);

  const toast = useToast();

  // The habit whose per-day note is being edited (null = sheet closed), and
  // whether the "Skip day" confirmation dialog is open.
  const [editingNote, setEditingNote] = useState<Habit | null>(null);
  const [skipDayOpen, setSkipDayOpen] = useState(false);

  // Set a habit's status for today (complete / skip / reset). We update the UI
  // FIRST (optimistic) so it feels instant, then tell the backend. If the
  // request fails we restore the snapshot, so the UI never lies.
  async function setHabitStatus(habitId: number, status: HabitStatus) {
    const snapshot = plans;
    setPlans((prev) => applyStatus(prev, habitId, status));

    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/habits/${habitId}/log/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Omit date on today so the server stamps its own "today" (its call to
          // make, per the contract); send it only when logging another day.
          body: JSON.stringify(
            isViewingToday ? { status } : { status, date: toYMD(viewedDate) },
          ),
        },
      );
      if (!res.ok) throw new Error("Request failed");
    } catch {
      setPlans(snapshot);
    }
  }

  // Create a new note for this habit via the new Note model. Returns true on
  // success so the sheet can clear its field. Not optimistic — the server
  // assigns the note id, so we add the note once it comes back.
  async function createNote(habitId: number, body: string): Promise<boolean> {
    const text = body.trim();
    if (!text) return false;
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/notes/create/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isViewingToday
            ? { body: text, habits: [habitId] }
            : { body: text, habits: [habitId], date: toYMD(viewedDate) },
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
  async function deleteNote(noteId: number, habitId: number) {
    const snapshot = dayNotes;
    setDayNotes((prev) =>
      prev.flatMap((n) => {
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
          body: JSON.stringify({ scope: "one", habit: habitId }),
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

  // Persist a plan's new habit order after a drag. `orderedHabits` is the
  // plan's habits in their new order. Optimistic, with a snapshot we restore
  // if the save fails.
  async function reorderPlan(planId: number, orderedHabits: Habit[]) {
    if (orderedHabits.length === 0) return;
    const snapshot = plans;
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

  // Has the whole day been skipped? (every habit resolved to skipped or done,
  // with at least one skip). If so, the day-level control flips from "Skip day"
  // to a persistent "Reset day" undo — so you can un-skip even after the toast
  // has faded, not just in the few seconds it's on screen.
  const anySkipped = visiblePlans.some((plan) =>
    plan.habits.some((habit) => isSkipped(habit)),
  );
  const dayFullySkipped =
    anySkipped &&
    visiblePlans.every((plan) =>
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
  } else if (visiblePlans.length === 0) {
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
        {visiblePlans.map((plan) => {
          const key = plan.id ?? "anytime";
          const isNow =
            isViewingToday && plan.id != null && plan.id === nowBlockId;
          return (
            <section
              key={key}
              ref={(el) => {
                sectionRefs.current[String(key)] = el;
              }}
              // Leave a little breathing room above the block when we scroll to it.
              className="scroll-mt-6"
            >
              {/* Time label with a divider line; the current block gets a "Now" badge */}
              <div className="flex items-center gap-3 mb-2">
                <span
                  className={`text-xs font-medium uppercase tracking-wide ${
                    isNow ? "text-calm-700" : "text-calm-600"
                  }`}
                >
                  {formatTime(plan.time)}
                </span>
                {isNow && (
                  <span className="rounded-full bg-calm-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                    Now
                  </span>
                )}
                <div className="flex-1 h-px bg-calm-200" />
                {/* "Running late" shift — only on real timed cycles */}
                {plan.id != null && plan.time && (
                  <ShiftControl planId={plan.id} onShift={shiftFromPlan} />
                )}
              </div>

              {/* Habits at this time. Drag the grip to reorder, swipe a card
                  left to skip, tap the circle to complete, tap the note icon to
                  jot a day note; completed ones collapse in place. */}
              <PlanBoard
                plan={plan}
                onStatus={setHabitStatus}
                onOpenNote={setEditingNote}
                onReorder={reorderPlan}
                interactive={isViewingToday}
              />
            </section>
          );
        })}
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
          <div className="-mt-2 mb-4 flex justify-end">
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
      />

      {/* Per-day note editor (bottom sheet). */}
      {editingNote && (
        <NoteSheet
          habit={editingNote}
          notes={notesByHabit.get(editingNote.id) ?? []}
          dateLabel={dayLabel(viewedDate)}
          onCreate={(body) => createNote(editingNote.id, body)}
          onEdit={(noteId, body) => editNote(noteId, editingNote.id, body, "one")}
          onDelete={(noteId) => deleteNote(noteId, editingNote.id)}
          onClose={() => setEditingNote(null)}
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
