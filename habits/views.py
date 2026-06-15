from django.http import JsonResponse
from .models import Area, Habit, Plan

def index(request):
    return JsonResponse({"message": "Hello from Django!"})

def plan(request):
    plans = Plan.objects.order_by("start_time").prefetch_related("habitplan_set__habit")

    data = [{
        "id": plan.id,
        "time": plan.start_time, 
        "habits": [
            {"name": habit_plan.habit.name, "id":habit_plan.habit.id} for habit_plan in plan.habitplan_set.all()
        ]   
    } for plan in plans]

    missed_habits = {
        "id": None,
        "time": None, 
        "habits": [{"name": h.name, "id": h.id} for h in Habit.objects.filter(habitplan__isnull=True)]

    }
    # habits with no plans
    data.append(missed_habits)

    return JsonResponse(data, safe=False)

def areas(request):
    areas = Area.objects.all().order_by('name')
    data = list(areas.values('id', 'name'))
    return JsonResponse(data, safe=False)

def area(request, area_id):
    area = Area.objects.get(id=area_id)
    habits = area.habit_set.order_by('-date_added')
    data = list(habits.values('id', 'name', 'notes'))
    return JsonResponse({"area": area.name, "habits": data})
