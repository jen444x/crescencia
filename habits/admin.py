from django.contrib import admin

from .models import (
    Area, Habit, Plan, Schedule, Routine, Tier, HabitTier, TierValue,
)

admin.site.register(Area)
admin.site.register(Habit)
admin.site.register(Plan)
admin.site.register(Routine)
admin.site.register(Tier)
admin.site.register(HabitTier)
admin.site.register(TierValue)


# A slot now carries a tier; surface habit/plan/tier so you can place a habit's
# Roots/Growth versions at their own times from the admin (interim, until the
# setup UI lands).
@admin.register(Schedule)
class ScheduleAdmin(admin.ModelAdmin):
    list_display = ("id", "habit", "plan", "tier", "routine", "order")
    list_filter = ("tier", "plan")
