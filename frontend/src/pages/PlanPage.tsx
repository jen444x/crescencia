import {
  useState,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Header from "../components/layout/Header";
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

// The three states a habit can be in for a given day. Matches the backend's
// HabitLog.Status values.
type HabitStatus = "PENDING" | "COMPLETED" | "SKIPPED";

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
  // Today's status from the backend. `done_today` is the convenience boolean
  // (status === "COMPLETED"); we keep both since the API sends both.
  status?: HabitStatus;
  done_today?: boolean;
};

// Read a habit's state, tolerating an older payload that only had done_today.
function isDone(habit: Habit) {
  return habit.status ? habit.status === "COMPLETED" : !!habit.done_today;
}
function isSkipped(habit: Habit) {
  return habit.status === "SKIPPED";
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

// Keep only the rows we want to show now (the not-completed ones), but RECOMPUTE
// `connectBelow` against the next *visible* row, so a chain's connector never
// dangles toward a habit we've collapsed away. Step numbers keep their true
// position in the full chain (so finishing step 1 honestly leaves "2, 3").
function keepRows(rows: Row[], keep: (row: Row) => boolean): Row[] {
  const kept = rows.filter(keep);
  return kept.map((row, i) => {
    const next = kept[i + 1];
    const connectBelow =
      row.habit.chain != null &&
      next != null &&
      next.habit.chain === row.habit.chain;
    return { ...row, connectBelow };
  });
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

function HabitCard({
  habit,
  onStatus,
  handle,
}: {
  habit: Habit;
  onStatus: (habitId: number, status: HabitStatus) => void;
  // Optional drag handle (a grip), rendered at the left inside the card.
  handle?: ReactNode;
}) {
  const done = isDone(habit);
  const skipped = isSkipped(habit);
  return (
    <div
      className={`group flex items-center gap-3 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow cursor-pointer ${
        done ? "bg-calm-50" : skipped ? "bg-stone-50" : "bg-white"
      }`}
    >
      {handle}
      <h3
        className={`flex-1 font-medium ${
          done
            ? "text-calm-400 line-through"
            : skipped
              ? "text-stone-400"
              : "text-calm-900"
        }`}
      >
        {habit.name}
      </h3>

      {skipped && (
        <span className="shrink-0 rounded-full bg-stone-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stone-500">
          Skipped
        </span>
      )}

      {/* Complete toggle. data-no-swipe + stopPropagation so tapping it neither
          starts a swipe nor opens the detail page. */}
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
    </div>
  );
}

// Wraps a habit card with a horizontal swipe gesture:
//   swipe left  -> SKIPPED
//   swipe right -> PENDING (reset / un-skip)
// A plain tap opens the habit. We hand-roll this with pointer events so it
// coexists with the drag handle (grip) and the complete button, both of which
// are marked data-no-swipe and ignored here.
const SWIPE_TRIGGER = 70; // px past which a release fires the action
const SWIPE_MAX = 110; // px the card is allowed to follow your finger

function SwipeableCard({
  habit,
  onStatus,
  handle,
}: {
  habit: Habit;
  onStatus: (habitId: number, status: HabitStatus) => void;
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
    setDx(Math.max(-SWIPE_MAX, Math.min(SWIPE_MAX, delta)));
  }
  function onPointerEnd() {
    if (startX.current == null) return;
    if (dx <= -SWIPE_TRIGGER) onStatus(habit.id, "SKIPPED");
    else if (dx >= SWIPE_TRIGGER) onStatus(habit.id, "PENDING");
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
        dx < -8 ? "bg-amber-100" : dx > 8 ? "bg-calm-100" : ""
      }`}
    >
      {/* Action hints revealed behind the card as it slides. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-5 text-xs font-semibold uppercase tracking-wide">
        <span className={dx > 8 ? "text-calm-600" : "opacity-0"}>Reset</span>
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
        <HabitCard habit={habit} onStatus={onStatus} handle={handle} />
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
  handle,
  nodeRef,
  style,
}: {
  habit: Habit;
  stepNumber: number | null;
  connectBelow: boolean;
  onStatus: (habitId: number, status: HabitStatus) => void;
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
      <div className="flex-1 pb-2">
        <SwipeableCard habit={habit} onStatus={onStatus} handle={handle} />
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
}: {
  habit: Habit;
  stepNumber: number | null;
  connectBelow: boolean;
  onStatus: (habitId: number, status: HabitStatus) => void;
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
      handle={handle}
      nodeRef={setNodeRef}
      style={style}
    />
  );
}

// A non-draggable habit row (the "Anytime" group, which has no schedules).
function StaticRow({
  habit,
  onStatus,
}: {
  habit: Habit;
  onStatus: (habitId: number, status: HabitStatus) => void;
}) {
  return (
    <RowLayout
      habit={habit}
      stepNumber={null}
      connectBelow={false}
      onStatus={onStatus}
    />
  );
}

// One completed habit in the collapsed tray: compact, faded, still tappable.
// The filled check resets it to PENDING and sends it back up to the active list.
function CompletedRow({
  habit,
  onStatus,
}: {
  habit: Habit;
  onStatus: (habitId: number, status: HabitStatus) => void;
}) {
  const navigate = useNavigate();
  return (
    <div
      onClick={() => navigate(`/habits/${habit.id}`)}
      className="flex cursor-pointer items-center gap-3 rounded-lg px-4 py-2 hover:bg-white"
    >
      <span className="flex-1 text-sm text-calm-400 line-through">
        {habit.name}
      </span>
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

// The collapsed "done" tray at the bottom of a time block. Completed habits
// would otherwise pile up and push the rest of the day off-screen, so we tuck
// them here — one tap to expand, review, or undo. Collapsed by default.
function CompletedTray({
  habits,
  onStatus,
}: {
  habits: Habit[];
  onStatus: (habitId: number, status: HabitStatus) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-xs font-medium text-calm-500 transition-colors hover:text-calm-700"
      >
        <ChevronIcon open={open} />
        <span>{habits.length} done</span>
        <span className="h-px flex-1 bg-calm-200" />
      </button>

      {open && (
        <ul className="mt-0.5 space-y-0.5">
          {habits.map((habit) => (
            <li key={habit.id}>
              <CompletedRow habit={habit} onStatus={onStatus} />
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
  onReorder,
}: {
  plan: Plan;
  onStatus: (habitId: number, status: HabitStatus) => void;
  onReorder: (planId: number, orderedHabits: Habit[]) => void;
}) {
  // Require a 6px drag before a pointer-down counts as a drag, so a plain tap
  // still works as a click (toggle / open detail).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const planId = plan.id;
  const habits = plan.habits;

  // Number chains over the FULL list (so step numbers are real positions), then
  // pull completed habits out of the active list and into the tray below.
  const allRows = buildRows(habits);
  const activeRows = keepRows(allRows, (row) => !isDone(row.habit));
  const doneHabits = habits.filter(isDone);

  const tray =
    doneHabits.length > 0 ? (
      <div className={activeRows.length > 0 ? "mt-1" : ""}>
        <CompletedTray habits={doneHabits} onStatus={onStatus} />
      </div>
    ) : null;

  // The "Anytime" group has no schedule rows, so it can't be reordered.
  if (planId == null) {
    return (
      <div>
        <ul>
          {activeRows.map((row) => (
            <li key={row.habit.id}>
              <StaticRow habit={row.habit} onStatus={onStatus} />
            </li>
          ))}
        </ul>
        {tray}
      </div>
    );
  }

  // Drag only reorders the visible (not-completed) habits; completed habits keep
  // their spot. On drop we rebuild the FULL list — visible habits in their new
  // order, completed ones left where they were — so reorderPlan can renumber and
  // persist the whole block in one POST.
  const activeHabits = habits.filter((habit) => !isDone(habit));
  const activeIds = activeHabits.map((habit) => habit.id);

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
    <div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={activeIds}
          strategy={verticalListSortingStrategy}
        >
          <ul>
            {activeRows.map((row) => (
              <li key={row.habit.id}>
                <SortableRow
                  habit={row.habit}
                  stepNumber={row.stepNumber}
                  connectBelow={row.connectBelow}
                  onStatus={onStatus}
                />
              </li>
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {tray}
    </div>
  );
}

function PlansPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // The time block happening right now — used to badge it "Now" and to scroll
  // the page there on first load.
  const nowBlockId = useMemo(() => currentBlockId(plans), [plans]);

  // One DOM node per section, so we can scroll the current block into view.
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  // Only auto-scroll once (on first load) — not every time a toggle re-renders.
  const didAutoScroll = useRef(false);

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
          body: JSON.stringify({ status }),
        },
      );
      if (!res.ok) throw new Error("Request failed");
    } catch {
      setPlans(snapshot);
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

      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL}/plan/`, {
          method: "GET",
          headers: {},
        });

        const data = await res.json();
        if (!res.ok) {
          setError(data.error);
          return;
        }
        setPlans(data);
      } catch (error) {
        setError(
          error instanceof Error ? error.message : "An unknown error occurred",
        );
      } finally {
        setIsLoading(false);
      }
    }
    fetchPlans();
  }, []);

  // After the first load, open the page at the time block happening now, so the
  // user doesn't scroll past the whole morning to reach their current habits.
  useEffect(() => {
    if (didAutoScroll.current || isLoading || plans.length === 0) return;
    if (nowBlockId == null) return;
    const el = sectionRefs.current[String(nowBlockId)];
    if (el) {
      el.scrollIntoView({ block: "start" });
      didAutoScroll.current = true;
    }
  }, [plans, isLoading, nowBlockId]);

  if (isLoading) {
    return (
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-center py-12">
          <div className="w-6 h-6 border-2 border-calm-300 border-t-calm-600 rounded-full animate-spin"></div>
          <span className="ml-3 text-stone-400 text-sm">Loading habits...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-md mx-auto">
        <div className="bg-red-50 rounded-xl p-4 text-center">
          <p className="text-red-500 text-sm">{error}</p>
        </div>
      </div>
    );
  }

  if (plans.length === 0) {
    return (
      <div className="max-w-md mx-auto">
        <div className="bg-white rounded-2xl p-10 text-center shadow-sm">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-accent-100 flex items-center justify-center">
            <span className="text-3xl">&#x1F331;</span>
          </div>
          <h3 className="font-heading text-xl text-stone-900 mb-2">
            No habits yet
          </h3>
          <p className="text-stone-400 text-sm">
            Create your first habit to push your limits
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <Header title="Plan" body="" />
      <div className="max-w-md mx-auto space-y-8">
        {plans.map((plan) => {
          const key = plan.id ?? "anytime";
          const isNow = plan.id != null && plan.id === nowBlockId;
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
              <div className="flex items-center gap-3 mb-3">
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
              </div>

              {/* Habits at this time. Drag the grip to reorder, swipe a card
                  left to skip / right to reset, tap the circle to complete;
                  completed ones collapse into the tray below. */}
              <PlanBoard
                plan={plan}
                onStatus={setHabitStatus}
                onReorder={reorderPlan}
              />
            </section>
          );
        })}
      </div>
    </>
  );
}

export default PlansPage;
