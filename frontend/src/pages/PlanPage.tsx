import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import ConfirmDialog from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ErrorBanner } from "../components/ErrorBanner";
import { EmptyState } from "../components/EmptyState";
import { useNavigate } from "react-router-dom";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  pointerWithin,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";

// Which drop target is the dragged habit over?
//
// pointerWithin FIRST, because it is the only one that reliably picks the ROW
// under the finger rather than the chain box wrapping it. Reordering inside a
// chain depends on `over` being a sibling row — that is what makes the other
// rows slide apart to open a space. Ranking purely by distance (closestCorners
// alone) let the chain container win, so a habit dragged up or down inside its
// own chain moved nothing until it was dropped.
//
// closestCorners as the FALLBACK, for the gaps between chains where the pointer
// is inside nothing at all. pointerWithin returns empty there, which used to
// leave the drag with no target; falling back keeps the nearest chain named so
// there are no dead zones.
const planCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : closestCorners(args);
};

// Plan-page domain types and tier logic now live in ./plan/* so the toolbar and
// (future) sub-components can share them. The tier helpers are unchanged — only
// their home moved — and DAY_TIERS drives the new tier dropdown.
import type { Chain, Habit } from "./plan/types";
import {
  GROWTH_LEVEL,
  computeInlineTierByHabit,
  computePlanTotals,
  computeStretchSlots,
  slotPlacement,
} from "./plan/tier";
import { isDone, isSkipped } from "./plan/status";
import { chainLabel } from "./plan/chains";
import PlanToolbar from "./plan/components/PlanToolbar";
import { DateNav } from "./plan/components/DateNav";
import { PlantHero } from "./plan/components/PlantHero";
import { DragOverlayCard } from "./plan/components/DragOverlayCard";
import { StretchSection } from "./plan/components/StretchSection";
import { AddTimeInput } from "./plan/components/AddTimeInput";
import { PlanSection } from "./plan/components/PlanSection";
import {
  startOfDay,
  toYMD,
  addDays,
  isSameDay,
  dayLabel,
  timeToMinutes,
  minutesToHHMM,
} from "./plan/dates";
import { currentBlockId, applyPlanOrder } from "./plan/segments";
import { movedHabitId } from "./plan/habit";
import {
  parseActiveId,
  parseDropTarget,
  orderChangedFrom,
  sortHabitsToTemplate,
} from "./plan/drag";
import { usePersistentState } from "../hooks/usePersistentState";
import { fetchChains, fetchDayNotes } from "./plan/api";
import { usePlanScroll } from "./plan/usePlanScroll";
import { useTimeRail } from "./plan/useTimeRail";
import { TimeRail, RAIL_WIDTH } from "./plan/components/TimeRail";
import { avoidRetimeCollision } from "./plan/retime";
import { useHabitStatus } from "./plan/useHabitStatus";
import { useNotes } from "./plan/useNotes";
import { useRoutines } from "./plan/useRoutines";
import { useBlockTimes } from "./plan/useBlockTimes";
import { useForwardMode } from "./plan/useForwardMode";
import { FloatingControls } from "./plan/components/FloatingControls";
import { NoteSheet } from "./plan/components/NoteSheet";
import { RoutineSheet } from "./plan/components/RoutineSheet";

function PlanPage() {
  const [chains, setChains] = useState<Chain[]>([]);

  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // The day being viewed (default: today). ◀/▶ move it; we re-fetch /plan/ for
  // the new day and its statuses come from that day's logs.
  const [viewedDate, setViewedDate] = useState(() => startOfDay(new Date()));
  const isViewingToday = isSameDay(viewedDate, new Date());

  // All note state + create/delete/edit handlers live in one hook; the page owns
  // the initial fetch (see load) and feeds it in via setDayNotes.
  const {
    setDayNotes,
    editingNote,
    setEditingNote,
    notesByHabit,
    createNote,
    deleteNote,
    editNote,
  } = useNotes(viewedDate, isViewingToday);

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
  const [dayTier, setDayTier] = usePersistentState("dayTier", GROWTH_LEVEL, {
    parse: (raw) => Number(raw) || GROWTH_LEVEL,
    serialize: String,
  });

  // "Main only" view: when on, the plan hides the helper/support habits (a
  // low-energy day where you just want the main ones that matter). Pure display
  // filter — no refetch, nothing logged differently. Persisted like the day-tier.
  const [mainOnly, setMainOnly] = usePersistentState("mainOnly", false, {
    parse: (raw) => raw === "1",
    serialize: (v) => (v ? "1" : "0"),
  });

  // How the plan is laid out: "rows" (the cards list, default) or "chips" (a dense
  // wrap of pills per cycle). Persisted like the tier / main-only toggles, so the
  // view stays where you left it across reloads and day switches.
  const [planView, setPlanView] = usePersistentState<"rows" | "chips">(
    "planView",
    "rows",
    { parse: (raw) => (raw === "chips" ? "chips" : "rows"), serialize: (v) => v },
  );

  // Where the plan opens (and where the floating control parks you): at "now" (the
  // current time block, the default) or at the top. Set by whichever floating
  // button you last tapped, and persisted — so the app reopens where you left it.
  const [landingPref, setLandingPref] = usePersistentState<"now" | "top">(
    "planLanding",
    "now",
    { parse: (raw) => (raw === "top" ? "top" : "now"), serialize: (v) => v },
  );

  // Bump to force a re-fetch of the current day (e.g. after a "running late" shift).
  const [reloadToken, setReloadToken] = useState(0);

  // The habit order the viewed day loaded with — the target "Reset order"
  // returns to ("back to before" = how the day looked when you opened it).
  const [baselineOrder, setBaselineOrder] = useState<Chain[] | null>(null);

  // The time block happening right now — used to badge it "Now" and to scroll
  // the page there on first load.
  const nowBlockId = useMemo(() => currentBlockId(chains), [chains]);

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

  // Scroll / landing behavior: the section-ref map, the once-only auto-scroll to
  // "now" on first load, and the floating-control helpers. See usePlanScroll.
  const { sectionRefs, scrollToNow, getNowTop } = usePlanScroll({
    chains,
    isLoading,
    isViewingToday,
    landingPref,
    nowBlockId,
  });
  // Latest plans, mirrored into a ref so a delayed callback (a toast's Undo,
  // fired seconds after the action) reads current state, not a stale closure.
  const chainsRef = useRef(chains);
  useEffect(() => {
    chainsRef.current = chains;
  }, [chains]);

  const toast = useToast();

  // Whether the "Skip day" confirmation dialog is open.
  const [skipDayOpen, setSkipDayOpen] = useState(false);
  // Routine sheet state + create/save/delete/move/status handlers (see
  // useRoutines). The page owns chains + reloadToken; the hook receives them.
  const {
    routineSheet,
    setRoutineSheet,
    setRoutineStatus,
    createRoutine,
    saveRoutine,
    deleteRoutine,
    moveRoutineToChain,
  } = useRoutines({
    chainsRef,
    viewedDate,
    isViewingToday,
    triggerReload: () => setReloadToken((t) => t + 1),
  });

  // The clarity-gate / forward-write subsystem: the "apply to future days" toggle
  // (applyToFuture), the confirm dialog it funnels through (pendingForward), and
  // the writers for a forward placement (confirmForward) and a forward/per-day
  // retime (retimePlan). See useForwardMode.
  const {
    applyToFuture,
    leaveForwardMode,
    pendingForward,
    setPendingForward,
    confirmForward,
    retimePlan,
  } = useForwardMode({
    chainsRef,
    setChains,
    isViewingToday,
    viewedDate,
    triggerReload: () => setReloadToken((t) => t + 1),
  });

  // Complete / skip / miss / clear a habit for the viewed day (optimistic, with
  // rollback). The core tap interaction; twin of setRoutineStatus. See
  // useHabitStatus.
  const { setHabitStatus } = useHabitStatus({
    chainsRef,
    setChains,
    isViewingToday,
    viewedDate,
    triggerReload: () => setReloadToken((t) => t + 1),
  });

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


  // Persist a plan's habit order for the VIEWED DAY only (no toast). Optimistic,
  // with a snapshot we restore if the save fails. Shared by a drag and its Undo.
  // Writes the per-day layer via /days/arrange/ — never the recurring template.
  async function postReorder(chainId: number, orderedHabits: Habit[]) {
    if (orderedHabits.length === 0) return;

    // /days/arrange/ keys on row_id (the day's stable per-row key) and wants the
    // whole list with fresh 1..N orders. A not-yet-saved row (placed this
    // session, no row_id) is sent as a {habit, plan, order} placement instead of
    // an {id: null} move — which the backend rejects — so the reorder persists.
    const items = orderedHabits.map(
      (habit, i): Record<string, number | null> =>
        habit.row_id != null
          ? { id: habit.row_id, order: i + 1 }
          : { habit: habit.id, chain: chainId, order: i + 1 },
    );

    await commitArrange(
      (prev) => applyPlanOrder(prev, chainId, orderedHabits),
      items,
      "Couldn't reorder — try again",
    );
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
  // Where the dragged row is hovering right now: a chain id, null for the
  // Anytime group, undefined when it isn't over anything. Powers the overlay's
  // live "→ 8:15 AM" chip so you can see where the habit would land.
  const [dragOverPlanId, setDragOverPlanId] = useState<
    number | null | undefined
  >(undefined);
  // The row the dragged habit is hovering over, so the target block can show a
  // line at the exact spot it would land (null = the block's empty space, i.e.
  // the end of the list). The chip alone only said WHICH block, never where.
  const [dragOverRid, setDragOverRid] = useState<number | null>(null);
  // Blocks just made with "＋ Add time" that are still empty. Empty blocks are
  // normally filtered out of the render (so historical bare time labels don't
  // show), but a brand-new one must stay visible so you can drag a habit into
  // it. Once it has a habit it survives on its own; this set only keeps the
  // empty window open. Also drives the inline add-time input.
  const [newPlanIds, setNewPlanIds] = useState<Set<number>>(() => new Set());
  // Add-time input state + the block create/shift/rename handlers (see
  // useBlockTimes). Retiming a block stays in the page — it routes through the
  // forward-mode gate below.
  const { addingTime, setAddingTime, addTime, shiftFromPlan, renamePlan } =
    useBlockTimes({
      chainsRef,
      setChains,
      setNewPlanIds,
      viewedDate,
      triggerReload: () => setReloadToken((t) => t + 1),
    });
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

  // Drag a habit LEFT onto the time rail and the drag stops being about chains
  // and starts being about time, so it can be given a time no chain has yet. The
  // hook only watches the gesture; dropAtNewTime below is what a drop on the
  // rail actually does.
  const timeRail = useTimeRail();

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

  // The optimistic-write spine shared by every per-day board edit (reorder, move
  // across blocks, place from Anytime). Snapshot the board, apply `next` on
  // screen right away, POST `items` to /days/arrange/, then reconcile: on success
  // re-fetch /plan/ (a freeze can reassign row_ids) and hand back the snapshot so
  // the caller can wire an Undo; on failure roll the board back and surface
  // `errorMessage`. Returns whether the write stuck plus the pre-edit snapshot.
  async function commitArrange(
    next: Chain[] | ((prev: Chain[]) => Chain[]),
    items: Array<Record<string, number | null>>,
    errorMessage: string,
  ): Promise<{ ok: boolean; snapshot: Chain[] }> {
    const snapshot = chainsRef.current;
    setChains(next);
    const ok = await persistItems(items);
    if (!ok) {
      // Don't silently snap back — surface it so a rejected save is visible.
      setChains(snapshot);
      toast(errorMessage, { variant: "error" });
      return { ok, snapshot };
    }
    // A frozen day forks template rows into ScheduleDay rows (new row_ids), so
    // re-fetch /plan/ to pick up the day's real keys + reconcile.
    setReloadToken((token) => token + 1);
    return { ok, snapshot };
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

    const items = [
      ...newFrom.map((h, i) => ({ id: h.row_id ?? null, order: i + 1 })),
      ...newTo.map((h, i) =>
        h.row_id === rid
          ? { id: rid, order: i + 1, chain: toChain.id, routine: null }
          : { id: h.row_id ?? null, order: i + 1 },
      ),
    ];
    const { ok, snapshot } = await commitArrange(
      (prev) =>
        prev.map((p) =>
          p.id === fromChain.id
            ? { ...p, habits: newFrom.map((h, i) => ({ ...h, order: i + 1 })) }
            : p.id === toChain.id
              ? { ...p, habits: newTo.map((h, i) => ({ ...h, order: i + 1 })) }
              : p,
        ),
      items,
      "Couldn't move that habit",
    );
    if (!ok) return;

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
    // The board to compute from. Defaults to current state, but a caller that
    // JUST created the target chain has to pass it in: addTime's setChains only
    // schedules a React update, and chainsRef is refreshed by an effect after
    // the next render — so reading state here would not yet contain the new
    // chain. It then found no target block, sent an EMPTY items list, and the
    // habit silently stayed put while the freshly made (empty) time slot
    // remained on the board.
    baseChains?: Chain[],
  ) {
    const snapshot = baseChains ?? chainsRef.current;
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
    // A placement that produced nothing to write means the target block wasn't
    // on the board we computed from. Posting an empty list is a silent no-op, so
    // fail loudly instead of pretending it worked.
    if (items.length === 0) {
      toast("Couldn't place that habit", { variant: "error" });
      return;
    }
    // The freeze assigns the new row its row_id; commitArrange re-fetches to
    // reconcile on success.
    const { ok } = await commitArrange(next, items, "Couldn't place that habit");
    if (!ok) return;
    toast("Habit placed");
  }

  // Drop a TIMED habit back into "Anytime" — take its time away for the viewed
  // day, leaving it on the day but unscheduled. The per-day layer already
  // supports this: /days/arrange/ treats `chain: null` as "no block", which is
  // exactly what Anytime is. Optimistic, with an Undo that puts the time back.
  async function clearHabitTime(sourceChain: Chain, rid: number) {
    if (sourceChain.id == null) return;
    const moved = sourceChain.habits.find((h) => h.row_id === rid);
    if (!moved) return;

    const origFrom = sourceChain.habits;
    const newFrom = origFrom.filter((h) => h.row_id !== rid);

    // Forward mode is about where a habit sits every day; "just untime it" has
    // no forward equivalent yet, so keep this per-day only and say so.
    if (applyToFuture && isViewingToday) {
      toast("Removing a time works for this day only", { variant: "error" });
      return;
    }

    const next = chainsRef.current.map((p) => {
      if (p.id === sourceChain.id)
        return { ...p, habits: newFrom.map((h, i) => ({ ...h, order: i + 1 })) };
      if (p.id == null)
        return { ...p, habits: [...p.habits, { ...moved, routine: null }] };
      return p;
    });

    const items = [
      { id: rid, order: 1, chain: null, routine: null },
      ...newFrom.map((h, i) => ({ id: h.row_id ?? null, order: i + 1 })),
    ];
    const { ok, snapshot } = await commitArrange(
      next,
      items,
      "Couldn't remove that time",
    );
    if (!ok) return;

    toast("Time removed", {
      action: {
        label: "Undo",
        onClick: () => {
          setChains(snapshot);
          persistItems(
            origFrom.map((h, i): Record<string, number | null> =>
              h.row_id === rid
                ? {
                    id: rid,
                    order: i + 1,
                    chain: sourceChain.id!,
                    routine: h.routine ?? null,
                  }
                : { id: h.row_id ?? null, order: i + 1 },
            ),
          ).then(() => setReloadToken((token) => token + 1));
        },
      },
    });
  }

  // A habit released on the time rail — i.e. dropped at a time no block has yet.
  // Make the block at that minute, then reuse the ordinary placement path to put
  // the habit in it, so a habit given a brand-new time and one dragged into an
  // existing block travel exactly the same code.
  async function dropAtNewTime(rawActive: string, minutes: number) {
    // Two blocks on the same minute render as two stacked rows, which she didn't
    // want — step to the nearest free minute, same as retiming a block does.
    const taken = chains.flatMap((p) =>
      p.id != null && p.time ? [timeToMinutes(p.time)] : [],
    );
    const time = minutesToHHMM(avoidRetimeCollision(minutes, taken));
    const created = await addTime(time);
    if (!created) return; // create failed — addTime already said so

    const { newHabitId, activeRid } = parseActiveId(rawActive);

    // The board WITH the new chain on it. addTime has only scheduled its state
    // update, so we splice it in ourselves rather than read state that hasn't
    // caught up yet (see placeHabit's baseChains).
    const withNew: Chain[] = chainsRef.current.some((p) => p.id === created.id)
      ? chainsRef.current
      : [
          ...chainsRef.current.filter((p) => p.id != null),
          { id: created.id, time: created.time, name: "", habits: [] },
        ]
          .sort(
            (a, b) => timeToMinutes(a.time ?? "") - timeToMinutes(b.time ?? ""),
          )
          .concat(chainsRef.current.filter((p) => p.id == null));

    // An Anytime habit, which has no row yet: place it into the new block.
    if (newHabitId != null) {
      await placeHabit(newHabitId, created.id, null, withNew);
      return;
    }
    // An already-timed row: move it out of its block into the new one.
    if (activeRid == null) return;
    const sourcePlan = withNew.find(
      (p) => p.id != null && p.habits.some((h) => h.row_id === activeRid),
    );
    if (!sourcePlan) return;
    await moveAcrossBlocks(
      sourcePlan,
      { id: created.id, time: created.time, name: "", habits: [] },
      activeRid,
      null,
    );
  }

  // The page-level drop handler. The dragged id is a row_id (stable across the
  // template->frozen flip); the drop target is either another row (its row_id)
  // or a block's empty space (`plan-<id>`). Same block -> reorder; different
  // block -> move across. Both write the per-day layer via /days/arrange/.
  function handlePlanDragEnd(event: DragEndEvent) {
    setDragId(null); // drop finished — tear down the overlay
    setDragOverPlanId(undefined);
    setDragOverRid(null);
    const { active, over } = event;

    // The drag ended on the rail, so this drop is about TIME, not about whatever
    // block dnd-kit still reports under the pointer. Read the hook before
    // resetting it, which clears both values.
    if (timeRail.isTimeMode) {
      const minutes = timeRail.previewMin;
      const joinMin = timeRail.joinChainMin;
      timeRail.reset();
      // Scrubbed onto a time that already has a chain: put the habit IN that
      // chain rather than making a second chain at the same minute. So the rail
      // reaches the existing chains too, not just new times.
      if (joinMin != null) {
        const target = chains.find(
          (p) => p.id != null && p.time && timeToMinutes(p.time) === joinMin,
        );
        if (target?.id != null) {
          const { newHabitId, activeRid } = parseActiveId(String(active.id));
          if (newHabitId != null) {
            placeHabit(newHabitId, target.id, null);
          } else if (activeRid != null) {
            const source = chains.find(
              (p) =>
                p.id != null && p.habits.some((h) => h.row_id === activeRid),
            );
            if (source && source.id !== target.id)
              moveAcrossBlocks(source, target, activeRid, null);
          }
        }
        return;
      }
      if (minutes != null) dropAtNewTime(String(active.id), minutes);
      return;
    }
    timeRail.reset();
    if (!over) return;

    // The dragged row is either a numeric row_id (already on the timeline) or
    // "new-<habitId>" — an Anytime habit with no row yet. Which block was it
    // dropped on, and on which row (overRid) or empty space (null)?
    const { newHabitId, activeRid } = parseActiveId(String(active.id));
    const { overRid, targetPlanId } = parseDropTarget(String(over.id), chains);

    // Placing a habit out of Anytime onto a real block, at the drop position
    // (`overRid` = the row it landed on, or null when dropped on empty space).
    if (newHabitId != null) {
      if (targetPlanId != null) placeHabit(newHabitId, targetPlanId, overRid);
      return; // anytime -> anytime is a no-op
    }

    if (activeRid == null) return;

    const sourcePlan = chains.find(
      (p) => p.id != null && p.habits.some((h) => h.row_id === activeRid),
    );
    if (!sourcePlan || sourcePlan.id == null) return;

    // Dropped on the Anytime group: take the habit's time away for the day. It
    // stays on the plan, just unscheduled.
    if (targetPlanId == null) {
      clearHabitTime(sourcePlan, activeRid);
      return;
    }

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
      const { reordered, changed } = sortHabitsToTemplate(
        chain.habits,
        tpl.habits.map((h) => h.id),
      );
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

  // Each timed chain's label, keyed by its start minute — what the time rail
  // prints beside its marks.
  const chainNamesByMinute = useMemo(
    () =>
      new Map(
        chains.flatMap((p) =>
          p.id != null && p.time
            ? [
                [timeToMinutes(p.time), p.name || chainLabel(p.habits, p.time)] as [
                  number,
                  string,
                ],
              ]
            : [],
        ),
      ),
    [chains],
  );

  // Has the user reordered anything away from the day's load-time order? Drives
  // whether the "Reset order" control shows. Recomputes with plans; the baseline
  // ref only changes alongside a fetch (which also updates plans).
  const orderChanged = useMemo(
    () => orderChangedFrom(chains, baselineOrder),
    [chains, baselineOrder],
  );

  useEffect(() => {
    // Load everything the day needs: the board (chains) + its notes. The network
    // calls live in ./plan/api; this owns loading/error and applies results.
    async function loadDay() {
      setIsLoading(true);
      setError("");
      try {
        // /plan/ and /days/notes/ are independent reads for the same day — fetch
        // them together so notes don't add a serial round-trip.
        const [data, notes] = await Promise.all([
          fetchChains(viewedDate),
          fetchDayNotes(viewedDate),
        ]);
        // A frozen /plan/ now returns the day's never-placed unscheduled habits in
        // the Anytime group itself (see habits/views.plan), so the screen matches a
        // fresh GET every time — no client-side re-attach needed, and a refresh is
        // truthful on its own.
        setChains(data);
        // The order this day loaded with — what "Reset order" returns to.
        setBaselineOrder(data);
        setDayNotes(notes);
      } catch (error) {
        setError(
          error instanceof Error ? error.message : "An unknown error occurred",
        );
      } finally {
        setIsLoading(false);
      }
    }
    loadDay();
    // Re-runs when the viewed day changes, or reloadToken is bumped (e.g. after
    // a "running late" shift) to pull the day's new effective times. setDayNotes
    // (from useNotes) is a stable setter — listed to satisfy exhaustive-deps.
  }, [viewedDate, reloadToken, setDayNotes]);

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

  // habit id -> its "today" tier-slot level (highest h.tier <= dayTier), which
  // renders inline while lower slots cascade-hide and higher ones stretch. Logic
  // lives in tier.ts; see computeInlineTierByHabit.
  // NOTE: the react-hooks lint runs React Compiler analysis and can't "preserve"
  // this memo, but the compiler isn't in our build (no babel-plugin-react-compiler
  // in vite.config), so this useMemo is real, needed memoization — it also feeds
  // the tierVisibleChains/shownChains memos below. Keep it; silence the
  // compiler-only check rather than drop working memoization.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const inlineTierByHabit = useMemo(
    () => computeInlineTierByHabit(visibleChains, dayTier),
    [visibleChains, dayTier],
  );

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

  // Today's tally for the plant meter (its wilting/steady/flourishing state) —
  // mirrors the cards on screen because shownChains is already tier + "Main only"
  // filtered. See computePlanTotals for how it reads per-rung status.
  const planTotals = useMemo(
    () => computePlanTotals(shownChains, dayTier),
    [shownChains, dayTier],
  );

  // The "Stretch" section: harder versions she can opt into. Two sources, in plan
  // order: (1) Case-A slots that placed as "stretch" (a tier above today that lives
  // at its own time), each completed at its own `tier`; (2) synthesized entries for
  // every Case-B rung ABOVE today (level > dayTier) — same habit, that rung's value,
  // completed at that level. `level` is the tier each card shows + sends. Honors
  // "Main only" like the inline groups.
  const stretchSlots = useMemo(
    () =>
      computeStretchSlots(visibleChains, inlineTierByHabit, dayTier, mainOnly),
    [visibleChains, inlineTierByHabit, dayTier, mainOnly],
  );

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
    // Which block is the dragged habit coming FROM? A move within one block
    // already shows itself — dnd-kit slides the rows apart — so the highlight is
    // reserved for a habit arriving from somewhere else, where nothing showed.
    const { newHabitId, activeRid } = dragId
      ? parseActiveId(dragId)
      : { newHabitId: null, activeRid: null };
    const dragFromPlanId =
      newHabitId != null
        ? null // came out of Anytime
        : (chains.find(
            (p) => p.id != null && p.habits.some((h) => h.row_id === activeRid),
          )?.id ?? undefined);
    // Suppressed while the drag is on the rail: closestCorners still names a
    // nearest block, but the habit is headed for a new time, and a slot opening
    // in a chain she isn't aiming at would contradict the rail.
    const dropPreview =
      dragId != null &&
      !timeRail.isTimeMode &&
      dragOverPlanId != null &&
      dragOverPlanId !== dragFromPlanId
        ? { chainId: dragOverPlanId, overRid: dragOverRid }
        : null;

    body = (
      <>
        <DndContext
          sensors={planSensors}
          collisionDetection={planCollision}
          // Auto-scroll is for reaching a chain that's off screen. On the rail
          // it only does harm: the list slides while she's picking a time, which
          // moves the ruler out from under her finger for no reason.
          autoScroll={!timeRail.isTimeMode}
          onDragStart={(e) => {
            setDragId(String(e.active.id));
            timeRail.onDragStart(e);
          }}
          onDragMove={timeRail.onDragMove}
          onDragOver={(e) => {
            const target = e.over
              ? parseDropTarget(String(e.over.id), chains)
              : null;
            setDragOverPlanId(target ? target.targetPlanId : undefined);
            setDragOverRid(target ? target.overRid : null);
          }}
          onDragCancel={() => {
            setDragId(null);
            setDragOverPlanId(undefined);
            setDragOverRid(null);
            timeRail.reset();
          }}
          onDragEnd={handlePlanDragEnd}
        >
          {/* data-plan-list: the rail lives in this box and is bounded by it, so
            it can never draw over the plant, the quote, or the toolbar. The box
            keeps a permanent left gutter for it — the rail is always on screen,
            and on a phone the list is otherwise edge-to-edge, so a rail with no
            gutter would lie on top of the cards. */}
          <div
            data-plan-list
            className="relative"
            style={{ paddingLeft: RAIL_WIDTH }}
          >
            <TimeRail
              ruler={timeRail.ruler}
              previewMin={timeRail.previewMin}
              joinChainMin={timeRail.joinChainMin}
              names={chainNamesByMinute}
              habitName={draggingHabit?.name ?? null}
            />

            <div
              className={`space-y-6 transition-opacity ${
                // On the rail the drag is about time, so the list steps back and
                // the rail becomes the thing being read.
                timeRail.isTimeMode
                  ? "opacity-40"
                  : isLoading
                    ? "opacity-60"
                    : ""
              }`}
            >
            {shownChains.map((chain) => {
              const key = chain.id ?? "anytime";
              return (
                <PlanSection
                  key={key}
                  chain={chain}
                  collapsed={collapsedChains.has(String(key))}
                  onToggle={() => toggleCollapsed(String(key))}
                  sectionRef={(el) => {
                    sectionRefs.current[String(key)] = el;
                  }}
                  dayTier={dayTier}
                  inlineTierByHabit={inlineTierByHabit}
                  mainOnly={mainOnly}
                  planView={planView}
                  isViewingToday={isViewingToday}
                  nowBlockId={nowBlockId}
                  visibleChains={visibleChains}
                  isPastDay={isPastDay}
                  onStatus={setHabitStatus}
                  onOpenNote={setEditingNote}
                  onRoutineLog={setRoutineStatus}
                  onEditRoutine={(id, name) =>
                    setRoutineSheet({ mode: "edit", id, name })
                  }
                  onRetime={retimePlan}
                  onShift={shiftFromPlan}
                  onRename={renamePlan}
                  dropPreview={dropPreview}
                />
              );
            })}

            <StretchSection
              slots={stretchSlots}
              dayTier={dayTier}
              onStatus={setHabitStatus}
              onOpenNote={setEditingNote}
            />
            </div>
          </div>
          {/* Floating copy that follows the finger so the dragged habit stays
            visible as it crosses between chains. Hidden once the drag is on the
            rail: it rides the finger at nearly the full width of the screen, so
            it sat squarely on top of the ruler mark it was setting — the strip
            looked frozen because its one moving part was underneath. The ruler
            names the habit itself while it's up. */}
          <DragOverlay>
            {draggingHabit && !timeRail.isTimeMode ? (
              <DragOverlayCard
                habit={draggingHabit}
                dragOverPlanId={dragOverPlanId}
                chains={chains}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      </>
    );
  }

  return (
    <>
      <div className="max-w-md mx-auto">
        <PlantHero
          done={planTotals.done}
          total={planTotals.total}
          missed={planTotals.missed}
        />

        {/* Date selector: browse other days; the plant + quote above are the
            page header, so this stays compact. */}
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

        {/* Day-level controls: the tier picker, the main-only filter, and
            the rare actions (new routine / skip day / reset), grouped into one
            compact bar. See ./plan/PlanToolbar. */}
        {visibleChains.length > 0 && (
          <PlanToolbar
            dayTier={dayTier}
            onTierChange={setDayTier}
            mainOnly={mainOnly}
            onToggleMainOnly={() => setMainOnly((v) => !v)}
            planView={planView}
            onViewChange={setPlanView}
            onEverydayRoutine={() => navigate("/routine")}
            onNewRoutine={() => setRoutineSheet({ mode: "create" })}
            onAddTime={() => setAddingTime(true)}
            showResetOrder={isViewingToday && orderChanged}
            onResetOrder={resetOrder}
            showResetDay={dayFullySkipped || dayHasArrangement}
            showSkipDay={!dayFullySkipped}
            onSkipDay={() => setSkipDayOpen(true)}
            onResetDay={() => clearDay(viewedDate)}
          />
        )}

        {/* "Add time" form (opened from the ⋯ menu): a new empty chain at the
          time you pick — drag a habit into it. Renders right here under the
          toolbar so the menu action doesn't jump the page anywhere. */}
        {addingTime && (
          <AddTimeInput onAdd={addTime} onClose={() => setAddingTime(false)} />
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
        getNowTop={getNowTop}
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
