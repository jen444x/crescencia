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
    # A habit she actually cares about completing (vs a planning/helper habit
    # that just structures the day). Display-only: drives a star + the "Important
    # only" filter. Nothing about tracking changes — helpers still get logged.
    is_important = models.BooleanField(default=False)

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
    
class HabitLog(models.Model):
    class Status(models.TextChoices):
        PENDING = 'PENDING', 'Pending'
        COMPLETED = 'COMPLETED', 'Completed'
        SKIPPED = 'SKIPPED', 'Skipped'
        # UNTRACKED = 'UNTRACKED', 'Untracked' # Optional, used for unanswered days'

    # includes habit and time
    habit = models.ForeignKey(Habit, on_delete=models.SET_NULL, null=True)
    date = models.DateField()
    time = models.TimeField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    notes = models.TextField(blank=True)
    # Highest tier LEVEL completed that day. The cascade is derived from this,
    # never stored: a lower tier reads as done when achieved_tier's level >= its
    # level. null = not completed, or an untiered habit.
    achieved_tier = models.ForeignKey(Tier, on_delete=models.SET_NULL, null=True, blank=True)

    class Meta:
        # A habit has exactly one log per day, so completing/skipping it just
        # updates that row instead of ever creating a duplicate.
        constraints = [
            models.UniqueConstraint(
                fields=["habit", "date"],
                name="one_log_per_habit_per_day",
            )
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
