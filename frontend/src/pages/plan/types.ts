// Shared types for the Plan page and its sub-components. Extracted from
// PlanPage.tsx so the tier logic and toolbar can import them without a cycle
// (this module has no runtime code, so nothing can import back into it).

// The statuses we can write/read for a day. Matches the backend's
// HabitLog.Status. MISSED is now BOTH settable (mark "I didn't do it" in the
// moment, so a version closes off the list) and derived (the backend still
// returns it for a past day's untouched habit). ReadStatus is kept as an alias
// so existing references compile; the two are the same set now.
export type HabitStatus = "PENDING" | "COMPLETED" | "SKIPPED" | "MISSED";
export type ReadStatus = HabitStatus;

export type Chain = {
  // null for the "Anytime" group (habits with no schedule) — that group
  // can't be reordered.
  id: number | null;
  time: string | null;
  // The chain's optional user-given name. "" (or absent) when unnamed — the
  // block header then falls back to chainLabel(). Only timed blocks can be
  // named; the "Anytime" group (id == null) always reports "".
  name?: string;
  habits: Habit[];
};
export type Habit = {
  id: number;
  // The Schedule row that holds this habit's position (order) on the
  // recurring template. It's what we send to /schedules/reorder/ for the
  // explicit "edit my recurring plan" action. NULL on a frozen day — that row is
  // a ScheduleDay copy, not a template row — so never key dnd on this.
  schedule_id?: number | null;
  // The STABLE per-row key for dnd + optimistic updates: the Schedule id on an
  // unfrozen day, the ScheduleDay id once the day is frozen. Survives the
  // template->frozen flip mid-session (schedule_id does not), so all drag ids,
  // SortableContext items, and optimistic order/move logic key on this. It's
  // also the `id` we send to /days/arrange/ for an existing row.
  row_id?: number | null;
  name: string;
  // The Routine (group) this habit belongs to + its display name, for the
  // collapsible block on the Plan page. null when the habit isn't grouped.
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
  // "TASK" = furniture: a fixed commitment ("Standup") that's on the plan only so
  // the day's shape is visible and habits can be arranged around it. It is NEVER
  // completed — the backend pins its status to PENDING and refuses to log it — so
  // a task row must draw no tick control. NOTE: the Plan page does not honour this
  // yet (its board is mid-refactor); the Habits page does.
  kind?: "HABIT" | "TASK";
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
  // The habit's full tier list (every level it has), each with TODAY's per-version
  // state. [] = untiered. `status`/`done` are per version: completing a LOWER one
  // never closes a HIGHER one, and the backend has already folded the
  // higher-completes-lower cascade into these, so a card just reads its own
  // version here. Used to drive each rung's done/skip/missed and Case B's rung.
  tiers?: {
    level: number;               // per-habit ladder position (1..N); cascade order
    name: string;                // the tag's display ("Roots"/"Growth"), "" if untagged
    label?: number | null;       // the tag level (1=Roots, 2=Growth), null = untagged
    value: string;
    version?: number;            // the rung's id — what a completion/log keys on
    target_time?: string | null; // "HH:MM" deadline — slot completion acts on it
    duration?: string | null;    // how long, in her words ("10 mins")
    status?: ReadStatus;
    done?: boolean;
  }[];
  // Aspirations this habit serves ({id, color}) — rendered as bloom dots in
  // each aspiration's chosen (or id-default) color next to the name.
  aspirations?: { id: number; color?: number | null }[];
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
//     collapsible block — so a routine stays put inside its chain (e.g. between
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
