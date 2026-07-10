import { bloomFor } from "./ui";

// One aspiration reference as it rides along on habit data: its id, and its
// chosen bloom color index (null = the id-based default).
export type AspirationRef = { id: number; color?: number | null };

// Tiny colored dots marking which aspirations a habit serves — one dot per
// aspiration, in that aspiration's bed color (see BLOOMS in ui.ts), so a habit
// visually points back to the garden beds it feeds. Capped at three; purely
// decorative (the aspiration names live on the Aspirations page).
export default function AspirationDots({
  aspirations,
  className = "",
}: {
  aspirations?: AspirationRef[];
  className?: string;
}) {
  if (!aspirations || aspirations.length === 0) return null;
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center gap-1 ${className}`}
    >
      {aspirations.slice(0, 3).map((a) => (
        <span
          key={a.id}
          className="h-[7px] w-[7px] rounded-full"
          style={{ background: bloomFor(a.id, a.color).dot }}
        />
      ))}
    </span>
  );
}
