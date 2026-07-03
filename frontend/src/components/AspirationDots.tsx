import { bloomFor } from "./ui";

// Tiny colored dots marking which aspirations a habit serves — one dot per
// aspiration, in that aspiration's bed color (see BLOOMS in ui.ts), so a habit
// visually points back to the garden beds it feeds. Capped at three; purely
// decorative (the aspiration names live on the Aspirations page).
export default function AspirationDots({
  ids,
  className = "",
}: {
  ids?: number[];
  className?: string;
}) {
  if (!ids || ids.length === 0) return null;
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center gap-1 ${className}`}
    >
      {ids.slice(0, 3).map((id) => (
        <span
          key={id}
          className="h-[7px] w-[7px] rounded-full"
          style={{ background: bloomFor(id).dot }}
        />
      ))}
    </span>
  );
}
