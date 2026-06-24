from django.db import models

class Area(models.Model):
    name = models.CharField(max_length=50) # length of name

    def __str__(self):
        return self.name    # return string representation of the name attribute

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

    class Meta:
        # Default sort by the related plan's start time
        ordering = ['schedule__plan__start_time', 'schedule__order']

    def __str__(self):
        return f"{self.name}"


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


class Chain(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)


class Routine(models.Model):
    """A named group of habits shown as ONE collapsible block on the Plan page
    (e.g. "Morning routine": brush teeth, wash face, ...).

    A routine is just another optional tag on a Schedule row, exactly like
    `chain` — a habit can be in a routine, a chain, both, or neither. The
    difference is only in how each renders: a chain gives its habits an order
    (step 1 → 2 → 3); a routine just groups them, to be done in any order,
    whenever.

    A routine's "done" state is NEVER stored. It's derived from its members'
    HabitLogs: the block reads as done when every member is COMPLETED or SKIPPED
    that day. "Complete the block" is just a fan-out that writes a COMPLETED
    HabitLog for each member (see views.log_routine) — there's no routine log.
    """
    name = models.CharField(max_length=100)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name


class Plan(models.Model):
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

class PlanDay(models.Model):
    """A one-day override of a Plan's time.

    The Plan holds the recurring time (same every day); this records that *on a
    specific date* the routine actually started somewhere else — e.g. you woke
    up late and pushed the morning back. No row for a day = use the Plan's
    normal time. One override per plan per day, so a shift just updates it.
    """
    plan = models.ForeignKey(Plan, on_delete=models.CASCADE)
    date = models.DateField()
    start_time = models.TimeField()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["plan", "date"],
                name="one_time_override_per_plan_per_day",
            )
        ]

    def __str__(self):
        return f"{self.date} - plan {self.plan_id} @ {self.start_time}"

class Schedule(models.Model):
    habit = models.ForeignKey(Habit, on_delete=models.CASCADE)
    plan = models.ForeignKey(Plan, on_delete=models.SET_NULL, null=True)
    chain = models.ForeignKey(Chain, on_delete=models.CASCADE, null=True, blank=True)
    # Like `chain`, but groups (no order) instead of ordering. SET_NULL, not
    # CASCADE: deleting a Routine just ungroups its habits — they stay on the
    # plan as standalone rows — rather than dropping them off the plan.
    routine = models.ForeignKey(Routine, on_delete=models.SET_NULL, null=True, blank=True)
    # Which tier (Roots/Growth) this slot is for. null = the slot isn't
    # tier-specific (an untiered habit). A habit may have MULTIPLE Schedule rows —
    # one per tier that sits at its own time — so "Wake up" can be Growth at 7:30
    # and Roots at 11am. The tier's value/history lives on HabitTier/TierValue;
    # this just places the tier on the timeline.
    tier = models.ForeignKey(Tier, on_delete=models.SET_NULL, null=True, blank=True)
    order = models.PositiveIntegerField(null=True, blank=True)

    def __str__(self):
        return f"{self.plan.start_time} - {self.habit.name}"


class ScheduleDay(models.Model):
    """One day's saved arrangement — the per-day twin of `Schedule`.

    `Schedule` is the recurring plan (same every day): which habit sits in which
    block, its chain, its order. `ScheduleDay` records what a *specific date*
    actually looked like, so editing one day never changes the rest — exactly how
    `PlanDay` is the per-day twin of `Plan`'s time.

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
    plan = models.ForeignKey(Plan, on_delete=models.SET_NULL, null=True, blank=True)
    chain = models.ForeignKey(Chain, on_delete=models.SET_NULL, null=True, blank=True)
    routine = models.ForeignKey(Routine, on_delete=models.SET_NULL, null=True, blank=True)
    tier = models.ForeignKey(Tier, on_delete=models.SET_NULL, null=True, blank=True)
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

    class Meta:
        constraints = [
            # At most one row per specific version per habit per day...
            models.UniqueConstraint(
                fields=["habit", "date", "tier"],
                condition=models.Q(tier__isnull=False),
                name="one_log_per_habit_date_tier",
            ),
            # ...and at most one untiered ("whole habit") row per habit per day.
            # Two constraints because Postgres treats NULLs as distinct, so a
            # single nullable-tier unique would let duplicate untiered rows slip in.
            models.UniqueConstraint(
                fields=["habit", "date"],
                condition=models.Q(tier__isnull=True),
                name="one_untiered_log_per_habit_date",
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
