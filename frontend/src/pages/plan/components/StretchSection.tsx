import { HabitCard } from "./HabitCard";
import type { Habit, HabitStatus } from "../types";

// The "Stretch" section: the day's harder versions, gathered at the bottom. Each
// Case-A slot above today and each Case-B rung above today shows as a standalone
// card whose check completes THAT rung (completeTier=level). Renders nothing when
// there are no stretch slots, so a plain day shows no extra section. Entries come
// from computeStretchSlots in tier.ts.
export function StretchSection({
  slots,
  dayTier,
  onStatus,
  onOpenNote,
}: {
  slots: { habit: Habit; level: number }[];
  dayTier: number;
  onStatus: (habitId: number, status: HabitStatus, tier?: number) => void;
  onOpenNote: (habit: Habit) => void;
}) {
  if (slots.length === 0) return null;
  return (
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
        {slots.map(({ habit, level }) => (
          <li key={`stretch-${habit.id}-${level}`}>
            <HabitCard
              habit={habit}
              dayTier={dayTier}
              completeTier={level}
              onStatus={onStatus}
              onOpenNote={onOpenNote}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
