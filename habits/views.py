import json
from datetime import date

from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from .models import Area, Habit, Plan, Schedule, HabitLog


def index(request):
    return JsonResponse({"message": "Hello from Django!"})


def plan(request):
    today = date.today()

    # Habit ids completed today, so the UI shows the right checkmarks
    # after a page refresh.
    completed_today = set(
        HabitLog.objects.filter(
            date=today, status=HabitLog.Status.COMPLETED
        ).values_list("habit_id", flat=True)
    )

    data = []
    # One query for the plans + their schedules + habits.
    plans = Plan.objects.prefetch_related("schedule_set__habit")
    for plan in plans:
        habits = []
        # Each Schedule row now carries its own habit, chain (cycle), and
        # order, so we just emit each one. The frontend groups the chains.
        for schedule in plan.schedule_set.all():
            habit = schedule.habit
            habits.append({
                "id": habit.id,
                "name": habit.name,
                "chain": schedule.chain_id,   # cycle id, or None if standalone
                "order": schedule.order,
                "done_today": habit.id in completed_today,
            })
        data.append({
            "id": plan.id,
            "time": plan.start_time,
            "habits": habits,
        })

    # Habits that aren't scheduled in any plan.
    unscheduled = Habit.objects.filter(schedule__isnull=True)
    data.append({
        "id": None,
        "time": None,
        "habits": [
            {
                "id": h.id,
                "name": h.name,
                "chain": None,
                "done_today": h.id in completed_today,
            }
            for h in unscheduled
        ],
    })

    return JsonResponse(data, safe=False)


@csrf_exempt
@require_POST
def log_habit(request, habit_id):
    """Mark a habit done / not-done for today (the Plan page toggle calls this)."""
    habit = get_object_or_404(Habit, id=habit_id)

    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        body = {}
    requested_status = body.get("status")

    # One log per habit per day; create it the first time it's toggled.
    log, _ = HabitLog.objects.get_or_create(habit=habit, date=date.today())

    if requested_status == HabitLog.Status.COMPLETED:
        log.status = HabitLog.Status.COMPLETED
        log.time = timezone.localtime().time()   # when it was actually done
    else:
        # Anything else (e.g. unchecking) resets it to not-done.
        log.status = HabitLog.Status.PENDING
        log.time = None
    log.save()

    return JsonResponse({
        "habit": habit.id,
        "status": log.status,
        "done_today": log.status == HabitLog.Status.COMPLETED,
    })


def logs(request):
    todays_logs = HabitLog.objects.filter(date=date.today()).order_by("time")
    data = [
        {
            "id": log.id,
            "status": log.status,
            "name": log.habit.name if log.habit else None,
            "time": log.time,
        }
        for log in todays_logs
    ]
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
