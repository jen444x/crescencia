import { useEffect, useRef, useState } from "react";
import { DAY_TIERS } from "../tier";

// Filled star (duplicated from PlanPage's card icon — a tiny self-contained svg,
// so the toolbar doesn't pull in a shared icons module).
function StarIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-4 w-4"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M9.05 2.93c.3-.92 1.6-.92 1.9 0l1.42 4.38a1 1 0 00.95.69h4.6c.97 0 1.37 1.24.59 1.81l-3.73 2.71a1 1 0 00-.36 1.12l1.42 4.38c.3.92-.75 1.69-1.54 1.12l-3.72-2.71a1 1 0 00-1.18 0l-3.72 2.71c-.79.57-1.84-.2-1.54-1.12l1.42-4.38a1 1 0 00-.36-1.12L1.48 9.81c-.78-.57-.38-1.81.59-1.81h4.6a1 1 0 00.95-.69L9.05 2.93z" />
    </svg>
  );
}

function EllipsisIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

// The compact controls above the plan. Replaces the old row of bare ALL-CAPS text
// links. Three groups: a day-tier dropdown (scales to any number of tiers), a
// "main only" star toggle (hide helper habits), and a "⋯" menu for the rare
// day-level actions.
export default function PlanToolbar({
  dayTier,
  onTierChange,
  mainOnly,
  onToggleMainOnly,
  onNewRoutine,
  showResetOrder,
  onResetOrder,
  showResetDay,
  showSkipDay,
  onSkipDay,
  onResetDay,
}: {
  dayTier: number;
  onTierChange: (level: number) => void;
  mainOnly: boolean;
  onToggleMainOnly: () => void;
  onNewRoutine: () => void;
  // Only today is reorderable, and only once something has actually moved — so the
  // "Reset order" item only appears then.
  showResetOrder: boolean;
  onResetOrder: () => void;
  // "Reset day" and "Skip day" are no longer mutually exclusive. "Reset day"
  // shows whenever there's something to undo (a full skip OR a per-day
  // rearrangement); "Skip day" shows whenever the day isn't already fully
  // skipped. So a rearranged-but-not-skipped day shows BOTH.
  showResetDay: boolean;
  showSkipDay: boolean;
  onSkipDay: () => void;
  onResetDay: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the menu on Escape or a click outside it (same idiom as ConfirmDialog
  // and the ShiftControl popover elsewhere in the page).
  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [menuOpen]);

  // Run a menu action and close the menu.
  const act = (fn: () => void) => {
    setMenuOpen(false);
    fn();
  };

  const itemClass =
    "flex w-full items-center px-3 py-2 text-left text-sm text-sage-700 transition-colors hover:bg-sage-50";

  return (
    <div className="-mt-1 mb-3 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        {/* Day-tier: Roots = the hard/minimum day, Growth = the everyday bar,
            Flourish = a best day. Sets which rung every tiered habit shows + logs
            at. The chip wears its tier's color — earthy stone for Roots, sage for
            Growth, lavender (the bloom) for Flourish — so the day's level reads at
            a glance. A dropdown (not a toggle) so DAY_TIERS can keep growing. */}
        <select
          value={dayTier}
          onChange={(e) => onTierChange(Number(e.target.value))}
          aria-label="Day tier"
          className={`cursor-pointer rounded-full border px-3 py-1 text-xs font-medium transition-colors focus:outline-none ${
            dayTier === 1
              ? "border-stone-300 bg-stone-100 text-stone-700"
              : dayTier >= 3
                ? "border-lavender-300 bg-lavender-100 text-lavender-800"
                : "border-sage-300 bg-sage-100 text-sage-800"
          }`}
        >
          {DAY_TIERS.map((t) => (
            <option key={t.level} value={t.level}>
              {t.name}
            </option>
          ))}
        </select>

        {/* "Main only": hide the helper/support habits, leaving just the main
            ones she cares about — for a low-energy day. Pure view filter —
            toggles instantly, persists. */}
        <button
          type="button"
          onClick={onToggleMainOnly}
          aria-pressed={mainOnly}
          aria-label="Show main habits only (hide helpers)"
          title="Main only"
          className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
            mainOnly
              ? "bg-honey-100 text-honey-600"
              : "text-sage-300 hover:bg-sage-50 hover:text-sage-500"
          }`}
        >
          <StarIcon />
        </button>
      </div>

      {/* Rare day-level actions, tucked behind a "⋯" so they don't crowd the bar. */}
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="More actions"
          className="flex h-8 w-8 items-center justify-center rounded-full text-sage-400 transition-colors hover:bg-sage-50 hover:text-sage-600"
        >
          <EllipsisIcon />
        </button>
        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 z-30 mt-1 w-44 overflow-hidden rounded-xl border border-sage-100 bg-white py-1 shadow-lg"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => act(onNewRoutine)}
              className={itemClass}
            >
              New routine
            </button>
            {showResetOrder && (
              <button
                type="button"
                role="menuitem"
                onClick={() => act(onResetOrder)}
                className={itemClass}
              >
                Reset order
              </button>
            )}
            {showResetDay && (
              <button
                type="button"
                role="menuitem"
                onClick={() => act(onResetDay)}
                className={itemClass}
              >
                Reset day
              </button>
            )}
            {showSkipDay && (
              <button
                type="button"
                role="menuitem"
                onClick={() => act(onSkipDay)}
                className="flex w-full items-center px-3 py-2 text-left text-sm text-clay-500 transition-colors hover:bg-clay-100"
              >
                Skip day
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
