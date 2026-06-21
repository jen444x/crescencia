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
    path("habits/<int:habit_id>/notes/", views.habit_notes, name="habit_notes"),
    path("habits/<int:habit_id>/tiers/", views.add_habit_tier, name="add_habit_tier"),
    path("habits/<int:habit_id>/tiers/<int:level>/delete/", views.delete_habit_tier, name="delete_habit_tier"),
    path("days/skip/", views.skip_day, name="skip_day"),
    path("days/clear/", views.clear_day, name="clear_day"),
    path("days/notes/", views.day_notes, name="day_notes"),
    path("days/journal/", views.day_journal, name="day_journal"),
    path("notes/create/", views.create_note, name="create_note"),
    path("notes/<int:note_id>/edit/", views.edit_note, name="edit_note"),
    path("notes/<int:note_id>/delete/", views.delete_note, name="delete_note"),
    path("journal/create/", views.create_journal, name="create_journal"),
    path("journal/<int:entry_id>/edit/", views.edit_journal, name="edit_journal"),
    path("journal/<int:entry_id>/delete/", views.delete_journal, name="delete_journal"),
    path("routines/", views.routines, name="routines"),
    path("routines/create/", views.create_routine, name="create_routine"),
    path("routines/<int:routine_id>/edit/", views.edit_routine, name="edit_routine"),
    path("routines/<int:routine_id>/delete/", views.delete_routine, name="delete_routine"),
    path("routines/<int:routine_id>/members/", views.routine_members, name="routine_members"),
    path("routines/<int:routine_id>/log/", views.log_routine, name="log_routine"),
    path("schedules/reorder/", views.reorder_schedules, name="reorder_schedules"),
    path("plans/shift/", views.shift_plans, name="shift_plans"),
    path("plans/retime/", views.retime_plan, name="retime_plan"),
    path("areas/", views.areas, name="areas"),
    path("areas/<int:area_id>/", views.area, name="area"),
]