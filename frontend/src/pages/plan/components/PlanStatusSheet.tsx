import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { ReadStatus } from "../types";
import { NoteIcon } from "../../../components/icons";

// The tap menu for a Plan-page habit slot: Skip / Complete / Miss in a row (plus
// Clear when a status is set), a note icon top-right, and the habit name as a
// link to its Details page. Portaled so the card's drag transforms can't clip
// it; a stopPropagation at the root keeps a click inside from bubbling back to
// the card and re-opening the menu.
export function PlanStatusSheet({
  open,
  title,
  current,
  hasNotes,
  onPick,
  onNote,
  onDetails,
  onClose,
}: {
  open: boolean;
  title: string;
  current: ReadStatus;
  hasNotes: boolean;
  onPick: (action: "COMPLETE" | "SKIP" | "MISS" | "CLEAR") => void;
  onNote: () => void;
  onDetails: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // The three primary statuses, shown side-by-side. Clear (back to pending) is
  // rendered separately below, and only when a status is actually set.
  const statuses: {
    action: "SKIP" | "COMPLETE" | "MISS";
    status: ReadStatus;
    label: string;
    className: string;
    ring: string;
  }[] = [
    {
      action: "SKIP",
      status: "SKIPPED",
      label: "Skip",
      className: "bg-stone-100 text-stone-600 hover:bg-stone-200",
      ring: "ring-stone-400",
    },
    {
      action: "COMPLETE",
      status: "COMPLETED",
      label: "Complete",
      className: "bg-calm-600 text-white hover:bg-calm-700",
      ring: "ring-calm-700",
    },
    {
      action: "MISS",
      status: "MISSED",
      label: "Miss",
      className: "bg-rose-50 text-rose-600 hover:bg-rose-100",
      ring: "ring-rose-400",
    },
  ];

  return createPortal(
    <div
      onClick={(e) => e.stopPropagation()}
      className="fixed inset-0 z-50 flex flex-col items-center justify-end gap-2 p-3 sm:justify-center"
    >
      <div
        className="animate-backdrop-in absolute inset-0 bg-ink/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />

      {/* The sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Actions for ${title}`}
        className="animate-sheet-in relative w-full max-w-sm rounded-3xl border border-mist bg-white p-4 shadow-[0_18px_44px_rgba(27,46,42,0.18)]"
      >
        {/* Grab-handle pill — reads as a bottom sheet on the phone. */}
        <div
          className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-mist"
          aria-hidden
        />

        {/* Header: the note icon gets its OWN row in the top-right, above the
          name; the habit name (centered, with a chevron) opens its page on tap. */}
        <div className="mb-8">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onNote}
              aria-label={hasNotes ? "Edit notes" : "Add note"}
              className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                hasNotes
                  ? "bg-calm-50 text-calm-600 hover:bg-calm-100"
                  : "text-calm-400 hover:bg-calm-50 hover:text-calm-600"
              }`}
            >
              <NoteIcon />
            </button>
          </div>
          <button
            type="button"
            onClick={onDetails}
            className="group -mt-1 flex w-full items-center justify-center gap-1 px-4"
          >
            <span className="min-w-0 truncate text-lg font-semibold text-calm-900 group-hover:text-calm-700">
              {title}
            </span>
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              className="h-4 w-4 shrink-0 text-calm-400 group-hover:text-calm-600"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 5l7 7-7 7"
              />
            </svg>
          </button>
        </div>

        {/* Skip / Complete / Miss, side by side. The current status keeps a ring. */}
        <div className="flex gap-2">
          {statuses.map((o) => (
            <button
              key={o.action}
              type="button"
              onClick={() => onPick(o.action)}
              className={`flex flex-1 items-center justify-center rounded-2xl py-3.5 text-sm font-semibold transition active:scale-[0.97] ${
                o.className
              } ${current === o.status ? `ring-2 ring-offset-2 ring-offset-white ${o.ring}` : ""}`}
            >
              {o.label}
            </button>
          ))}
        </div>

        {/* Clear back to pending — only when a status is actually set. */}
        {current !== "PENDING" && (
          <button
            type="button"
            onClick={() => onPick("CLEAR")}
            className="mt-2 w-full rounded-xl py-2.5 text-sm font-medium text-calm-500 transition-colors hover:bg-calm-50"
          >
            Clear
          </button>
        )}
      </div>

      {/* Cancel — its own card, iOS action-sheet style. */}
      <button
        type="button"
        onClick={onClose}
        className="relative w-full max-w-sm rounded-2xl border border-mist bg-white py-3.5 text-sm font-semibold text-stone-500 shadow-[0_18px_44px_rgba(27,46,42,0.18)] transition hover:text-stone-700 active:scale-[0.98]"
      >
        Cancel
      </button>
    </div>,
    document.body,
  );
}
