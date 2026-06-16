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

    class Meta:
        # Default sort by the related plan's start time
        ordering = ['schedule__plan__start_time', 'schedule__order']

    def __str__(self):
        return f"{self.name}"
    
class Chain(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)

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
    