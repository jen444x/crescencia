import { useNavigate } from "react-router-dom";
import { PlanBoard } from "./PlanBoard";
import { RetimeBlock } from "./RetimeBlock";
import { ChainNameControl } from "./ChainNameControl";
import { ShiftControl } from "./ShiftControl";
import AddHabitButton from "../../../components/AddHabitButton";
import { ChevronIcon, RetimeHandleIcon } from "../../../components/icons";
import { chainLabel } from "../chains";
import { formatTime, timeToMinutes } from "../dates";
import { isDone, isSkipped } from "../status";
import type { Chain, Habit, HabitStatus } from "../types";

// One plan section: a timed chain (wrapped in RetimeBlock — grab the header to
// set its time) or the untimed "Anytime" group (plain header, nothing to retime).
// Both render the same PlanBoard habit list; only the header chrome differs. The
// page owns collapse state + the section ref, and passes them (plus the mutation
// handlers) down, since a reorder/retime/rename all write the page's chains.
export function PlanSection({
  chain,
  collapsed,
  onToggle,
  sectionRef,
  dayTier,
  inlineTierByHabit,
  mainOnly,
  planView,
  isViewingToday,
  nowBlockId,
  visibleChains,
  isPastDay,
  onStatus,
  onOpenNote,
  onRoutineLog,
  onEditRoutine,
  onRetime,
  onShift,
  onRename,
  dropPreview,
}: {
  chain: Chain;
  collapsed: boolean;
  onToggle: () => void;
  sectionRef: (el: HTMLElement | null) => void;
  dayTier: number;
  inlineTierByHabit: Map<number, number | null>;
  mainOnly: boolean;
  planView: "rows" | "chips";
  isViewingToday: boolean;
  nowBlockId: number | null;
  visibleChains: Chain[];
  isPastDay: boolean;
  onStatus: (habitId: number, status: HabitStatus, tier?: number) => void;
  onOpenNote: (habit: Habit) => void;
  onRoutineLog: (routineId: number, status: HabitStatus) => void;
  onEditRoutine: (id: number, name: string) => void;
  onRetime: (chainId: number, time: string) => void;
  onShift: (chainId: number, minutes: number) => void;
  onRename: (chainId: number, name: string) => void;
  // Where a habit dragged in from another block would land — passed straight
  // through to PlanBoard, which draws the highlight + insertion line.
  dropPreview?: { chainId: number; overRid: number | null } | null;
}) {
  const navigate = useNavigate();
  const isNow =
    isViewingToday && chain.id != null && chain.id === nowBlockId;
  // Progress for the collapsed header — a member counts as handled when it's done
  // OR skipped (same rule RoutineBlock uses). Counts the shown habits, so the
  // header matches the cards (a Roots day excludes hidden Growth; "Main only"
  // excludes the helpers).
  const total = chain.habits.length;
  const handled = chain.habits.filter(
    (h) => isDone(h) || isSkipped(h),
  ).length;
  // PlanBoard renders from the FULL plan (all this chain's habits, hidden ones
  // included) and does its own tier filtering for display — so a reorder rebuilds
  // the whole list and never drops a hidden habit from state. Fall back to the
  // tier-filtered chain if no full match (can't happen, but keeps the type
  // non-null).
  const fullChain = visibleChains.find((p) => p.id === chain.id) ?? chain;
  // In the dense chips view the add control flows INSIDE the chip line, right
  // after the last habit, instead of taking a full row of its own (her call —
  // the block-level button only renders in the rows view).
  const inlineAdd =
    planView === "chips" && !isPastDay && chain.id != null ? (
      <button
        type="button"
        onClick={() =>
          navigate(
            `/habits/new?chain=${chain.id}&order=${fullChain.habits.length + 1}`,
          )
        }
        className="inline-flex items-center rounded-md px-2 py-1 align-middle text-sm font-medium text-calm-500 transition-colors hover:bg-calm-50 hover:text-calm-700"
      >
        ＋ Add habit
      </button>
    ) : undefined;
  // The habit list is identical whether or not the block is retime-able; build it
  // once and drop it into the right wrapper below.
  const planBoard = (
    <PlanBoard
      chain={fullChain}
      dayTier={dayTier}
      inlineTierByHabit={inlineTierByHabit}
      mainOnly={mainOnly}
      planView={planView}
      onStatus={onStatus}
      onOpenNote={onOpenNote}
      onRoutineLog={onRoutineLog}
      onEditRoutine={onEditRoutine}
      inlineAdd={inlineAdd}
      dropPreview={dropPreview}
      // Drag works on any viewed day — it writes the per-day layer
      // (/days/arrange/), not the recurring template.
      interactive
    />
  );

  return (
    <section
      ref={sectionRef}
      // The block's time, readable from the DOM. useDropRuler needs to know
      // which blocks sit above and below a drop point to seed the ruler, and a
      // data attribute keeps that lookup out of the page's props.
      data-chain-time={chain.time ?? undefined}
      // Leave a little breathing room above the block when we scroll to it.
      className="scroll-mt-6"
    >
      {chain.id != null && chain.time ? (
        // Timed chain: the whole block is the unit you retime — grab the header
        // strip and it lifts to a new time. OFF = today only; with "Apply to
        // future days" ON it sticks every day from today.
        <RetimeBlock
          chainId={chain.id}
          time={chain.time}
          blockLabel={chain.name || chainLabel(chain.habits, chain.time)}
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
          onRetime={onRetime}
          header={
            <div className="flex items-center gap-3 mb-2">
              {/* Collapse/expand this chain. Carries data-no-retime so
              tapping it toggles instead of starting a time-drag. */}
              <button
                type="button"
                data-no-retime
                onClick={onToggle}
                aria-expanded={!collapsed}
                aria-label={
                  collapsed
                    ? `Expand ${formatTime(chain.time)}`
                    : `Collapse ${formatTime(chain.time)}`
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
                {formatTime(chain.time)}
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
              {/* The chain's name (or the chainLabel fallback when unnamed) —
              tap to name/rename. data-no-retime inside, so editing doesn't
              start the header's time-drag. */}
              {!collapsed && (
                <ChainNameControl
                  name={chain.name ?? ""}
                  label={
                    chain.name
                      ? chain.name
                      : chainLabel(chain.habits, chain.time)
                  }
                  onSave={(n) => onRename(chain.id!, n)}
                />
              )}
              {isNow && (
                <span className="rounded-full bg-calm-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                  Now
                </span>
              )}
              <div className="flex-1 h-px bg-mist" />
              {/* "Running late" shift stays tappable — opt it out of the
              block's retime drag. */}
              <div data-no-retime>
                <ShiftControl chainId={chain.id} onShift={onShift} />
              </div>
            </div>
          }
        >
          {collapsed ? null : (
            <>
              {planBoard}
              {planView === "rows" && !isPastDay && chain.id != null && (
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
              onClick={onToggle}
              aria-expanded={!collapsed}
              aria-label={
                collapsed
                  ? `Expand ${formatTime(chain.time)}`
                  : `Collapse ${formatTime(chain.time)}`
              }
              className="shrink-0 text-calm-400 transition-colors hover:text-calm-600"
            >
              <ChevronIcon open={!collapsed} />
            </button>
            <span className="inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-calm-600">
              {formatTime(chain.time)}
              {collapsed && (
                <span className="normal-case tracking-normal text-calm-400">
                  · {handled}/{total} done
                </span>
              )}
            </span>
            <div className="flex-1 h-px bg-mist" />
          </div>
          {!collapsed && (
            <>
              {planBoard}
              {planView === "rows" && !isPastDay && chain.id != null && (
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
}
