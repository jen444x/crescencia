import { useState, useEffect } from "react";
import { ClockIcon } from "../../../components/icons";

// Floating bottom-right controls: "Now" jumps to the current time block (the page
// auto-scrolls there on load, but you can re-center anytime), and "↑" goes back
// to the top. "Now" only shows on today's view, and hides once you're already
// parked on the now block (the same way "↑" hides at the top); "↑" appears once
// you've scrolled down.
export function FloatingControls({
  onGoToNow,
  onGoToTop,
  getNowTop,
}: {
  onGoToNow?: () => void;
  onGoToTop: () => void;
  getNowTop?: () => number | null;
}) {
  const [scrolled, setScrolled] = useState(false);
  const [atNow, setAtNow] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 300);
      // We're "at now" once the now block's top sits at/near the viewport top —
      // the analogue of "at top" for the "↑" button. scrollToNow lands the block
      // at the top with a ~24px scroll-mt-6 offset, so a small threshold above
      // that absorbs that gap plus sub-pixel rounding.
      const nowTop = getNowTop?.() ?? null;
      setAtNow(nowTop != null && nowTop <= 80);
    };
    onScroll(); // we may already be scrolled (auto-scroll-to-now ran on load)
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [getNowTop]);

  const showNow = !!onGoToNow && !atNow;
  if (!showNow && !scrolled) return null;

  return (
    <div className="fixed bottom-28 right-6 z-20 flex flex-col items-end gap-2">
      {showNow && (
        <button
          type="button"
          onClick={onGoToNow}
          aria-label="Jump to now"
          className="flex h-10 items-center gap-1.5 rounded-full border border-mist bg-white pl-2.5 pr-3 text-xs font-semibold text-calm-600 shadow-lg transition-colors hover:bg-whisper"
        >
          <ClockIcon />
          Now
        </button>
      )}
      {scrolled && (
        <button
          type="button"
          onClick={onGoToTop}
          aria-label="Scroll to top"
          className="flex h-10 w-10 items-center justify-center rounded-full border border-mist bg-white text-calm-600 shadow-lg transition-colors hover:bg-whisper"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 15l7-7 7 7"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
