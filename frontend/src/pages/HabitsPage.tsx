import {
  useState,
  useEffect,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import Header from "../components/layout/Header";
import { useToast } from "../components/Toast";
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

// The statuses for a habit's day (matches the backend HabitLog). MISSED is now
// settable too (not just derived for past days).
type HabitStatus = "PENDING" | "COMPLETED" | "SKIPPED" | "MISSED";

// One tier of a habit (e.g. Roots / Growth) with its current target value and
// TODAY's per-version state. The backend folds the higher-completes-lower
// cascade into `done`/`status`, so a row reads its own tier here.
type HabitTier = {
  level: number;
  name: string;
  value: string;
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
  tiers: HabitTier[];
  status: HabitStatus;
};

// Which tier sits on top. Both tiers always render; this only moves the picked
// one to the front (GROWTH on top by default; pick ROOTS to flip the order).
type TierFocus = "ROOTS" | "GROWTH";

const ROOTS = 1;
const GROWTH = 2;

// Tier section labels + colors, mirroring the old Habit-Tracker dashboard.
const TIER_META: Record<number, { label: string; color: string }> = {
  1: { label: "Roots", color: "text-amber-700" },
  2: { label: "Growth", color: "text-green-600" },
};

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

// One row inside a tier section: the habit's name + this tier's target value +
// a complete/undo control. Reads "done" from this tier's own per-version state
// (the backend folds in the cascade, so completing Growth marks Roots done).
// `handle` is the drag grip when the section is sortable (omitted otherwise).
function HabitTierRow({
  habit,
  level,
  onLog,
  handle,
}: {
  habit: HabitRow;
  level: number;
  onLog: (habitId: number, status: HabitStatus, tier?: number) => void;
  handle?: ReactNode;
}) {
  const tier = habit.tiers.find((t) => t.level === level);
  const done = tier?.done ?? false;
  // The other settable states for this version. SKIPPED/MISSED render their own
  // tint + badge (matching the Plan page) instead of looking like plain pending.
  const skipped = tier?.status === "SKIPPED";
  const missed = tier?.status === "MISSED";

  return (
    <div
      className={`flex select-none items-center gap-3 rounded-xl px-3 py-2.5 transition-colors ${
        done
          ? "bg-calm-50"
          : skipped
            ? "bg-stone-50"
            : missed
              ? "bg-rose-50"
              : "bg-white shadow-sm"
      }`}
    >
      {handle}
      {habit.is_support && (
        <span className="shrink-0 rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-400">
          helper
        </span>
      )}
      <div className="min-w-0 flex-1">
        <span
          className={`block break-words text-sm font-medium ${
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
        </span>
        {tier?.value && (
          <span
            className={`block text-xs ${done ? "text-calm-300" : "text-stone-400"}`}
          >
            {tier.value}
          </span>
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

      <button
        type="button"
        data-no-menu
        aria-label={done ? `Undo ${habit.name}` : `Complete ${habit.name}`}
        aria-pressed={done}
        onClick={() =>
          done
            ? onLog(habit.id, "PENDING", level)
            : onLog(habit.id, "COMPLETED", level)
        }
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

// Wraps a tier row so a TAP anywhere on it opens the status menu (Finch-style:
// pick Complete / Skip / Miss). The grip and the complete dot are marked
// data-no-menu, so dragging or a quick one-tap complete still work without
// popping the menu. A tap (not a scroll) is what fires onClick, so scrolling the
// list never opens a menu by accident.
function HabitRowWithMenu({
  habit,
  level,
  onLog,
  handle,
}: {
  habit: HabitRow;
  level: number;
  onLog: (habitId: number, status: HabitStatus, tier?: number) => void;
  handle?: ReactNode;
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
      <HabitTierRow habit={habit} level={level} onLog={onLog} handle={handle} />

      <HabitStatusSheet
        open={menuOpen}
        habit={habit}
        level={level}
        onPick={(status) => {
          onLog(habit.id, status, level);
          setMenuOpen(false);
        }}
        onClose={() => setMenuOpen(false)}
      />
    </div>
  );
}

// The tap menu: pick Complete / Skip / Miss for one habit version, or Clear to
// reset it to pending. Same overlay style as ConfirmDialog (backdrop tap +
// Escape close); portaled to the body so nothing can clip it. The current
// status gets a check so you can see what it's set to.
function HabitStatusSheet({
  open,
  habit,
  level,
  onPick,
  onClose,
}: {
  open: boolean;
  habit: HabitRow;
  level: number;
  onPick: (status: HabitStatus) => void;
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

  const tier = habit.tiers.find((t) => t.level === level);
  // The version's current state, so the menu can tick the active choice. A done
  // row reads COMPLETED even when a higher version cascaded it (tier.done).
  const current: HabitStatus = tier?.done
    ? "COMPLETED"
    : (tier?.status ?? "PENDING");

  const options: { status: HabitStatus; label: string; className: string }[] = [
    {
      status: "COMPLETED",
      label: "Complete",
      className: "bg-calm-600 text-white hover:bg-calm-700",
    },
    {
      status: "SKIPPED",
      label: "Skip",
      className: "bg-stone-100 text-stone-600 hover:bg-stone-200",
    },
    {
      status: "MISSED",
      label: "Miss",
      className: "bg-rose-50 text-rose-600 hover:bg-rose-100",
    },
    {
      status: "PENDING",
      label: "Clear",
      className: "border border-calm-200 text-calm-700 hover:bg-calm-50",
    },
  ];

  return createPortal(
    // React events bubble up the COMPONENT tree even though this is portaled to
    // <body>, so without stopPropagation a click in here would reach the row's
    // tap handler and instantly re-open the menu. Stop it at the root.
    <div
      onClick={(e) => e.stopPropagation()}
      className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
    >
      <div
        className="animate-backdrop-in absolute inset-0 bg-calm-900/40"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Set status for ${habit.name}`}
        className="animate-sheet-in relative w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl"
      >
        <p className="px-2 pb-3 text-sm font-medium text-calm-900">
          {habit.name}
        </p>
        <div className="flex flex-col gap-2">
          {options.map((o) => (
            <button
              key={o.status}
              type="button"
              onClick={() => onPick(o.status)}
              className={`flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-medium transition-colors ${o.className}`}
            >
              {o.label}
              {current === o.status && <span aria-hidden>✓</span>}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-2 w-full rounded-xl py-3 text-sm font-medium text-stone-400 transition-colors hover:text-stone-600"
        >
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
}

// A drag-to-reorder wrapper around HabitTierRow. Only the grip carries the drag
// listeners, so tapping a row's complete button never starts a drag.
function SortableHabitTierRow({
  habit,
  level,
  onLog,
}: {
  habit: HabitRow;
  level: number;
  onLog: (habitId: number, status: HabitStatus, tier?: number) => void;
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
      <HabitRowWithMenu
        habit={habit}
        level={level}
        onLog={onLog}
        handle={handle}
      />
    </div>
  );
}

// A whole tier section: a colored header + divider, then a row per habit that
// has this tier. Renders nothing when no habit has the tier. When `sortable`,
// each row gets a drag grip and a drag reorders the habits (persisted globally
// via onReorder); otherwise rows are plain (the filtered "important" view).
function TierSection({
  level,
  habits,
  onLog,
  sortable,
  sensors,
  onReorder,
}: {
  level: number;
  habits: HabitRow[];
  onLog: (habitId: number, status: HabitStatus, tier?: number) => void;
  sortable: boolean;
  sensors: ReturnType<typeof useSensors>;
  onReorder: (level: number, activeId: number, overId: number) => void;
}) {
  const rows = habits.filter((h) => h.tiers.some((t) => t.level === level));
  if (rows.length === 0) return null;

  const meta = TIER_META[level];

  const body = sortable ? (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={(event: DragEndEvent) => {
        const { active, over } = event;
        if (over && active.id !== over.id) {
          onReorder(level, Number(active.id), Number(over.id));
        }
      }}
    >
      <SortableContext
        items={rows.map((h) => h.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="space-y-1.5">
          {rows.map((habit) => (
            <SortableHabitTierRow
              key={habit.id}
              habit={habit}
              level={level}
              onLog={onLog}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  ) : (
    <div className="space-y-1.5">
      {rows.map((habit) => (
        <HabitRowWithMenu
          key={habit.id}
          habit={habit}
          level={level}
          onLog={onLog}
        />
      ))}
    </div>
  );

  return (
    <div className="mb-6">
      <div className="mb-3 flex items-center gap-3">
        <h3 className={`text-sm font-medium ${meta.color}`}>{meta.label}</h3>
        <div className="h-px flex-1 bg-calm-200" />
      </div>
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
  // Which tier sits on top (both always show). Growth on top by default (your
  // aim); pick Roots to put Roots above Growth.
  const [focus, setFocus] = useState<TierFocus>("GROWTH");
  const toast = useToast();

  useEffect(() => {
    async function fetchHabits() {
      setIsLoading(true);
      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL}/habits/`, {
          method: "GET",
          headers: {},
        });
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
  }, []);

  // A quiet re-fetch (no spinner) after a log POST, so the cascaded per-version
  // truth comes straight from the backend.
  async function reloadHabits() {
    const res = await fetch(`${import.meta.env.VITE_API_URL}/habits/`, {
      method: "GET",
      headers: {},
    });
    const data = await res.json();
    if (!res.ok) throw new Error("Request failed");
    setHabits(data);
  }

  // Complete / undo a habit (optionally at a tier), then re-fetch so the cascade
  // across tiers shows.
  async function logHabit(habitId: number, status: HabitStatus, tier?: number) {
    try {
      // Send the tier for EVERY status (not just completion) so undo / skip /
      // missed target that version's row, not the whole habit.
      const body: { status: HabitStatus; tier?: number } = { status };
      if (tier != null) body.tier = tier;

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
  // drag. Touch needs a ~200ms press-and-HOLD, so a scroll-swipe never grabs a
  // row by accident — the standard mobile reorder gesture.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
  );

  // A row was dragged within a tier section. The section is only a SUBSET of all
  // habits (those that have this tier), so we reorder that subset and splice it
  // back into the single global order — Habit.order is one position per habit,
  // shared across sections — then persist the whole list.
  function handleReorder(level: number, activeId: number, overId: number) {
    // Only rows that are BOTH in this tier and currently visible take part, so a
    // hidden helper keeps its global slot instead of being swept into the new
    // order (mirrors the Plan page's "reorder keeps hidden rows in place" rule).
    const inSection = (h: HabitRow) =>
      h.tiers.some((t) => t.level === level) && (showHelpers || !h.is_support);
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

  if (habits.length === 0) {
    return (
      <>
        <Header title="Habits" body="" />
        <div className="max-w-md mx-auto">
          <div className="bg-white rounded-2xl p-10 text-center shadow-sm">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-accent-100 flex items-center justify-center">
              <span className="text-3xl">&#x1F331;</span>
            </div>
            <h3 className="font-heading text-xl text-stone-900 mb-2">
              No habits yet
            </h3>
            <p className="text-stone-400 text-sm">
              Add your first habit to start growing
            </p>
          </div>
        </div>
      </>
    );
  }

  const visible = showHelpers
    ? habits
    : habits.filter((habit) => !habit.is_support);

  return (
    <>
      <Header title="Habits" body="" />
      <div className="max-w-md mx-auto">
        {/* Controls: which-tier-on-top picker (left), Show-helpers toggle (right). */}
        <div className="mb-5 flex items-center justify-between gap-2">
          <div className="inline-flex rounded-full bg-white p-0.5 shadow-sm">
            {(["GROWTH", "ROOTS"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setFocus(option)}
                aria-pressed={focus === option}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  focus === option
                    ? "bg-calm-600 text-white"
                    : "text-stone-400 hover:text-stone-600"
                }`}
              >
                {option === "ROOTS" ? "Roots" : "Growth"}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowHelpers((on) => !on)}
            aria-pressed={showHelpers}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              showHelpers
                ? "bg-calm-100 text-calm-700"
                : "bg-white text-stone-400 shadow-sm hover:text-stone-600"
            }`}
          >
            {showHelpers ? "Hide helpers" : "Show helpers"}
          </button>
        </div>

        {/* Both tiers always render; the picker just chooses which sits on top.
            TierSection returns null for a tier no habit has, so mapping over
            both is safe. */}
        {(focus === "ROOTS" ? [ROOTS, GROWTH] : [GROWTH, ROOTS]).map((level) => (
          <TierSection
            key={level}
            level={level}
            habits={visible}
            onLog={logHabit}
            sortable={true}
            sensors={sensors}
            onReorder={handleReorder}
          />
        ))}
      </div>
    </>
  );
}

export default HabitsPage;
