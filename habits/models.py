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


class HabitTier(models.Model):
    habit = models.ForeignKey(Habit, on_delete=models.CASCADE)
    
    tier = models.ForeignKey(
        Tier, 
        on_delete=models.SET_NULL, 
        null=True
    )
    