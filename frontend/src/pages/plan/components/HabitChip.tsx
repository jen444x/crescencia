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
import { Fragment, useState } from "react";
import { useNavigate } from "react-router-dom";
import { applyStatusAction } from "../status";
import { PlanStatusSheet } from "./PlanStatusSheet";

// The compact "chip" form of a habit: a boxed run of INLINE text, so the boxes
// flow like words filling a line and a long habit BREAKS across the line (starts
// after the previous one, finishes on the next line) with the next habit
// continuing after it. Same functionality as HabitCard, just laid out inline:
//   • the dot quick-completes / undoes,
//   • a tap opens the status menu (Complete / Skip / Miss / Clear + note + Details),
//   • the chevron unfolds the habit's OTHER tier versions — rendered as small
//     dashed boxes right after this one, each tappable for its own status menu,
//   • aspiration bloom dots show in color.
// It just drops the drag handle (Rows is the view for arranging).
export function HabitChip({
  habit,
  dayTier,
  onStatus,
  onOpenNote,
}: {
  habit: Habit;
  // The day's chosen tier, so the chip picks the same rung an inline card would.
  dayTier: number;
  onStatus: (habitId: number, status: HabitStatus, tier?: number) => void;
  onOpenNote: (habit: Habit) => void;
}) {
  // Same rung selection as an inline HabitCard, kept in lockstep so a tap acts on
  // the same version in either layout.
  const caseBInline = isCaseB(habit);
  const tierToSend = caseBInline
    ? (caseBDisplayLevel(habit, dayTier) ?? undefined)
    : rowCompleteTier(habit, dayTier);
  const tierValue =
    tierToSend != null
      ? (habit.tiers?.find((t) => t.level === tierToSend)?.value ??
        habit.tier_value ??
        null)
      : rowDisplayValue(habit, dayTier);
  const cardStatus = slotStatus(habit, tierToSend);
  const done = cardStatus === "COMPLETED";
  const skipped = cardStatus === "SKIPPED";
  const missed = cardStatus === "MISSED";

  const dayNotes = habit.dayNotes ?? [];
  const legacyNote = habit.notes?.trim() ?? "";
  const hasNotes = dayNotes.length > 0 || legacyNote !== "";

  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  // "Other versions": the habit's rungs other than the one shown, unfolded inline
  // as dashed boxes after this one (mirrors HabitCard's expander).
  const [expanded, setExpanded] = useState(false);
  const [subMenuLevel, setSubMenuLevel] = useState<number | null>(null);
  const otherTiers = (habit.tiers ?? []).filter((t) => t.level !== tierToSend);
  const canExpand = otherTiers.length > 0;
  const subTier =
    subMenuLevel == null
      ? null
      : (habit.tiers?.find((t) => t.level === subMenuLevel) ?? null);

  // A HIGHLIGHT, not an outlined box: a flat fill so each habit reads as a
  // highlighted word. Active is white (flat, no shadow); done/skip/miss keep their
  // soft tints.
  const boxTone = done
    ? "bg-mint text-calm-400 line-through"
    : skipped
      ? "bg-stone-100 text-stone-400 line-through"
      : missed
        ? "bg-rose-50 text-rose-400 line-through"
        : "bg-white text-calm-900 hover:bg-calm-50";

  return (
    <>
      <span
        // A tap anywhere but the dot / chevron opens the status menu.
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("[data-no-swipe]")) return;
          setMenuOpen(true);
        }}
        // Inline (not inline-flex) so it flows and breaks across lines like text.
        // box-decoration-clone redraws the fill + rounded corners on EACH line
        // fragment, so a wrapped habit reads as clean rounded highlights, not a
        // cut-open box. mr-1 pairs with the whitespace so the gap between boxes
        // roughly matches the gap between wrapped lines (an even mesh).
        className={`box-decoration-clone mr-1 cursor-pointer rounded-md px-2 py-1 font-medium transition-colors ${boxTone}`}
      >
        {/* Quick-complete dot: one tap completes / undoes, same as the card. */}
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
          className={`mr-1.5 inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border align-middle transition active:scale-90 ${
            done
              ? "border-calm-600 bg-calm-600 text-white"
              : skipped
                ? "border-stone-400 bg-stone-400 text-white"
                : missed
                  ? "border-rose-400 bg-rose-400 text-white"
                  : "border-calm-500 bg-white text-transparent hover:border-calm-600"
          }`}
        >
          {skipped ? <DashIcon /> : missed ? <XIcon /> : <CheckIcon />}
        </button>

        {habit.name}
        {tierValue && (
          <span
            className={`font-normal ${done ? "text-calm-300" : "text-stone-400"}`}
          >
            {" · "}
            {tierValue}
          </span>
        )}
        <AspirationDots
          ids={habit.aspirations}
          className={`ml-1 ${done || skipped || missed ? "opacity-40" : ""}`}
        />

        {/* Chevron: unfold this habit's other versions (see below). */}
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
            className="ml-1 inline-flex align-middle text-calm-600 transition-colors hover:text-calm-700"
          >
            <svg
              className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        )}
      </span>

      {/* Other versions, unfolded inline right after this habit: one small dashed
          box per rung (tier chip + value), each tappable for ITS status menu. */}
      {expanded &&
        otherTiers.map((t) => {
          const st = slotStatus(habit, t.level);
          const subDone = st === "COMPLETED";
          const subSkipped = st === "SKIPPED";
          const subMissed = st === "MISSED";
          return (
            <Fragment key={t.level}>
              {" "}
              <span
                onClick={() => setSubMenuLevel(t.level)}
                className={`box-decoration-clone mr-1 cursor-pointer rounded-md px-2 py-1 transition-colors ${
                  subDone
                    ? "bg-mint text-calm-400 line-through"
                    : subSkipped
                      ? "bg-stone-100 text-stone-400 line-through"
                      : subMissed
                        ? "bg-rose-50 text-rose-400 line-through"
                        : "bg-white text-stone-600 hover:bg-calm-50"
                }`}
              >
                {t.name && (
                  <span
                    className={`mr-1.5 rounded-full px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase tracking-wider ${tagChipClasses(t.label)}`}
                  >
                    {t.name}
                  </span>
                )}
                {t.value || habit.name}
              </span>
            </Fragment>
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

      {/* Status menu for an unfolded version — pinned to that rung's level. */}
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
    </>
  );
}
