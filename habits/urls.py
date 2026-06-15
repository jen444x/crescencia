from django.urls import path

from . import views

app_name = 'habits'
urlpatterns = [
    # Home page
    path("", views.index, name="index"),
    path("plan/", views.plan, name="plan"),
    path("areas/", views.areas, name="areas"),
    path("areas/<int:area_id>/", views.area, name="area"),
]