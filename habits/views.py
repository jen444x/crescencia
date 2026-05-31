from django.http import JsonResponse
from .models import Area, Habit

def index(request):
    return JsonResponse({"message": "Hello from Django!"})

def habits(request):
    habits = Habit.objects.all().order_by('-date_added')
    data = list(habits.values('id', 'name', 'notes'))
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
