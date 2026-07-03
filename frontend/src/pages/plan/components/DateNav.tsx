import { dayLabel, isSameDay } from "../dates";

// The ◀ [day] ▶ bar above the plan, for browsing other days. The layout is the
// same every day; only each habit's done/skipped state changes. "Jump to today"
// only appears once you've navigated away.

export function DateNav({
  date,
  onPrev,
  onNext,
  onToday,
}: {
  date: Date;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}) {
  const viewingToday = isSameDay(date, new Date());
  return (
    <div className="mb-4 flex items-center justify-between">
      <button
        type="button"
        onClick={onPrev}
        aria-label="Previous day"
        className="flex h-9 w-9 items-center justify-center rounded-full text-sage-600 transition-colors hover:bg-sage-100"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 19l-7-7 7-7"
          />
        </svg>
      </button>

      <div className="flex flex-col items-center">
        <span className="font-heading text-xl leading-tight text-sage-900">
          {dayLabel(date)}
        </span>
        {!viewingToday && (
          <button
            type="button"
            onClick={onToday}
            className="text-[11px] font-medium uppercase tracking-wide text-lavender-600 transition-colors hover:text-lavender-700"
          >
            Jump to today
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={onNext}
        aria-label="Next day"
        className="flex h-9 w-9 items-center justify-center rounded-full text-sage-600 transition-colors hover:bg-sage-100"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5l7 7-7 7"
          />
        </svg>
      </button>
    </div>
  );
}
