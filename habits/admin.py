from django.contrib import admin

from .models import Area, Habit, Plan, HabitPlan, Chain ,HabitChain

admin.site.register(Area)
admin.site.register(Habit)
admin.site.register(Plan)
admin.site.register(HabitPlan)
admin.site.register(Chain)
admin.site.register(HabitChain)
