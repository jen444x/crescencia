import { useEffect, useRef } from "react";
import type { Chain } from "./types";

// The plan page's scroll / landing behavior, kept out of the component body: a DOM
// node per section (so we can scroll a block into view), a once-only auto-scroll to
// the current "now" block on first load (unless the saved landing preference is
// "top"), and the two helpers the floating controls use — jump to now, and measure
// where now currently sits. The page owns chains + nowBlockId + landingPref and
// passes them in; the hook returns the section-ref map and the scroll helpers.
export function usePlanScroll({
  chains,
  isLoading,
  isViewingToday,
  landingPref,
  nowBlockId,
}: {
  chains: Chain[];
  isLoading: boolean;
  isViewingToday: boolean;
  landingPref: "now" | "top";
  nowBlockId: number | null;
}) {
  // One DOM node per section, so we can scroll the current block into view.
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  // Only auto-scroll once (on first load) — not every time a toggle re-renders.
  const didAutoScroll = useRef(false);

  // After the first load, open the page where you last left the floating control:
  // at the time block happening now (default), or at the top — so "now" users land
  // on their current habits, and "top" users start at the beginning of the day.
  useEffect(() => {
    if (didAutoScroll.current || isLoading || chains.length === 0) return;
    // "top" preference: nothing to scroll — the page already loads at the top.
    if (landingPref === "top") {
      didAutoScroll.current = true;
      return;
    }
    // "Now" only means anything on today's view.
    if (!isViewingToday || nowBlockId == null) return;
    const el = sectionRefs.current[String(nowBlockId)];
    if (el) {
      el.scrollIntoView({ block: "start" });
      didAutoScroll.current = true;
    }
  }, [chains, isLoading, nowBlockId, isViewingToday, landingPref]);

  // Re-center on the current time block (the "Now" button).
  function scrollToNow() {
    if (nowBlockId == null) return;
    sectionRefs.current[String(nowBlockId)]?.scrollIntoView({
      block: "start",
      behavior: "smooth",
    });
  }

  // Where the "now" block currently sits in the viewport (its top offset), or null
  // — the floating controls read it to decide whether to show the "jump to now"
  // hint.
  function getNowTop(): number | null {
    if (nowBlockId == null) return null;
    return (
      sectionRefs.current[String(nowBlockId)]?.getBoundingClientRect().top ??
      null
    );
  }

  return { sectionRefs, scrollToNow, getNowTop };
}
