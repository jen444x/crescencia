import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  DndContext,
  closestCorners,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDroppable,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import Header from "../components/layout/Header";
import AddHabitButton from "../components/AddHabitButton";
import { useTimeRail } from "./plan/useTimeRail";
import { TimeRail, RAIL_WIDTH } from "./plan/components/TimeRail";

type RoutineHabit = {
  habit: number;
  name: string;
  tier: number | null;
  tier_name: string | null;
  routine: number | null;
  routine_name: string | null;
  order: number | null;
};

type Block = {
  chain: number | null;
  name: string;
  time: string | null; // "HH:MM:SS", or null for the Anytime block
  habits: RoutineHabit[];
};

// dnd id for a habit slot (a habit can sit in two chains via two tier-slots).
const keyOf = (h: RoutineHabit) => `${h.habit}-${h.tier ?? "x"}`;

function formatTime(t: string | null): string {
  if (!t) return "Anytime";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
}

// Recurring edits here apply from TODAY forward (today included).
function fromDateYMD(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function GripIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
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

function HabitRow({ h }: { h: RoutineHabit }) {
  return (
    <>
      <span className="flex-1 text-sm text-calm-900">{h.name}</span>
      {h.routine_name && (
        <span className="rounded-full bg-calm-50 px-2 py-0.5 text-[10px] font-medium text-calm-500">
          {h.routine_name}
        </span>
      )}
      {h.tier_name && (
        <span className="rounded-full bg-calm-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-calm-600">
          {h.tier_name}
        </span>
      )}
    </>
  );
}

function SortableHabit({ h }: { h: RoutineHabit }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: keyOf(h) });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.85 : 1,
        zIndex: isDragging ? 30 : undefined,
      }}
      className="flex select-none items-center gap-2 px-4 py-3"
    >
      {/* Only the grip carries the drag listeners — with them on the whole row,
          a slow-starting scroll (finger down ~450ms, then swipe) anywhere on a
          row would grab it and drag instead of scrolling. */}
      <button
        type="button"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
        className="-m-2 shrink-0 cursor-grab select-none p-2 text-calm-300 hover:text-calm-500 active:cursor-grabbing"
      >
        <GripIcon />
      </button>
      <HabitRow h={h} />
    </li>
  );
}

// Drop zone covering a block's body, so a habit can be dropped onto an EMPTY
// block (or the empty space below the last row) and land in that chain.
function BlockDrop({
  chain,
  children,
}: {
  chain: number | null;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `block-${chain ?? "anytime"}`,
  });
  return (
    <div ref={setNodeRef} className={isOver ? "bg-calm-50" : ""}>
      {children}
    </div>
  );
}

function EverydayRoutinePage() {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [addingTime, setAddingTime] = useState(false);
  const [newTime, setNewTime] = useState("");
  // The chain whose time is being edited, plus the staged value (applied only on OK).
  const [editingChain, setEditingChain] = useState<number | null>(null);
  const [editTime, setEditTime] = useState("");
  const navigate = useNavigate();
  // Latest blocks for use inside async handlers without stale closures.
  const blocksRef = useRef<Block[]>([]);
  blocksRef.current = blocks;
  // Drag a habit LEFT onto the rail to give it a recurring time — the same
  // gesture the Plan page uses, so a time no longer has to be created first.
  const timeRail = useTimeRail();
  // Blocks added this session that are still empty. /schedules/recurring/ is
  // built from Schedule rows, so a brand-new (habit-less) chain comes back from
  // it invisible — "Add time" looked like it did nothing. Holding them here
  // keeps them on screen until something is dropped in.
  const [newChains, setNewChains] = useState<{ id: number; time: string }[]>([]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 450, tolerance: 5 } }),
  );

  async function load() {
    setIsLoading(true);
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/schedules/recurring/?date=${fromDateYMD()}`,
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not load your routine.");
        return;
      }
      setBlocks(data.blocks);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unknown error occurred");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // POST a recurring arrangement (every day from today) for the affected chains,
  // then re-sync from the server. On failure, reload to drop the optimistic state.
  async function persist(items: object[]) {
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/schedules/arrange-forward/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items, from_date: fromDateYMD() }),
        },
      );
      if (!res.ok) throw new Error("save failed");
      await load();
    } catch {
      setError("Couldn't save that change.");
      await load();
    }
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveKey(null);
    const { active, over } = e;

    // Released on the rail: this drop is about TIME, whatever block dnd-kit
    // still reports underneath. Read the hook before resetting it.
    if (timeRail.isTimeMode) {
      const minutes = timeRail.joinChainMin ?? timeRail.previewMin;
      timeRail.reset();
      if (minutes != null) void dropAtRecurringTime(String(active.id), minutes);
      return;
    }
    timeRail.reset();
    if (!over) return;
    const aKey = String(active.id);
    const oKey = String(over.id);
    if (aKey === oKey) return;

    const cur = blocksRef.current;
    const srcIdx = cur.findIndex((b) => b.habits.some((h) => keyOf(h) === aKey));
    if (srcIdx < 0) return;
    const moved = cur[srcIdx].habits.find((h) => keyOf(h) === aKey)!;

    // Resolve the target chain + where to insert.
    let tgtIdx: number;
    let insertAt: number;
    if (oKey.startsWith("block-")) {
      const chainId = oKey === "block-anytime" ? null : Number(oKey.slice(6));
      tgtIdx = cur.findIndex((b) => b.chain === chainId);
      insertAt = tgtIdx >= 0 ? cur[tgtIdx].habits.length : 0;
    } else {
      tgtIdx = cur.findIndex((b) => b.habits.some((h) => keyOf(h) === oKey));
      const overIdx =
        tgtIdx >= 0 ? cur[tgtIdx].habits.findIndex((h) => keyOf(h) === oKey) : 0;
      // dnd-kit reports the row under the pointer as `over`; inserting at its
      // index drops ABOVE it. If the row is released past the over row's middle,
      // insert AFTER it instead — otherwise you could never land as the last row.
      const aRect = active.rect.current.translated;
      const oRect = over.rect;
      const after =
        aRect && oRect
          ? aRect.top + aRect.height / 2 > oRect.top + oRect.height / 2
          : false;
      insertAt = overIdx + (after ? 1 : 0);
    }
    if (tgtIdx < 0) return;

    const sameBlock = srcIdx === tgtIdx;
    const next = cur.map((b) => ({ ...b, habits: [...b.habits] }));

    const removeIdx = next[srcIdx].habits.findIndex((h) => keyOf(h) === aKey);
    next[srcIdx].habits.splice(removeIdx, 1);

    // A routine is an optional tag independent of the time-block, so a habit
    // keeps its routine when moved between chains.
    let idx = oKey.startsWith("block-") ? next[tgtIdx].habits.length : insertAt;
    if (sameBlock && removeIdx < idx) idx -= 1;
    next[tgtIdx].habits.splice(idx, 0, moved);

    next[srcIdx].habits = next[srcIdx].habits.map((h, i) => ({ ...h, order: i + 1 }));
    next[tgtIdx].habits = next[tgtIdx].habits.map((h, i) => ({ ...h, order: i + 1 }));
    setBlocks(next);

    const affected = sameBlock ? [next[tgtIdx]] : [next[srcIdx], next[tgtIdx]];
    const items = affected.flatMap((b) =>
      b.habits.map((h, i) => ({
        habit: h.habit,
        chain: b.chain,
        tier: h.tier,
        order: i + 1,
        routine: h.routine,
      })),
    );
    if (items.length) void persist(items);
  }

  async function retime(chainId: number, hhmm: string) {
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/chains/retime-forward/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chain: chainId,
            time: hhmm,
            from_date: fromDateYMD(),
          }),
        },
      );
      if (!res.ok) throw new Error("retime failed");
      await load();
    } catch {
      setError("Couldn't change that time.");
      await load();
    }
  }

  // Open the Add Habit page to drop a new habit into a block. We pass which block
  // and the append position; the Add Habit page creates the habit, places it
  // (every day from today), and comes back here, which reloads on mount. The
  // Anytime block (chain null) has nothing to place into, so it's a plain add.
  function openAddHabit(chain: number | null, order: number) {
    navigate(
      chain == null ? "/habits/new" : `/habits/new?chain=${chain}&order=${order}`,
    );
  }

  async function addChain() {
    if (!newTime) return;
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/chains/create/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ time: newTime }),
      });
      if (!res.ok) throw new Error("create failed");
      const data = await res.json(); // { id, time, created }
      setNewChains((prev) =>
        prev.some((c) => c.id === data.id)
          ? prev
          : [...prev, { id: data.id, time: data.time }],
      );
      setAddingTime(false);
      setNewTime("");
      await load();
    } catch {
      setError("Couldn't add that time block.");
    }
  }

  const activeHabit = activeKey
    ? blocks.flatMap((b) => b.habits).find((h) => keyOf(h) === activeKey)
    : null;

  // What actually renders: the server's blocks plus any block added this session
  // that hasn't got a habit yet (see newChains), sorted by time with Anytime last.
  const shown: Block[] = (() => {
    const extra = newChains
      .filter((c) => !blocks.some((b) => b.chain === c.id))
      .map((c) => ({ chain: c.id, name: "", time: c.time, habits: [] }));
    if (!extra.length) return blocks;
    return [...blocks, ...extra].sort(
      (a, b) =>
        Number(a.time === null) - Number(b.time === null) ||
        (a.time ?? "").localeCompare(b.time ?? ""),
    );
  })();

  // A habit released on the rail: give it a recurring time. Reuse the block at
  // that minute when one exists, otherwise create it, then write the forward
  // placement — so one gesture does what "add a time, then drag into it" did.
  async function dropAtRecurringTime(habitKey: string, minutes: number) {
    const src = blocksRef.current.find((b) =>
      b.habits.some((h) => keyOf(h) === habitKey),
    );
    const moved = src?.habits.find((h) => keyOf(h) === habitKey);
    if (!src || !moved) return;

    const hhmm = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(
      minutes % 60,
    ).padStart(2, "0")}`;
    let chainId = blocksRef.current.find(
      (b) => b.chain != null && (b.time ?? "").slice(0, 5) === hhmm,
    )?.chain;

    if (chainId == null) {
      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_URL}/chains/create/`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ time: hhmm }),
          },
        );
        if (!res.ok) throw new Error("create failed");
        const data = await res.json();
        chainId = data.id as number;
      } catch {
        setError("Couldn't add that time block.");
        return;
      }
    }

    // The habit's new home, plus its old block renumbered without it.
    const rest = src.habits.filter((h) => keyOf(h) !== habitKey);
    const target = blocksRef.current.find((b) => b.chain === chainId);
    const items = [
      ...rest.map((h, i) => ({
        habit: h.habit,
        chain: src.chain,
        tier: h.tier,
        order: i + 1,
        routine: h.routine,
      })),
      ...(target?.habits ?? []).map((h, i) => ({
        habit: h.habit,
        chain: chainId as number,
        tier: h.tier,
        order: i + 1,
        routine: h.routine,
      })),
      {
        habit: moved.habit,
        chain: chainId as number,
        tier: moved.tier,
        order: (target?.habits.length ?? 0) + 1,
        routine: moved.routine,
      },
    ];
    await persist(items);
  }

  return (
    <>
      <Header
        title="Everyday routine"
        body="Your default schedule — what plays every day. Drag habits between blocks, drag to reorder, change a block's time, or add a block. Changes apply every day from today."
      />
      <div className="max-w-md mx-auto">
        <button
          onClick={() => navigate("/plan/")}
          className="mb-4 text-sm font-medium text-calm-600 hover:text-calm-700"
        >
          ‹ Back to today
        </button>

        {isLoading && (
          <p className="text-center text-calm-500 text-sm">Loading...</p>
        )}
        {error && <p className="text-red-500 text-sm text-center mb-3">{error}</p>}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={(e: DragStartEvent) => {
            setActiveKey(String(e.active.id));
            timeRail.onDragStart(e);
          }}
          onDragMove={timeRail.onDragMove}
          // Scrolling mid-scrub slides the ruler out from under the finger.
          autoScroll={!timeRail.isTimeMode}
          onDragCancel={() => {
            setActiveKey(null);
            timeRail.reset();
          }}
          onDragEnd={handleDragEnd}
        >
          {/* data-plan-list: the rail is bounded by this box and measures its
            gesture zone from the left edge, and the list keeps a permanent
            gutter for it (see the Plan page). */}
          <div
            data-plan-list
            className="relative"
            style={{ paddingLeft: RAIL_WIDTH }}
          >
            <TimeRail
              ruler={timeRail.ruler}
              previewMin={timeRail.previewMin}
              joinChainMin={timeRail.joinChainMin}
              names={
                new Map(
                  shown.flatMap((b) =>
                    b.chain != null && b.time
                      ? [
                          [
                            Number(b.time.slice(0, 2)) * 60 +
                              Number(b.time.slice(3, 5)),
                            b.name || formatTime(b.time),
                          ] as [number, string],
                        ]
                      : [],
                  ),
                )
              }
              habitName={activeHabit?.name ?? null}
            />
          <div
            className={`space-y-4 transition-opacity ${
              timeRail.isTimeMode ? "opacity-40" : ""
            }`}
          >
            {shown.map((b) => (
              <div
                key={b.chain ?? "anytime"}
                // Read by the time rail to place its marks against the real
                // blocks and to seed a new time from the gap being held.
                data-chain-time={b.time ?? undefined}
                className="bg-white rounded-xl shadow-sm overflow-hidden"
              >
                <div className="flex items-center justify-between gap-2 border-b border-calm-100 px-4 py-3">
                  <div>
                    <p className="font-heading text-lg text-calm-900">
                      {formatTime(b.time)}
                    </p>
                    {b.name && (
                      <p className="text-xs text-calm-400">{b.name}</p>
                    )}
                  </div>
                  {b.chain != null &&
                    (editingChain === b.chain ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="time"
                          value={editTime}
                          onChange={(e) => setEditTime(e.target.value)}
                          aria-label="New block time"
                          className="rounded-lg border border-calm-200 px-2 py-1 text-xs text-calm-700"
                        />
                        <button
                          onClick={() => {
                            if (editTime) retime(b.chain as number, editTime);
                            setEditingChain(null);
                          }}
                          className="rounded-lg bg-calm-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-calm-700"
                        >
                          OK
                        </button>
                        <button
                          onClick={() => setEditingChain(null)}
                          className="px-1.5 py-1 text-xs font-medium text-stone-400 hover:text-stone-600"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setEditingChain(b.chain as number);
                          setEditTime((b.time ?? "").slice(0, 5));
                        }}
                        className="rounded-lg border border-calm-200 px-2.5 py-1 text-xs font-medium text-calm-600 hover:border-calm-400"
                      >
                        Edit time
                      </button>
                    ))}
                </div>

                <BlockDrop chain={b.chain}>
                  <SortableContext
                    items={b.habits.map(keyOf)}
                    strategy={verticalListSortingStrategy}
                  >
                    {b.habits.length === 0 ? (
                      <p className="px-4 py-6 text-center text-sm text-stone-300">
                        Drop a habit here
                      </p>
                    ) : (
                      <ul className="divide-y divide-calm-50">
                        {b.habits.map((h) => (
                          <SortableHabit key={keyOf(h)} h={h} />
                        ))}
                      </ul>
                    )}
                  </SortableContext>
                </BlockDrop>

                <div className="border-t border-calm-50">
                  <AddHabitButton
                    onClick={() => openAddHabit(b.chain, b.habits.length + 1)}
                  />
                </div>
              </div>
            ))}
          </div>
          </div>

          {/* Hidden on the rail: it rides the finger at nearly the full width
            and would cover the very ruler mark it's setting. */}
          <DragOverlay>
            {activeHabit && !timeRail.isTimeMode ? (
              <div className="flex items-center gap-2 rounded-xl bg-white px-4 py-3 shadow-lg">
                <HabitRow h={activeHabit} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>

        {/* Add a new time block (chain). */}
        <div className="mt-4">
          {addingTime ? (
            <div className="flex items-center gap-2">
              <input
                type="time"
                value={newTime}
                onChange={(e) => setNewTime(e.target.value)}
                className="flex-1 rounded-xl border border-calm-200 px-3 py-2 text-sm text-calm-900"
              />
              <button
                onClick={addChain}
                className="rounded-xl bg-calm-600 px-4 py-2 text-sm font-medium text-white hover:bg-calm-700"
              >
                Add
              </button>
              <button
                onClick={() => {
                  setAddingTime(false);
                  setNewTime("");
                }}
                className="px-3 py-2 text-sm font-medium text-stone-400 hover:text-stone-600"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setAddingTime(true)}
              className="w-full rounded-xl border border-dashed border-calm-300 px-3 py-2.5 text-sm font-medium text-calm-500 transition-colors hover:border-calm-400 hover:text-calm-700"
            >
              ＋ Add time block
            </button>
          )}
        </div>
      </div>
    </>
  );
}

export default EverydayRoutinePage;
