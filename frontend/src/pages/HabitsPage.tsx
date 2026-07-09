import {
  useState,
  useEffect,
  useCallback,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import Header from "../components/layout/Header";
import AspirationDots from "../components/AspirationDots";
import { CARD, SEG, segOption, HEADER_ACTION } from "../components/ui";
import { useToast } from "../components/Toast";
import { useNavigate } from "react-router-dom";
import {
  DndContext,
  closestCenter,
  MouseSensor,
  TouchSensor,
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
import { DateNav } from "./plan/components/DateNav";
import PlantWidget from "./plan/components/PlantWidget";
import { startOfDay, toYMD, addDays, isSameDay } from "./plan/dates";

// The statuses for a habit's day (matches the backend HabitLog). MISSED is now
// settable too (not just derived for past days).
type HabitStatus = "PENDING" | "COMPLETED" | "SKIPPED" | "MISSED";

// One tier of a habit (e.g. Roots / Growth) with its current target value and
// TODAY's per-version state. The backend folds the higher-completes-lower
// cascade into `done`/`status`, so a row reads its own tier here.
type HabitTier = {
  level: number; // per-habit ladder position (1..N)
  name: string; // the tag's display ("Roots"/"Growth"), "" if untagged
  label: number | null; // tag level 1=Roots / 2=Growth, null = untagged
  value: string;
  version: number; // the rung's id — what a completion sends
  status?: HabitStatus;
  done?: boolean;
};

// A habit from GET /habits/ : the habit plus today's tracking state. `tiers` is
// [] for an untiered habit; each tier carries its own done/status. `status` is
// the whole-habit view (done if any version is done).
type HabitRow = {
  id: number;
  name: string;
  area: number | null;
  area_name: string | null;
  is_support: boolean;
  // The retirement date ("stopped" via the Edit page), or null if active. Only
  // populated when the list is fetched with ?include_ended=1 (Show ended on);
  // these rows are shown in their own "Stopped" section with a Resume button.
  ended_on: string | null;
  tiers: HabitTier[];
  status: HabitStatus;
  // Aspiration ids this habit serves — rendered as bloom dots in the
  // aspiration's bed color next to the name.
  aspirations: number[];
};

// A routine group (id + name) from GET /routines/, for the "Add to routine"
// picker in the tap menu.
type Routine = { id: number; name: string };

// A habit's current routine membership, derived from the recurring schedule.
// `scheduleIds` are the Schedule rows the member endpoints tag (a habit can have
// more than one slot); empty means the habit isn't on the schedule, so it can't
// be grouped yet.
type HabitRoutine = {
  routineId: number | null;
  routineName: string | null;
  scheduleIds: number[];
};

// Which tier row sits on top inside each habit's card (ROOTS first by default;
// pick GROWTH to flip the order).
type TierFocus = "ROOTS" | "GROWTH";


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

// A dash — the status-dot glyph for a SKIPPED slot (neutral / on purpose).
function DashIcon() {
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
        d="M6 12h12"
      />
    </svg>
  );
}

// An X — the status-dot glyph for a MISSED slot.
function XIcon() {
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
        d="M7 7l10 10M17 7L7 17"
      />
    </svg>
  );
}

// Drag-handle grip (six dots). Same icon as the Plan page's reorder handle, so
// "grab here to drag" reads the same across the app.
function GripIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
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

// One row inside a habit's card: the habit's name + this tier's target value +
// a complete/undo control. `level` null means the habit is untiered and the row
// reads the whole-habit status. Tiered rows read their own per-version state
// (the backend folds in the cascade, so completing Growth marks Roots done).
function HabitTierRow({
  habit,
  level,
  onLog,
  expander,
}: {
  habit: HabitRow;
  level: number | null;
  onLog: (habitId: number, status: HabitStatus, tier?: number) => void;
  expander?: ReactNode;
}) {
  const tier =
    level == null ? undefined : habit.tiers.find((t) => t.level === level);
  const done =
    level == null ? habit.status === "COMPLETED" : (tier?.done ?? false);
  // The other settable states. SKIPPED/MISSED render their own tint + badge
  // (matching the Plan page) instead of looking like plain pending.
  const rowStatus = level == null ? habit.status : tier?.status;
  const skipped = !done && rowStatus === "SKIPPED";
  const missed = !done && rowStatus === "MISSED";

  return (
    <div
      className={`flex select-none items-center gap-3 px-4 py-3 transition-colors ${
        done
          ? "bg-whisper"
          : skipped
            ? "bg-stone-50"
            : missed
              ? "bg-rose-50"
              : "bg-white"
      }`}
    >
      {habit.is_support && (
        <span className="shrink-0 rounded-full border border-mist bg-whisper px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-stone-400">
          helper
        </span>
      )}
      <div className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-1.5">
          <span
            className={`wrap-break-word text-sm font-medium ${
              done
                ? "text-calm-400 line-through"
                : skipped
                  ? "text-stone-400"
                  : missed
                    ? "text-rose-400"
                    : "text-ink"
            }`}
          >
            {habit.name}
          </span>
          <AspirationDots
            ids={habit.aspirations}
            className={done || skipped || missed ? "opacity-40" : ""}
          />
        </span>
        {tier?.value && (
          <span
            className={`block text-xs ${done ? "text-calm-300" : "text-stone-400"}`}
          >
            {tier.value}
          </span>
        )}
      </div>

      {/* Tag — names which rung this row is (Roots wears clay, Growth leaf).
          An untagged rung shows no chip, just its value. */}
      {tier && tier.name && (
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
            tier.label === 1
              ? "bg-blush text-clay"
              : tier.label === 2
                ? "bg-mint text-calm-700"
                : "bg-calm-50 text-calm-400"
          }`}
        >
          {tier.name}
        </span>
      )}

      {expander}

      {/* Status dot: shows the slot's state (✓ done · – skipped · ✗ missed),
        and a one-tap toggles Complete / undo. */}
      <button
        type="button"
        data-no-menu
        aria-label={done ? `Undo ${habit.name}` : `Complete ${habit.name}`}
        aria-pressed={done}
        onClick={() =>
          done
            ? onLog(habit.id, "PENDING", tier?.version)
            : onLog(habit.id, "COMPLETED", tier?.version)
        }
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition active:scale-90 ${
          done
            ? "border-calm-600 bg-calm-600 text-white"
            : skipped
              ? "border-stone-400 bg-stone-400 text-white"
              : missed
                ? "border-rose-400 bg-rose-400 text-white"
                : "border-mist text-transparent hover:border-calm-500"
        }`}
      >
        {skipped ? <DashIcon /> : missed ? <XIcon /> : <CheckIcon />}
      </button>
    </div>
  );
}

// Wraps a tier row so a TAP anywhere on it opens the status menu (Finch-style:
// pick Complete / Skip / Miss). The grip and the complete dot are marked
// data-no-menu, so dragging or a quick one-tap complete still work without
// popping the menu. A tap (not a scroll) is what fires onClick, so scrolling the
// list never opens a menu by accident.
function HabitRowWithMenu({
  habit,
  level,
  onLog,
  expander,
  routines,
  habitRoutine,
  onSetRoutine,
}: {
  habit: HabitRow;
  level: number | null;
  onLog: (habitId: number, status: HabitStatus, tier?: number) => void;
  expander?: ReactNode;
  routines: Routine[];
  habitRoutine?: HabitRoutine;
  onSetRoutine: (habitId: number, routineId: number | null) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      onClick={(e) => {
        // Let the grip (drag) and the dot (quick complete) do their own thing.
        if ((e.target as HTMLElement).closest("[data-no-menu]")) return;
        setMenuOpen(true);
      }}
      className="cursor-pointer"
    >
      <HabitTierRow habit={habit} level={level} onLog={onLog} expander={expander} />

      <HabitStatusSheet
        open={menuOpen}
        habit={habit}
        level={level}
        routines={routines}
        habitRoutine={habitRoutine}
        onPick={(status) => {
          const version =
            level == null
              ? undefined
              : habit.tiers.find((t) => t.level === level)?.version;
          onLog(habit.id, status, version);
          setMenuOpen(false);
        }}
        onSetRoutine={(habitId, routineId) => {
          onSetRoutine(habitId, routineId);
          setMenuOpen(false);
        }}
        onClose={() => setMenuOpen(false)}
      />
    </div>
  );
}

// The tap menu: pick Skip / Complete / Miss for one habit version (or Clear to
// reset it to pending), jump to the habit's page via its name, and toggle its
// routine. Mirrors the Plan page's status sheet. Portaled to the body so nothing
// can clip it; the current status keeps a ring. Backdrop tap + Escape close.
function HabitStatusSheet({
  open,
  habit,
  level,
  routines,
  habitRoutine,
  onPick,
  onSetRoutine,
  onClose,
}: {
  open: boolean;
  habit: HabitRow;
  level: number | null;
  routines: Routine[];
  habitRoutine?: HabitRoutine;
  onPick: (status: HabitStatus) => void;
  onSetRoutine: (habitId: number, routineId: number | null) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // The row's current state, so the menu can tick the active choice. A tiered
  // row reads COMPLETED even when a higher version cascaded it (tier.done);
  // an untiered row (level null) reads the whole-habit status.
  const tier =
    level == null ? undefined : habit.tiers.find((t) => t.level === level);
  const current: HabitStatus =
    level == null
      ? habit.status
      : tier?.done
        ? "COMPLETED"
        : (tier?.status ?? "PENDING");

  // Skip / Complete / Miss, shown side-by-side; the current status keeps a ring.
  // Clear (back to pending) renders separately below, only when a status is set.
  const statuses: {
    status: HabitStatus;
    label: string;
    className: string;
    ring: string;
  }[] = [
    {
      status: "SKIPPED",
      label: "Skip",
      className: "bg-stone-100 text-stone-600 hover:bg-stone-200",
      ring: "ring-stone-400",
    },
    {
      status: "COMPLETED",
      label: "Complete",
      className: "bg-calm-600 text-white hover:bg-calm-700",
      ring: "ring-calm-700",
    },
    {
      status: "MISSED",
      label: "Miss",
      className: "bg-rose-50 text-rose-600 hover:bg-rose-100",
      ring: "ring-rose-400",
    },
  ];

  return createPortal(
    // React events bubble up the COMPONENT tree even though this is portaled to
    // <body>, so without stopPropagation a click in here would reach the row's
    // tap handler and instantly re-open the menu. Stop it at the root.
    <div
      onClick={(e) => e.stopPropagation()}
      className="fixed inset-0 z-50 flex flex-col items-center justify-end gap-2 p-3 sm:justify-center"
    >
      <div
        className="animate-backdrop-in absolute inset-0 bg-ink/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />

      {/* The sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Set status for ${habit.name}`}
        className="animate-sheet-in relative w-full max-w-sm rounded-3xl border border-mist bg-white p-4 shadow-[0_18px_44px_rgba(27,46,42,0.18)]"
      >
        {/* Grab-handle pill — reads as a bottom sheet on the phone. */}
        <div
          className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-mist"
          aria-hidden
        />

        {/* Habit name — big, centered, with a chevron; opens the habit's page. */}
        <button
          type="button"
          onClick={() => navigate(`/habits/${habit.id}`)}
          className="group mb-6 flex w-full items-center justify-center gap-1 px-4"
        >
          <span className="min-w-0 truncate text-lg font-semibold text-calm-900 group-hover:text-calm-700">
            {habit.name}
          </span>
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            className="h-4 w-4 shrink-0 text-calm-400 group-hover:text-calm-600"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>

        {/* Skip / Complete / Miss, side by side. The current status keeps a ring. */}
        <div className="flex gap-2">
          {statuses.map((o) => (
            <button
              key={o.status}
              type="button"
              onClick={() => onPick(o.status)}
              className={`flex flex-1 items-center justify-center rounded-2xl py-3.5 text-sm font-semibold transition active:scale-[0.97] ${
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
            onClick={() => onPick("PENDING")}
            className="mt-2 w-full rounded-xl py-2.5 text-sm font-medium text-calm-500 transition-colors hover:bg-calm-50"
          >
            Clear
          </button>
        )}

        {/* Routine grouping — per habit (independent of the per-day status above).
            Tapping a routine toggles membership: tap the current one to leave it,
            tap another to move into it. Hidden when there are no routines yet, or
            the habit isn't on the schedule (nothing to tag). */}
        {routines.length > 0 &&
          habitRoutine &&
          habitRoutine.scheduleIds.length > 0 && (
            <div className="mt-4 border-t border-calm-100 pt-3">
              <p className="px-1 pb-2 text-xs font-medium uppercase tracking-wide text-stone-400">
                Routine
              </p>
              <div className="flex flex-col gap-1.5">
                {routines.map((r) => {
                  const inThis = habitRoutine.routineId === r.id;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() =>
                        onSetRoutine(habit.id, inThis ? null : r.id)
                      }
                      className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                        inThis
                          ? "bg-calm-100 text-calm-700"
                          : "text-calm-700 hover:bg-calm-50"
                      }`}
                    >
                      <span>{r.name}</span>
                      {inThis && <span aria-hidden>✓</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
      </div>

      {/* Cancel — its own card, iOS action-sheet style. */}
      <button
        type="button"
        onClick={onClose}
        className="relative w-full max-w-sm rounded-2xl border border-mist bg-white py-3.5 text-sm font-semibold text-stone-500 shadow-[0_18px_44px_rgba(27,46,42,0.18)] transition hover:text-stone-700 active:scale-[0.98]"
      >
        Cancel
      </button>
    </div>,
    document.body,
  );
}

// One habit = one card. A tiered habit stacks a row per version inside the same
// card (split by whisper hairlines) so Roots and Growth read as ONE habit; an
// untiered habit is a single whole-habit row. `focus` picks which tier row sits
// on top. `handle` (the drag grip, when sortable) hugs the card's left edge and
// drags the whole habit.
function HabitCard({
  habit,
  focus,
  onLog,
  handle,
  routines,
  habitRoutine,
  onSetRoutine,
}: {
  habit: HabitRow;
  focus: TierFocus;
  onLog: (habitId: number, status: HabitStatus, tier?: number) => void;
  handle?: ReactNode;
  routines: Routine[];
  habitRoutine?: HabitRoutine;
  onSetRoutine: (habitId: number, routineId: number | null) => void;
}) {
  // Collapsed, the card is just the FOCUSED version's row; the chevron expands
  // it to show every version (focused first). [null] = the untiered single row
  // (not listed on this page, kept as a guard).
  const [expanded, setExpanded] = useState(false);
  // Which rung sits on top: the one wearing the focused TAG (Roots/Growth), so a
  // 3-rung ladder shows its Roots rung under "Roots" and its Growth rung under
  // "Growth" — not just level 1 vs 2. Falls back to the lowest rung.
  const focusLabel = focus === "ROOTS" ? 1 : 2;
  const focusLevel =
    habit.tiers.find((t) => t.label === focusLabel)?.level ??
    habit.tiers[0]?.level ??
    1;
  const sorted: (number | null)[] =
    habit.tiers.length > 0
      ? [...habit.tiers]
          .sort((a, b) =>
            a.level === focusLevel
              ? -1
              : b.level === focusLevel
                ? 1
                : a.level - b.level,
          )
          .map((t) => t.level)
      : [null];
  const levels = expanded ? sorted : sorted.slice(0, 1);
  const hasMore = sorted.length > 1;

  const expander = hasMore ? (
    <button
      type="button"
      data-no-menu
      aria-expanded={expanded}
      aria-label={expanded ? "Hide other versions" : "Show all versions"}
      onClick={() => setExpanded((v) => !v)}
      className="-m-1 shrink-0 p-1 text-calm-300 transition-colors hover:text-calm-500"
    >
      <svg
        className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    </button>
  ) : undefined;

  return (
    <div className="flex items-center gap-2">
      {handle}
      <div
        className={`min-w-0 flex-1 divide-y divide-whisper overflow-hidden ${CARD}`}
      >
        {levels.map((level, i) => (
          <HabitRowWithMenu
            key={level ?? "solo"}
            habit={habit}
            level={level}
            onLog={onLog}
            expander={i === 0 ? expander : undefined}
            routines={routines}
            habitRoutine={habitRoutine}
            onSetRoutine={onSetRoutine}
          />
        ))}
      </div>
    </div>
  );
}

// A drag-to-reorder wrapper around HabitCard. Only the grip carries the drag
// listeners, so tapping a row inside the card never starts a drag.
function SortableHabitCard({
  habit,
  focus,
  onLog,
  routines,
  habitRoutine,
  onSetRoutine,
}: {
  habit: HabitRow;
  focus: TierFocus;
  onLog: (habitId: number, status: HabitStatus, tier?: number) => void;
  routines: Routine[];
  habitRoutine?: HabitRoutine;
  onSetRoutine: (habitId: number, routineId: number | null) => void;
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
    opacity: isDragging ? 0.85 : 1,
    zIndex: isDragging ? 30 : undefined,
  };
  const handle = (
    <button
      type="button"
      data-no-menu
      aria-label="Drag to reorder"
      {...attributes}
      {...listeners}
      // -m-2 + p-2 doubles the tap target (16px -> 32px) without shifting the
      // layout. No `touch-none`: a quick swipe on the grip should still scroll;
      // only a held press (see TouchSensor delay) starts a drag.
      className="-m-2 shrink-0 cursor-grab select-none p-2 text-calm-300 hover:text-calm-500 active:cursor-grabbing"
    >
      <GripIcon />
    </button>
  );
  return (
    <div ref={setNodeRef} style={style}>
      <HabitCard
        habit={habit}
        focus={focus}
        onLog={onLog}
        handle={handle}
        routines={routines}
        habitRoutine={habitRoutine}
        onSetRoutine={onSetRoutine}
      />
    </div>
  );
}

// A group of habit cards: the main list, or the "Helpers" shelf below it.
// `label` renders as a small-caps header with a mist hairline (null = none).
// When `sortable`, each card gets a drag grip and a drag reorders the habits
// within the group (persisted globally via onReorder); otherwise cards are
// plain (viewing another day keeps tap-to-log without reorder).
function HabitGroup({
  label,
  habits,
  focus,
  onLog,
  sortable,
  sensors,
  onReorder,
  routines,
  routineMap,
  onSetRoutine,
}: {
  label: string | null;
  habits: HabitRow[];
  focus: TierFocus;
  onLog: (habitId: number, status: HabitStatus, tier?: number) => void;
  sortable: boolean;
  sensors: ReturnType<typeof useSensors>;
  onReorder: (activeId: number, overId: number) => void;
  routines: Routine[];
  routineMap: Map<number, HabitRoutine>;
  onSetRoutine: (habitId: number, routineId: number | null) => void;
}) {
  if (habits.length === 0) return null;

  const body = sortable ? (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={(event: DragEndEvent) => {
        const { active, over } = event;
        if (over && active.id !== over.id) {
          onReorder(Number(active.id), Number(over.id));
        }
      }}
    >
      <SortableContext
        items={habits.map((h) => h.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="space-y-2.5">
          {habits.map((habit) => (
            <SortableHabitCard
              key={habit.id}
              habit={habit}
              focus={focus}
              onLog={onLog}
              routines={routines}
              habitRoutine={routineMap.get(habit.id)}
              onSetRoutine={onSetRoutine}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  ) : (
    <div className="space-y-2.5">
      {habits.map((habit) => (
        <HabitCard
          key={habit.id}
          habit={habit}
          focus={focus}
          onLog={onLog}
          routines={routines}
          habitRoutine={routineMap.get(habit.id)}
          onSetRoutine={onSetRoutine}
        />
      ))}
    </div>
  );

  return (
    <div className="mb-6">
      {label && (
        <div className="mb-2.5 flex items-center gap-2.5">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.11em] text-stone-400">
            {label}
          </h3>
          <div className="h-px flex-1 bg-mist" />
        </div>
      )}
      {body}
    </div>
  );
}

function HabitsPage() {
  const [habits, setHabits] = useState<HabitRow[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  // "Show helpers" — off by default, so the page lists only the main habits she
  // cares about (helper/support habits hidden, like her old app). On reveals the
  // helpers too, each tagged "helper".
  const [showHelpers, setShowHelpers] = useState(false);
  // Which tier sits on top (both always show). Roots on top by default; pick
  // Growth to put Growth above Roots.
  const [focus, setFocus] = useState<TierFocus>("GROWTH");
  // The day being viewed (default: today). The ◀/▶ nav moves it and we re-fetch
  // /habits/ for that day, exactly like the Plan page — same statuses, just for
  // the chosen date.
  const [viewedDate, setViewedDate] = useState(() => startOfDay(new Date()));
  const isViewingToday = isSameDay(viewedDate, new Date());
  // Routine groups (for the "Add to routine" tap-menu) and, per habit, its
  // current routine + the schedule rows to tag. Derived from the recurring read.
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routineMap, setRoutineMap] = useState<Map<number, HabitRoutine>>(
    new Map(),
  );
  const toast = useToast();
  const navigate = useNavigate();

  // The Habits page lists only ACTIVE habits for the VIEWED day; paused ones live
  // on their own page (/habits/paused), so this never asks for ended ones. The
  // date drives which day's statuses come back (re-fetches when you change days).
  const listUrl = `${import.meta.env.VITE_API_URL}/habits/?date=${toYMD(viewedDate)}`;

  useEffect(() => {
    async function fetchHabits() {
      setIsLoading(true);
      try {
        const res = await fetch(listUrl, { method: "GET", headers: {} });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Couldn't load your habits");
          return;
        }
        setHabits(data);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "An unknown error occurred",
        );
      } finally {
        setIsLoading(false);
      }
    }
    fetchHabits();
  }, [listUrl]);

  // Load the routine groups + each habit's current routine membership (and the
  // schedule rows to tag). Pulled from the same recurring read the routine editor
  // uses, so the tap-menu and that page always agree.
  const loadRoutineData = useCallback(async () => {
    try {
      const [rRes, sRes] = await Promise.all([
        fetch(`${import.meta.env.VITE_API_URL}/routines/`),
        fetch(`${import.meta.env.VITE_API_URL}/schedules/recurring/`),
      ]);
      if (!rRes.ok || !sRes.ok) return;
      const rData: Routine[] = await rRes.json();
      const sData = await sRes.json();
      setRoutines(rData);

      const map = new Map<number, HabitRoutine>();
      for (const block of sData.blocks as {
        habits: {
          schedule: number;
          habit: number;
          routine: number | null;
          routine_name: string | null;
        }[];
      }[]) {
        for (const h of block.habits) {
          const prev = map.get(h.habit);
          map.set(h.habit, {
            // Keep the first non-null routine across a habit's slots.
            routineId: prev?.routineId ?? h.routine,
            routineName: prev?.routineName ?? h.routine_name,
            scheduleIds: prev
              ? [...prev.scheduleIds, h.schedule]
              : [h.schedule],
          });
        }
      }
      setRoutineMap(map);
    } catch {
      // Non-fatal: the tap-menu just won't show the routine section.
    }
  }, []);

  useEffect(() => {
    loadRoutineData();
  }, [loadRoutineData]);

  // Join a routine (routineId set — moves the habit out of any other) or leave
  // the current one (routineId null), tagging all the habit's schedule rows, then
  // refresh the map.
  async function setHabitRoutine(habitId: number, routineId: number | null) {
    const info = routineMap.get(habitId);
    if (!info || info.scheduleIds.length === 0) return;
    const target = routineId ?? info.routineId;
    if (target == null) return;
    const action = routineId == null ? "remove" : "add";
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/routines/${target}/members/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [action]: info.scheduleIds }),
        },
      );
      if (!res.ok) throw new Error("Request failed");
      await loadRoutineData();
    } catch {
      toast("Couldn't update the routine", { variant: "error" });
    }
  }

  // A quiet re-fetch (no spinner) after a log/resume POST, so the cascaded
  // per-version truth comes straight from the backend.
  async function reloadHabits() {
    const res = await fetch(listUrl, { method: "GET", headers: {} });
    const data = await res.json();
    if (!res.ok) throw new Error("Request failed");
    setHabits(data);
  }

  // Complete / undo a habit (optionally at one rung), then re-fetch so the cascade
  // across rungs shows.
  async function logHabit(
    habitId: number,
    status: HabitStatus,
    version?: number,
  ) {
    try {
      // Send the `version` (rung id) for EVERY status (not just completion) so
      // undo / skip / missed target that rung's row, not the whole habit. On
      // another day, send the date too so the log lands on the VIEWED day.
      const body: { status: HabitStatus; version?: number; date?: string } = {
        status,
      };
      if (version != null) body.version = version;
      if (!isViewingToday) body.date = toYMD(viewedDate);

      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/habits/${habitId}/log/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw new Error("Request failed");
      await reloadHabits();
    } catch {
      toast("Couldn't update that habit", { variant: "error" });
    }
  }

  // Mouse keeps a tiny 6px threshold so a tap (to complete) isn't misread as a
  // drag. Touch needs a ~450ms press-and-HOLD (close to native iOS), and any
  // finger drift over 5px during that hold cancels into a scroll, so a
  // scroll-swipe never grabs a row by accident — the standard mobile reorder
  // gesture.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 450, tolerance: 5 },
    }),
  );

  // A card was dragged within its group (main habits, or the Helpers shelf).
  // The group is only a SUBSET of all habits, so we reorder that subset and
  // splice it back into the single global order — Habit.order is one position
  // per habit — then persist the whole list.
  function handleReorder(activeId: number, overId: number) {
    const active = habits.find((h) => h.id === activeId);
    if (!active) return;
    // Only cards that are BOTH in the dragged card's group and currently
    // visible take part, so a hidden helper keeps its global slot instead of
    // being swept into the new order (mirrors the Plan page's "reorder keeps
    // hidden rows in place" rule).
    const inSection = (h: HabitRow) =>
      h.tiers.some((t) => t.level <= focusLevel) &&
      h.is_support === active.is_support &&
      (showHelpers || !h.is_support);
    const section = habits.filter(inSection);
    const from = section.findIndex((h) => h.id === activeId);
    const to = section.findIndex((h) => h.id === overId);
    if (from < 0 || to < 0) return;

    const reordered = arrayMove(section, from, to);
    // Refill each global slot a section member occupied, in the new order; rows
    // outside this section keep their place.
    let k = 0;
    const next = habits.map((h) => (inSection(h) ? reordered[k++] : h));
    setHabits(next);
    void persistOrder(next);
  }

  // Save the whole list's positions in one POST (id -> its index). On failure,
  // tell the user and reload the server's order so the screen can't drift.
  async function persistOrder(ordered: HabitRow[]) {
    try {
      const items = ordered.map((habit, index) => ({
        id: habit.id,
        order: index,
      }));
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/habits/reorder/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items }),
        },
      );
      if (!res.ok) throw new Error("Request failed");
    } catch {
      toast("Couldn't save the new order", { variant: "error" });
      reloadHabits().catch(() => {});
    }
  }

  // This page lists only TIERED habits (her call): it's the Roots/Growth
  // practice board, not the full catalog — untiered habits live on the Plan
  // page. The Roots/Growth picker FILTERS at-or-below the picked level (the
  // Plan page's day-tier rule): Roots = just Roots versions; Growth = every
  // habit at its best version, so a Roots-only habit (brush teeth) still shows
  // on Growth. Expand a card to see all its versions. Helpers hide behind the
  // Main/All toggle as before.
  const focusLevel = focus === "ROOTS" ? 1 : 2;
  const visible = habits.filter(
    (habit) =>
      habit.tiers.some((t) => t.level <= focusLevel) &&
      (showHelpers || !habit.is_support),
  );
  // The main list and the "Helpers" shelf below it (empty while helpers are
  // hidden, so the shelf simply doesn't render).
  const mains = visible.filter((habit) => !habit.is_support);
  const helpers = visible.filter((habit) => habit.is_support);

  return (
    <>
      <Header
        title="Habits"
        eyebrow="Your practice"
        action={
          <button
            onClick={() => navigate("/habits/new")}
            className={HEADER_ACTION}
          >
            + New
          </button>
        }
      />
      <div className="max-w-md mx-auto">
        {/* ◀ [day] ▶ — browse other days, same as the Plan page. Always visible
            so it never vanishes mid-load and you can move off an empty day. */}
        <DateNav
          date={viewedDate}
          onPrev={() => setViewedDate((d) => addDays(d, -1))}
          onNext={() => setViewedDate((d) => addDays(d, 1))}
          onToday={() => setViewedDate(startOfDay(new Date()))}
        />

        {error ? (
          <div className="bg-red-50 rounded-xl p-4 text-center">
            <p className="text-red-500 text-sm">{error}</p>
          </div>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 border-2 border-calm-300 border-t-calm-600 rounded-full animate-spin"></div>
            <span className="ml-3 text-stone-400 text-sm">Loading habits...</span>
          </div>
        ) : visible.length === 0 ? (
          isViewingToday ? (
            <div className={`p-10 text-center ${CARD}`}>
              <div className="mb-4 flex justify-center">
                <PlantWidget done={0} total={0} size={56} />
              </div>
              <h3 className="font-heading text-xl text-ink mb-1">
                No habits yet
              </h3>
              <p className="text-stone-400 text-sm">
                Add your first habit to start growing
              </p>
              <button
                onClick={() => navigate("/habits/new")}
                className="mt-5 rounded-full bg-calm-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-calm-700"
              >
                + Add habit
              </button>
            </div>
          ) : (
            <p className="py-12 text-center text-sm text-stone-400">
              No habits on this day.
            </p>
          )
        ) : (
          <>
            {/* Controls: which-tier-on-top picker (left); Main/All decides
                whether helper habits show (right). */}
            <div className="mb-5 flex items-center justify-between gap-2">
              <div className={SEG}>
                {(["ROOTS", "GROWTH"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setFocus(option)}
                    aria-pressed={focus === option}
                    className={segOption(focus === option)}
                  >
                    {option === "ROOTS" ? "Roots" : "Growth"}
                  </button>
                ))}
              </div>

              <div className={SEG}>
                {([false, true] as const).map((withHelpers) => (
                  <button
                    key={String(withHelpers)}
                    type="button"
                    onClick={() => setShowHelpers(withHelpers)}
                    aria-pressed={showHelpers === withHelpers}
                    className={segOption(showHelpers === withHelpers)}
                  >
                    {withHelpers ? "All" : "Main"}
                  </button>
                ))}
              </div>
            </div>

            {/* One card per habit (its tiers stack inside); helpers sit on
                their own labeled shelf below the main list. Reorder is the
                global catalog order, so it's only offered on today
                (sortable=false elsewhere keeps tap-to-log). */}
            <HabitGroup
              label={null}
              habits={mains}
              focus={focus}
              onLog={logHabit}
              sortable={isViewingToday}
              sensors={sensors}
              onReorder={handleReorder}
              routines={routines}
              routineMap={routineMap}
              onSetRoutine={setHabitRoutine}
            />
            <HabitGroup
              label="Helpers"
              habits={helpers}
              focus={focus}
              onLog={logHabit}
              sortable={isViewingToday}
              sensors={sensors}
              onReorder={handleReorder}
              routines={routines}
              routineMap={routineMap}
              onSetRoutine={setHabitRoutine}
            />
          </>
        )}

        {/* Routine groups + paused habits live on their own pages — quiet
            links to get there. */}
        <button
          type="button"
          onClick={() => navigate("/routines")}
          className="mt-2 w-full rounded-xl py-2.5 text-center text-sm font-medium text-calm-600 transition-colors hover:text-calm-700"
        >
          Manage routines ›
        </button>
        <button
          type="button"
          onClick={() => navigate("/habits/paused")}
          className="w-full rounded-xl py-2.5 text-center text-sm font-medium text-stone-400 transition-colors hover:text-stone-600"
        >
          View paused habits
        </button>
      </div>
    </>
  );
}

export default HabitsPage;
