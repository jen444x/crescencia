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
        ordering = ['habitplan__plan__start_time', 'habitchain__order']

    def __str__(self):
        return f"{self.name}"
    
class Chain(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)

class HabitChain(models.Model):
    chain = models.ForeignKey(Chain, on_delete=models.CASCADE)
    habit = models.ForeignKey(Habit, on_delete=models.CASCADE)
    order = models.PositiveIntegerField()

    def __str__(self):
        return f"{self.chain.id}.{self.order} - {self.habit}"

class Plan(models.Model):
    start_date = models.DateField(auto_now_add=True)
    start_time = models.TimeField(blank=True, null=True)

    class Meta:
        ordering = ['start_time']

    def __str__(self):
        return f"{self.start_time}"

class HabitPlan(models.Model):
    habit = models.ForeignKey(Habit, on_delete=models.CASCADE)
    plan = models.ForeignKey(Plan, on_delete=models.SET_NULL, null=True)

    def __str__(self):
        return f"{self.plan.start_time} - {self.habit.name}"


class HabitTier(models.Model):
    habit = models.ForeignKey(Habit, on_delete=models.CASCADE)
    
    tier = models.ForeignKey(
        Tier, 
        on_delete=models.SET_NULL, 
        null=True
    )
    