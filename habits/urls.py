from django.urls import path

from . import views

app_name = 'habits'
urlpatterns = [
    # Home page
    path("", views.index, name="index"),
    path("plan/", views.plan, name="plan"),
    path("logs/", views.logs, name="logs"),
    path("habits/create/", views.create_habit, name="create_habit"),
    path("habits/<int:habit_id>/", views.habit, name="habit"),
    path("habits/<int:habit_id>/edit/", views.edit_habit, name="edit_habit"),
    path("habits/<int:habit_id>/log/", views.log_habit, name="log_habit"),
    path("days/skip/", views.skip_day, name="skip_day"),
    path("schedules/reorder/", views.reorder_schedules, name="reorder_schedules"),
    path("plans/shift/", views.shift_plans, name="shift_plans"),
    path("areas/", views.areas, name="areas"),
    path("areas/<int:area_id>/", views.area, name="area"),
]