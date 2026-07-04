import { GripIcon } from "../../../components/icons";
import { formatTime } from "../dates";
import type { Chain, Habit } from "../types";

// The floating copy that follows the finger during a drag so the dragged habit
// stays visible as it crosses between blocks. Shows the habit name and a live
// destination chip (the block currently under your finger). Rendered inside the
// page's <DragOverlay> (which must stay a child of DndContext).
export function DragOverlayCard({
  habit,
  dragOverPlanId,
  chains,
}: {
  habit: Habit;
  // The block under the finger right now: a chain id, null for "Anytime", or
  // undefined when not over any drop target.
  dragOverPlanId: number | null | undefined;
  chains: Chain[];
}) {
  const targetChain =
    dragOverPlanId != null
      ? chains.find((c) => c.id === dragOverPlanId)
      : undefined;
  return (
    <div className="rotate-1 scale-[1.03]">
      <div className="flex items-center gap-2.5 rounded-[18px] border border-mist bg-white px-4 py-3 text-sm font-medium text-ink shadow-[0_14px_34px_rgba(27,46,42,0.20)]">
        <span className="shrink-0 text-calm-300">
          <GripIcon />
        </span>
        <span className="min-w-0 flex-1 truncate">{habit.name}</span>
        {/* Live destination — the block under your finger. */}
        {dragOverPlanId !== undefined && (
          <span className="shrink-0 rounded-full border border-mist bg-whisper px-2.5 py-1 text-[11px] font-semibold text-calm-700">
            {dragOverPlanId === null
              ? "Anytime"
              : targetChain?.time
                ? `→ ${formatTime(targetChain.time)}`
                : "→ here"}
          </span>
        )}
      </div>
    </div>
  );
}
