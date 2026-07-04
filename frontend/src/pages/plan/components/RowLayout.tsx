import type { Habit, HabitStatus } from "../types";
import type { ReactNode, CSSProperties } from "react";
import { HabitCard } from "./HabitCard";
// Shared layout. Chain steps get a numbered badge + connector line in a left
// rail (a label only — dragging happens via the grip inside the card).
// Standalone habits have no rail, so their card spans the full width.
export function RowLayout({
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
          <span className="z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-calm-300 bg-calm-50 text-[10px] font-medium text-calm-500">
            {stepNumber}
          </span>
          {connectBelow && <span className="w-px grow bg-calm-200" />}
        </div>
      )}
      {/* min-w-0 lets this column shrink below the note's width so the note can
          truncate instead of pushing the card (and its ✓ button) off-screen. */}
      <div className="min-w-0 flex-1">
        <HabitCard
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
