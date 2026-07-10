import AspirationDots from "../../../components/AspirationDots";
import {
  rowDisplayValue,
  caseBDisplayLevel,
  isCaseB,
  rowCompleteTier,
  slotStatus,
  tagChipClasses,
} from "../tier";
import { DashIcon, XIcon, CheckIcon } from "../../../components/icons";
import type { Habit, HabitStatus } from "../types";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { applyStatusAction } from "../status";
import { PlanStatusSheet } from "./PlanStatusSheet";

export function HabitCard({
  habit,
  dayTier,
  completeTier,
  onStatus,
  onOpenNote,
  handle,
}: {
  habit: Habit;
  // The day's chosen tier, so this card can compute its own display value
  // (Case A: its own value; Case B: the value of the highest rung <= dayTier).
  dayTier: number;
  // The tier level this card's check should send, overriding the dayTier-derived
  // one. Used by a stretch card so its check completes ITS (harder) rung, not the
  // habit's "today" rung. undefined -> derive from the row + dayTier.
  completeTier?: number;
  onStatus: (habitId: number, status: HabitStatus, tier?: number) => void;
  // Open the per-day note editor for this habit.
  onOpenNote: (habit: Habit) => void;
  // Optional drag handle (a grip), rendered at the left inside the card.
  handle?: ReactNode;
}) {
  // This card is one tier-slot of a habit. When it carries a tier value (e.g.
  // "7:30" / "11am" / "5 min") we append it after the name so the slot reads as
  // "Wake up · 7:30"; an untiered slot has none and renders exactly as before.
  // A stretch card is pinned to one rung (completeTier), so it shows that rung's
  // value; otherwise the value follows the case + dayTier.
  // The rung this card SHOWS and acts on. A stretch card pins an explicit
  // completeTier. A Case-B inline card (no override) shows the habit's CURRENT
  // achievement — the highest done rung once you've reached today's, else today's
  // target rung — so after you do Growth it reads "· 12:30am" and undo steps it
  // back down. Case A uses its own tier; untiered: none.
  const caseBInline = completeTier == null && isCaseB(habit);
  const tierToSend =
    completeTier ??
    (caseBInline
      ? (caseBDisplayLevel(habit, dayTier) ?? undefined)
      : rowCompleteTier(habit, dayTier));
  const tierValue =
    tierToSend != null
      ? (habit.tiers?.find((t) => t.level === tierToSend)?.value ??
        habit.tier_value ??
        null)
      : rowDisplayValue(habit, dayTier);
  // Per-version state: this card shows ITS rung's status (cascade already folded
  // in by the backend), so completing the easy version never ticks the harder one.
  const cardStatus = slotStatus(habit, tierToSend);
  const done = cardStatus === "COMPLETED";
  const skipped = cardStatus === "SKIPPED";
  const missed = cardStatus === "MISSED";
  // Notes come from the new Note model; fall back to the legacy per-habit string
  // while /days/notes/ rolls out. `hasNotes` drives the note button's accent
  // (the notes themselves are viewed on the habit detail page).
  const dayNotes = habit.dayNotes ?? [];
  const legacyNote = habit.notes?.trim() ?? "";
  const hasNotes = dayNotes.length > 0 || legacyNote !== "";

  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  // "Other versions": an INLINE tiered card (not a stretch card, which is
  // already pinned to one rung) can unfold the habit's other rungs as compact
  // sub-rows, so a rung the day-tier hides (e.g. Roots on a Growth day) can be
  // acted on without switching the whole day's tier. Mirrors the Habits page.
  const [expanded, setExpanded] = useState(false);
  const [subMenuLevel, setSubMenuLevel] = useState<number | null>(null);
  const otherTiers =
    completeTier == null
      ? (habit.tiers ?? []).filter((t) => t.level !== tierToSend)
      : [];
  const canExpand = otherTiers.length > 0;
  const subTier =
    subMenuLevel == null
      ? null
      : (habit.tiers?.find((t) => t.level === subMenuLevel) ?? null);

  return (
    <div
      // A tap anywhere on the card opens the status menu (Complete / Skip / Miss
      // / Clear, plus note + Details). The grip and dot carry data-no-swipe +
      // their own stopPropagation, so they keep doing their own thing.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-no-swipe]")) return;
        setMenuOpen(true);
      }}
      className={`group flex select-none flex-col rounded-[18px] border border-mist px-4 py-3 shadow-[0_1px_2px_rgba(27,46,42,0.04)] hover:shadow-md transition-shadow cursor-pointer ${
        done
          ? "bg-whisper"
          : skipped
            ? "bg-stone-50"
            : missed
              ? "bg-rose-50"
              : "bg-white"
      }`}
    >
      <div className="flex items-center gap-3">
        {handle}
        {/* The name is a plain heading again, so a normal tap bubbles up and opens
          the habit detail page. A tier-slot appends its value (e.g. "· 7:30") in
          a lighter span, dimmed further once the slot is done. */}
        <div className="min-w-0 flex-1">
          <h3
            className={`wrap-break-word font-medium ${
              done
                ? "text-calm-400 line-through"
                : skipped
                  ? "text-stone-400"
                  : missed
                    ? "text-rose-400"
                    : "text-calm-900"
            }`}
          >
            {habit.name}
            {tierValue && (
              <span
                className={`font-normal ${
                  done ? "text-calm-300" : "text-stone-400"
                }`}
              >
                {" · "}
                {tierValue}
              </span>
            )}
            <AspirationDots
              aspirations={habit.aspirations}
              className={`ml-1.5 ${done || skipped || missed ? "opacity-40" : ""}`}
            />
          </h3>
        </div>

        {/* Chevron: unfold this habit's other versions (see otherTiers above). */}
        {canExpand && (
          <button
            type="button"
            data-no-swipe
            aria-expanded={expanded}
            aria-label={expanded ? "Hide other versions" : "Show all versions"}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="-m-1 shrink-0 p-1 text-calm-300 transition-colors hover:text-calm-500"
          >
            <svg
              className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
        )}

        {/* Status dot: shows the slot's state (✓ done · – skipped · ✗ missed),
          and a one-tap toggles Complete / undo. Skip / Miss / Clear / note /
          Details all live in the tap menu. */}
        <button
          type="button"
          data-no-swipe
          aria-label={done ? "Mark as not done today" : "Mark as done today"}
          aria-pressed={done}
          onClick={(e) => {
            e.stopPropagation();
            applyStatusAction(
              habit,
              tierToSend,
              done ? "CLEAR" : "COMPLETE",
              done,
              onStatus,
            );
          }}
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition active:scale-90 ${
            done
              ? "border-calm-600 bg-calm-600 text-white"
              : skipped
                ? "border-stone-400 bg-stone-400 text-white"
                : missed
                  ? "border-rose-400 bg-rose-400 text-white"
                  : "border-calm-300 text-transparent hover:border-calm-500"
          }`}
        >
          {skipped ? <DashIcon /> : missed ? <XIcon /> : <CheckIcon />}
        </button>
      </div>

      {/* The unfolded versions: one compact sub-row per OTHER rung — tier chip
          (Roots wears clay, Growth leaf) + value + its own status ring. A tap
          on the sub-row opens the status menu FOR THAT RUNG, so e.g. Roots can
          be completed on a Growth day without touching the day tier. */}
      {expanded &&
        otherTiers.map((t) => {
          const st = slotStatus(habit, t.level);
          const subDone = st === "COMPLETED";
          const subSkipped = st === "SKIPPED";
          const subMissed = st === "MISSED";
          return (
            <div
              key={t.level}
              data-no-swipe
              onClick={(e) => {
                e.stopPropagation();
                setSubMenuLevel(t.level);
              }}
              className="mt-2.5 flex items-center gap-2.5 border-t border-whisper pt-2.5"
            >
              {t.name && (
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${tagChipClasses(t.label)}`}
                >
                  {t.name}
                </span>
              )}
              <span
                className={`min-w-0 flex-1 truncate text-sm ${
                  subDone
                    ? "text-calm-400 line-through"
                    : subSkipped
                      ? "text-stone-400"
                      : subMissed
                        ? "text-rose-400"
                        : "text-stone-500"
                }`}
              >
                {t.value || habit.name}
              </span>
              <button
                type="button"
                aria-label={
                  subDone
                    ? `Mark ${t.name} as not done`
                    : `Mark ${t.name} as done`
                }
                aria-pressed={subDone}
                onClick={(e) => {
                  e.stopPropagation();
                  onStatus(
                    habit.id,
                    subDone ? "PENDING" : "COMPLETED",
                    t.version,
                  );
                }}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition active:scale-90 ${
                  subDone
                    ? "border-calm-600 bg-calm-600 text-white"
                    : subSkipped
                      ? "border-stone-400 bg-stone-400 text-white"
                      : subMissed
                        ? "border-rose-400 bg-rose-400 text-white"
                        : "border-calm-300 text-transparent hover:border-calm-500"
                }`}
              >
                {subSkipped ? (
                  <DashIcon />
                ) : subMissed ? (
                  <XIcon />
                ) : (
                  <CheckIcon />
                )}
              </button>
            </div>
          );
        })}

      <PlanStatusSheet
        open={menuOpen}
        title={habit.name}
        current={cardStatus}
        hasNotes={hasNotes}
        onPick={(action) => {
          applyStatusAction(habit, tierToSend, action, done, onStatus);
          setMenuOpen(false);
        }}
        onNote={() => {
          setMenuOpen(false);
          onOpenNote(habit);
        }}
        onDetails={() => {
          setMenuOpen(false);
          navigate(`/habits/${habit.id}`);
        }}
        onClose={() => setMenuOpen(false)}
      />

      {/* The status menu for an unfolded sub-row — same sheet, pinned to that
          rung's level. Plain per-level actions (no Case-B cascade/step-down):
          the backend folds the higher-completes-lower cascade on its own. */}
      {subTier && (
        <PlanStatusSheet
          open
          title={`${habit.name} · ${subTier.name}`}
          current={slotStatus(habit, subTier.level)}
          hasNotes={hasNotes}
          onPick={(action) => {
            const status: HabitStatus =
              action === "COMPLETE"
                ? "COMPLETED"
                : action === "SKIP"
                  ? "SKIPPED"
                  : action === "MISS"
                    ? "MISSED"
                    : "PENDING";
            onStatus(habit.id, status, subTier.version);
            setSubMenuLevel(null);
          }}
          onNote={() => {
            setSubMenuLevel(null);
            onOpenNote(habit);
          }}
          onDetails={() => {
            setSubMenuLevel(null);
            navigate(`/habits/${habit.id}`);
          }}
          onClose={() => setSubMenuLevel(null)}
        />
      )}
    </div>
  );
}

// PlanStatusSheet moved to ./PlanStatusSheet — imported at the top of this file.
