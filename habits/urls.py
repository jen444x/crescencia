from django.urls import path

from . import views

app_name = 'habits'
urlpatterns = [
    # Home page
    path("", views.index, name="index"),
    path("plan/", views.plan, name="plan"),
    path("logs/", views.logs, name="logs"),
    path("habits/<int:habit_id>/log/", views.log_habit, name="log_habit"),
    path("areas/", views.areas, name="areas"),
    path("areas/<int:area_id>/", views.area, name="area"),
]