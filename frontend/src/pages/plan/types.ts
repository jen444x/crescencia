// Shared types for the Plan page and its sub-components. Extracted from
// PlanPage.tsx so the tier logic and toolbar can import them without a cycle
// (this module has no runtime code, so nothing can import back into it).

// The statuses we can WRITE for a day. Matches the backend's HabitLog.Status.
export type HabitStatus = "PENDING" | "COMPLETED" | "SKIPPED";
// What the server can REPORT: adds MISSED — a derived, read-only state the
// backend returns for a *past* day's untouched habit. We render it but never
// send it (the log endpoint only accepts the three writable statuses above).
export type ReadStatus = HabitStatus | "MISSED";

export type Plan = {
  // null for the "Anytime" group (habits with no schedule) — that group
  // can't be reordered.
  id: number | null;
  time: string | null;
  habits: Habit[];
};
export type Habit = {
  id: number;
  // The Schedule row that holds this habit's position (order + chain).
  // It's what we send to /schedules/reorder/ when the habit is dragged.
  schedule_id?: number | null;
  name: string;
  chain?: number | null;
  // The Routine (group) this habit belongs to + its display name, for the
  // collapsible block on the Plan page. null when the habit isn't grouped.
  // Independent of `chain`: a habit can be in a routine, a chain, both, or neither.
  routine?: number | null;
  routine_name?: string | null;
  order?: number;
  // The day's status from the backend. `done_today` is the convenience boolean
  // (status === "COMPLETED"); we keep both since the API sends both. Can be
  // "MISSED" on past days, which we render but never send back.
  status?: ReadStatus;
  done_today?: boolean;
  // LEGACY: that day's free-text note (HabitLog.notes), "" when none. Superseded
  // by the new Note model (`dayNotes` below); kept as a fallback while the
  // /days/notes/ endpoint rolls out. Per-DAY, distinct from the habit's own
  // permanent `notes` edited on the habit page.
  notes?: string;
  // That day's notes from the new Note model, attached client-side from
  // /days/notes/ (see notesByHabit). A shared note appears on each of its habits.
  dayNotes?: DayNote[];
  // True marks a SUPPORT/helper habit (scaffolding for a main habit), vs a main
  // habit she cares about. Drives the "Main only" filter; tracking is unchanged.
  is_support?: boolean;
  // This row is ONE tier-slot of a habit (a habit can have several at different
  // times). Backend derives status/done_today per slot.
  // tier != null  -> Case A: this row IS that tier-slot, at its own time. Show
  //                  tier_name + tier_value; complete sends `tier`.
  // tier == null + tiers non-empty -> Case B: a single same-time slot that carries
  //                  the habit's whole ladder; the row shows the value for the
  //                  highest tier <= dayTier and completes at that level.
  // tier == null + tiers empty -> untiered: a plain card, no tier sent.
  tier?: number | null;        // 1=Roots, 2=Growth; null = untiered OR Case B
  tier_name?: string | null;
  tier_value?: string | null;  // Case A only: this slot's value, e.g. "7:30"
  // The habit's full tier list (every level it has). [] = untiered. Used to look
  // up a value by level (Case A fallback) and to drive Case B's rung + stretch.
  tiers?: { level: number; name: string; value: string }[];
  achieved_tier?: number | null;
};

// A per-day note from the new Note model (GET /days/notes/). Unlike the legacy
// `Habit.notes` string, it has its own id, can carry several habits, and can be
// shared across them (`shared` === habits.length > 1).
export type DayNote = {
  id: number;
  body: string;
  date: string;
  habits: number[];
  shared: boolean;
  created_at: string;
  updated_at: string;
};

export type SlotPlacement = "inline" | "stretch" | "hidden";

// A row to render for one habit. `stepNumber` is its position within a chain
// (1, 2, 3...) or null if it's a standalone habit. `connectBelow` draws the
// little connector line down to the next step when they're in the same chain.
export type Row = {
  habit: Habit;
  stepNumber: number | null;
  connectBelow: boolean;
};

// A time block renders as an ordered list of segments, IN PLACE (display order):
//   - "active":  a single not-yet-completed habit
//   - "done":    a RUN of consecutive completed habits, collapsed into one chip
//   - "routine": a RUN of consecutive habits sharing a routine, shown as one
//     collapsible block — so a routine stays put inside its cycle (e.g. between
//     "shower" and "lotion") instead of being lifted out of the order.
// A routine counts as ONE step in its chain, so step numbers stay sensible
// (shower 1 · morning routine 2 · lotion 3), and completed routine members stay
// in their block rather than collapsing into the "done" chip.
export type Segment =
  | { kind: "active"; row: Row }
  | { kind: "done"; key: string; habits: Habit[] }
  | {
      kind: "routine";
      key: string;
      routineId: number;
      name: string;
      stepNumber: number | null;
      connectBelow: boolean;
      habits: Habit[];
    };
