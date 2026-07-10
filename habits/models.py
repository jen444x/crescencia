from datetime import date

from django.db import models

# The fixed early sentinel every existing/base placement is stamped with: "this
# has always been the plan." A single base generation at this date reproduces
# today's behavior (see Schedule.valid_from / ChainTime).
BASE_VALID_FROM = date(1970, 1, 1)

class Area(models.Model):
    name = models.CharField(max_length=50) # length of name

    def __str__(self):
        return self.name    # return string representation of the name attribute

class Aspiration(models.Model):
    """A directional intent that habits work toward — "Move more", "Walk more",
    "Sleep better". It's the *why* above a habit: fuzzy and goal-shaped on
    purpose. The concrete amount ("5000 steps") isn't stored here — that lives on
    the habit's tier value. Habits are attached via `habits` (M2M) to show what
    it's made of.
    """
    name = models.CharField(max_length=200)        # the aspiration itself: "Move more"
    reason = models.TextField(blank=True)          # why you want it
    motivation = models.TextField(blank=True)      # what keeps you going
    notes = models.TextField(blank=True)
    # Chosen bloom color, as an index (0-5) into the frontend BLOOMS palette.
    # null = use the id-based default (id % 6), so existing beds keep the color
    # they had until the user picks one.
    color = models.PositiveSmallIntegerField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    # An optional deadline that turns a directional aspiration into a dated GOAL
    # ("get ready for the move by Aug 5"). null = open-ended/forever — the default,
    # and what every aspiration was until now. When set, the detail page shows a
    # countdown and a completion heatmap over the window [created_at, target_date].
    target_date = models.DateField(null=True, blank=True)
    # The habits that serve this aspiration. Many-to-many: one habit can support
    # several aspirations ("walk 5000 steps" feeds both "move more" and "get
    # outside"), and an aspiration is made of several habits. blank=True so an
    # aspiration can exist before any habit is attached. "Habit" is a string ref
    # because that model is defined below this one.
    habits = models.ManyToManyField("Habit", related_name="aspirations", blank=True)

    def __str__(self):
        return self.name

class TierChoices(models.IntegerChoices):
    ROOTS = 1, 'Roots'
    GROWTH = 2, 'Growth'
    FLOURISH = 3, 'Flourish'

class Tier(models.Model):
    # Use the choices list to restrict the numbers allowed in the database
    level = models.IntegerField(
        unique=True, 
        choices=TierChoices.choices,
        default=TierChoices.GROWTH
    ) 

class Habit(models.Model):
    area = models.ForeignKey(Area, on_delete=models.SET_NULL, null=True)
    name = models.CharField(max_length=200) # length of name
    notes = models.TextField(blank=True)
    date_added = models.DateTimeField(auto_now_add=True)
    # True marks a SUPPORT/helper habit — scaffolding that only exists to help
    # complete a main habit (e.g. "lay out clothes", "phone across the room",
    # "get on the mat"). The Habits page hides these by default, so it lists only
    # the main habits she actually cares about — like her old app, which had no
    # helpers. False (default) = a main habit. Helpers still live in the Plan
    # page + chains and are still fully tracked/logged; this is display/filter
    # only. Fixed per habit (her intent), not derived from chain membership.
    is_support = models.BooleanField(default=False)
    # Hand-picked position on the Habits page (drag-to-reorder). null = never
    # placed → those sort last (by name). Distinct from Schedule.order, which is
    # a habit's position WITHIN a time-slot on the Plan page; this orders the
    # flat all-habits list. Set in bulk by reorder_habits.
    order = models.PositiveIntegerField(null=True, blank=True)
    # The day this habit was retired ("stop going forward" — Google Calendar's
    # "this and following"). null = still active. A habit APPLIES on a date when
    # date_added <= date AND (ended_on is null OR ended_on > date) — the symmetric
    # twin of the date_added "didn't exist yet" rule: from its end date forward it
    # drops off the Plan and the Habits page and stops counting as "missed", while
    # every EARLIER day keeps it intact as history (so retiring never rewrites the
    # past). Reversible: clear it (resume_habit) to bring it back. Distinct from a
    # hard delete ("delete forever"), which removes the row and its history.
    ended_on = models.DateField(null=True, blank=True)

    class Meta:
        # Default sort by the related chain's start time
        ordering = ['schedule__chain__start_time', 'schedule__order']

    def __str__(self):
        return f"{self.name}"


class HabitPause(models.Model):
    """One pause window for a habit: it was stopped on `start_date` and, if
    `end_date` is set, resumed on `end_date` (end is EXCLUSIVE — active again ON
    that day). `end_date` null = still paused.

    A habit is OFF the schedule on a date `d` when some window covers it:
    `start_date <= d AND (end_date is null OR d < end_date)`. Keeping the FULL
    history of windows — instead of a single date that gets erased on resume — is
    what makes resume safe: a closed PAST window keeps the habit off those days
    forever, so resuming can never resurrect them as "missed". `Habit.ended_on`
    mirrors the current OPEN window's start as a cheap "is it paused right now"
    flag for the UI; this table is the authoritative date-aware history.
    """
    habit = models.ForeignKey(Habit, on_delete=models.CASCADE, related_name="pauses")
    start_date = models.DateField()
    end_date = models.DateField(null=True, blank=True)   # null = still paused

    class Meta:
        ordering = ['start_date', 'id']

    def __str__(self):
        return f"habit {self.habit_id} paused {self.start_date}–{self.end_date or '…'}"


class Note(models.Model):
    body = models.TextField()
    date = models.DateField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    habits = models.ManyToManyField(Habit, related_name="day_notes")

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.date} - {self.body[:30]}"


class JournalEntry(models.Model):
    """A free-text entry about the day overall (not tied to any habit). Several
    are allowed per day, read as a timeline: morning thought, afternoon update,
    night reflection. `date` is the day it's about; `created_at` orders the
    stream within that day (and lets a backfilled thought land on the right day).
    """
    body = models.TextField()
    date = models.DateField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['date', 'created_at']

    def __str__(self):
        return f"{self.date} - {self.body[:30]}"


class Routine(models.Model):
    """A named group of habits shown as ONE collapsible block on the Plan page
    (e.g. "Morning routine": brush teeth, wash face, ...).

    A routine is an optional tag on a Schedule row — a habit can be in a routine
    or not. It just groups the block's habits under a name, to be done in any
    order, whenever.

    A routine's "done" state is NEVER stored. It's derived from its members'
    HabitLogs: the block reads as done when every member is COMPLETED or SKIPPED
    that day. "Complete the block" is just a fan-out that writes a COMPLETED
    HabitLog for each member (see views.log_routine) — there's no routine log.
    """
    name = models.CharField(max_length=100)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name


class Chain(models.Model):
    start_date = models.DateField(auto_now_add=True)
    start_time = models.TimeField(blank=True, null=True)
    # Optional user-facing name for this time block (the "cycle"). Empty = unnamed,
    # which renders exactly like today (the frontend falls back to its time label).
    # Naming is purely cosmetic — the block is still keyed/grouped by its time.
    name = models.CharField(max_length=100, blank=True, default="")

    class Meta:
        ordering = ['start_time']

    def __str__(self):
        return f"{self.start_time}"

class ChainDay(models.Model):
    """A one-day override of a Chain's time.

    The Chain holds the recurring time (same every day); this records that *on a
    specific date* the routine actually started somewhere else — e.g. you woke
    up late and pushed the morning back. No row for a day = use the Chain's
    normal time. One override per chain per day, so a shift just updates it.
    """
    chain = models.ForeignKey(Chain, on_delete=models.CASCADE)
    date = models.DateField()
    start_time = models.TimeField()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["chain", "date"],
                name="one_time_override_per_plan_per_day",
            )
        ]

    def __str__(self):
        return f"{self.date} - chain {self.chain_id} @ {self.start_time}"

class Schedule(models.Model):
    habit = models.ForeignKey(Habit, on_delete=models.CASCADE)
    chain = models.ForeignKey(Chain, on_delete=models.SET_NULL, null=True)
    # Groups (no order) the habits in a block under a named routine. SET_NULL,
    # not CASCADE: deleting a Routine just ungroups its habits — they stay on the
    # plan as standalone rows — rather than dropping them off the plan.
    routine = models.ForeignKey(Routine, on_delete=models.SET_NULL, null=True, blank=True)
    # Which tier (Roots/Growth) this slot is for. null = the slot isn't
    # tier-specific (an untiered habit). A habit may have MULTIPLE Schedule rows —
    # one per tier that sits at its own time — so "Wake up" can be Growth at 7:30
    # and Roots at 11am. The tier's value/history lives on HabitTier/TierValue;
    # this just places the tier on the timeline.
    tier = models.ForeignKey(Tier, on_delete=models.SET_NULL, null=True, blank=True)
    # The rung this placement is for. Added in P1 (0037) alongside `tier`,
    # backfilled from it by label; the logical slot key becomes (habit, version)
    # in P2. SET_NULL, like `tier` — an unplaced rung just drops off the timeline.
    version = models.ForeignKey("Version", on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    order = models.PositiveIntegerField(null=True, blank=True)
    # The date this placement takes effect. Reads pick the row with the greatest
    # valid_from <= the viewed date; a single base generation reproduces today's
    # behavior.
    valid_from = models.DateField(default=BASE_VALID_FROM)

    # NOTE: "at most one row per (habit, tier, valid_from)" — the rule that makes a
    # forward-write idempotent (re-running UPDATEs the generation, never duplicates
    # it) — is enforced in the writer (views.arrange_forward upserts per slot), not
    # by a DB constraint, to keep this migration purely additive (valid_from only).

    def __str__(self):
        return f"{self.chain.start_time} - {self.habit.name}"


class ChainTime(models.Model):
    """Recurring time change effective from a date forward — the 'this and
    following' twin of ChainDay (one day). NOT read yet (wired in Phase 3)."""
    chain = models.ForeignKey(Chain, on_delete=models.CASCADE)
    valid_from = models.DateField()
    start_time = models.TimeField()

    def __str__(self):
        return f"chain {self.chain_id} from {self.valid_from} @ {self.start_time}"


class ScheduleDay(models.Model):
    """One day's saved arrangement — the per-day twin of `Schedule`.

    `Schedule` is the recurring plan (same every day): which habit sits in which
    block, its routine, its order. `ScheduleDay` records what a *specific date*
    actually looked like, so editing one day never changes the rest — exactly how
    `ChainDay` is the per-day twin of `Chain`'s time.

    No rows for a date = that day isn't frozen yet, so `/plan/` draws it from the
    recurring `Schedule` (today's behaviour, unchanged). The first time a day is
    opened or edited it's "frozen": its current arrangement is copied into
    `ScheduleDay` rows for that date, and from then on the day is read from — and
    edited on — its own copy. That's what makes a past day real history: changing
    your recurring plan later can't rewrite a day that's already frozen.

    `habit_name` is a snapshot so a frozen day still shows what ran even if the
    habit is later deleted (the FK goes null) — history shouldn't rot the way the
    old SET_NULL logs did.
    """
    date = models.DateField()
    habit = models.ForeignKey(Habit, on_delete=models.SET_NULL, null=True)
    habit_name = models.CharField(max_length=200)
    chain = models.ForeignKey(Chain, on_delete=models.SET_NULL, null=True, blank=True)
    routine = models.ForeignKey(Routine, on_delete=models.SET_NULL, null=True, blank=True)
    tier = models.ForeignKey(Tier, on_delete=models.SET_NULL, null=True, blank=True)
    # The rung this frozen slot photographed. Added in P1 (0037) alongside `tier`
    # and backfilled from it; `tier` stays as the live source + cross-check until
    # the P3 cleanup. SET_NULL so deleting a rung never erases a past frozen day.
    version = models.ForeignKey("Version", on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    order = models.PositiveIntegerField(null=True, blank=True)

    class Meta:
        constraints = [
            # Mirror HabitLog's per-version keying: one row per specific version
            # per habit per day, plus one untiered ("whole habit") row. Two
            # constraints because Postgres treats NULLs as distinct.
            models.UniqueConstraint(
                fields=["date", "habit", "tier"],
                condition=models.Q(tier__isnull=False),
                name="one_scheduleday_per_date_habit_tier",
            ),
            models.UniqueConstraint(
                fields=["date", "habit"],
                condition=models.Q(tier__isnull=True),
                name="one_untiered_scheduleday_per_date_habit",
            ),
            # NOTE: the version-keyed twins of these constraints are DEFERRED to
            # P2/P3. They can't coexist with tier-only writers: until P2 flips the
            # writers, a new tiered row has version=null, so a version-null unique
            # would treat two tiered rows on one day as duplicate. They get added
            # once writers set `version`, and replace the tier pair when P3 drops
            # `tier`.
        ]

    def __str__(self):
        return f"{self.date} - {self.habit_name} (#{self.order})"


class HabitLog(models.Model):
    class Status(models.TextChoices):
        PENDING = 'PENDING', 'Pending'
        COMPLETED = 'COMPLETED', 'Completed'
        SKIPPED = 'SKIPPED', 'Skipped'
        # MISSED is ALSO derived at read time for a past PENDING day (see
        # views.MISSED_STATUS). Making it a real, settable status lets her mark
        # "I didn't do it" in the moment, so a version closes off the active list
        # instead of sitting open all day. Skip = intentional/excused; missed =
        # didn't do it. Same string either way, so they render identically.
        MISSED = 'MISSED', 'Missed'

    # One log per (habit, date, VERSION). `tier` IS the version: null = the habit
    # itself — an untiered habit, or a whole-habit action like a blanket skip — and
    # a tier level = that one version. A tiered habit gets one row per tier as each
    # version is acted on, so Root can be COMPLETED while Growth is MISSED on the
    # same day. The old single-row `achieved_tier` high-water-mark is gone; the
    # downward cascade (completing a higher version implies the lower ones) is now
    # derived from these rows at read time (views._version_status).
    habit = models.ForeignKey(Habit, on_delete=models.SET_NULL, null=True)
    date = models.DateField()
    time = models.TimeField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    notes = models.TextField(blank=True)
    tier = models.ForeignKey(Tier, on_delete=models.SET_NULL, null=True, blank=True)
    # The rung this log records. Added in P1 (0037) alongside `tier` and backfilled
    # from it (map by label, since a version's level is renumbered per-habit).
    # SET_NULL — deleting a rung must NOT erase the days you hit it; this is a new
    # cascade vector the old global-Tier FK never had. Null = whole-habit row
    # (untiered habit or blanket skip), the same meaning tier=null carries today.
    version = models.ForeignKey("Version", on_delete=models.SET_NULL, null=True, blank=True, related_name="logs")

    class Meta:
        constraints = [
            # One row per specific RUNG per habit per day (P2 — completion is keyed
            # on `version` now, so N rungs work and an untagged rung is fine)...
            models.UniqueConstraint(
                fields=["habit", "date", "version"],
                condition=models.Q(version__isnull=False),
                name="one_log_per_habit_date_version",
            ),
            # ...and at most one whole-habit row (version null) per habit per day.
            # Two constraints because Postgres treats NULLs as distinct. These
            # REPLACE the tier-keyed pair: with untagged rungs, `tier` no longer
            # keys a row (an untagged rung's log has tier=null), so a tier-null
            # unique would wrongly collide it with the whole-habit row. `tier`
            # stays as a written cross-check column until P3.
            models.UniqueConstraint(
                fields=["habit", "date"],
                condition=models.Q(version__isnull=True),
                name="one_untiered_log_per_habit_date_v",
            ),
        ]

    def __str__(self):
        return f"{self.date} - {self.habit} ({self.status})"


class HabitTier(models.Model):
    habit = models.ForeignKey(Habit, on_delete=models.CASCADE)

    tier = models.ForeignKey(
        Tier,
        on_delete=models.SET_NULL,
        null=True
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["habit", "tier"],
                name="one_habittier_per_habit_tier",
            )
        ]


class TierValue(models.Model):
    """One value a habit-tier has had, with the date it became active. Many
    rows per HabitTier = the history; the newest `started` is the live value.
    Climbing the number and dropping back are both just a new row dated today
    — a value is never overwritten."""
    habit_tier = models.ForeignKey(HabitTier, on_delete=models.CASCADE)
    value = models.CharField(max_length=100)   # "5 min", "2000 steps", "throw water"
    started = models.DateField()               # the view sets timezone.localdate() on create

    class Meta:
        ordering = ['-started', '-id']         # newest first -> [0] is the current value

    def __str__(self):
        return f"{self.habit_tier_id}: {self.value} (from {self.started})"


class Version(models.Model):
    """One rung on a habit's personal ladder — a specific amount of the habit,
    with an OPTIONAL Roots/Growth tag.

    Replaces HabitTier + TierValue. Instead of borrowing from the global 3-level
    Tier list, a habit owns as many rungs as it wants:

    - `level` is the rung's POSITION on THIS habit's ladder (1 = easiest/lowest),
      not a global tier. It's the only thing the downward cascade orders by:
      completing a higher rung reads the lower ones done (see views._version_status).
      You never type it — it's the drag/order position, renumbered 1..N.
    - `value` is the rung's text ("2000 steps", "cold water", "by 8am").
    - `label` is the OPTIONAL Roots/Growth tag. null = an untagged rung — e.g. a
      2000 sitting between a Roots 1000 and a Growth 6000. A given tag sits on at
      most one rung per habit; that's enforced in the editor, not the DB, because
      the column is nullable (Postgres treats NULLs as distinct, so a partial
      unique would be the only way and it isn't worth a migration constraint yet).

    A PLAIN habit has ZERO Version rows. "no rungs" and "one implicit rung" mean
    the same thing to the user, so we don't store a filler rung that just repeats
    the habit's name; the serializer synthesizes a single implicit rung instead,
    so reads never branch on "does this habit have a ladder". Real rows appear only
    when a second rung is added.
    """
    habit = models.ForeignKey(Habit, on_delete=models.CASCADE, related_name="versions")
    level = models.PositiveIntegerField()      # 1 = lowest rung; per-habit position
    value = models.CharField(max_length=100)   # "2000 steps", "cold water", "by 8am"
    label = models.ForeignKey(Tier, on_delete=models.SET_NULL, null=True, blank=True)

    class Meta:
        ordering = ["habit_id", "level"]
        constraints = [
            models.UniqueConstraint(
                fields=["habit", "level"],
                name="one_version_per_habit_level",
            )
        ]

    def __str__(self):
        tag = self.label.get_level_display() if self.label else "—"
        return f"{self.habit.name} v{self.level} ({self.value}, {tag})"
