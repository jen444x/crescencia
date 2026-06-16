import json

from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from .models import Area, Habit, Plan, Schedule, HabitLog


def index(request):
    return JsonResponse({"message": "Hello from Django!"})


def plan(request):
    today = timezone.localdate()

    # Today's status for each habit, so the UI shows the right state
    # (pending / completed / skipped) after a page refresh. Habits with no
    # log yet default to PENDING below.
    status_by_habit = dict(
        HabitLog.objects.filter(date=today).values_list("habit_id", "status")
    )

    def habit_payload(habit, chain=None, order=None):
        status = status_by_habit.get(habit.id, HabitLog.Status.PENDING)
        return {
            "id": habit.id,
            "name": habit.name,
            "chain": chain,   # cycle id, or None if standalone
            "order": order,
            "status": status,
            "done_today": status == HabitLog.Status.COMPLETED,
        }

    data = []
    # One query for the plans + their schedules + habits.
    plans = Plan.objects.prefetch_related("schedule_set__habit")
    for plan in plans:
        # Each Schedule row carries its own habit, chain (cycle), and order,
        # so we just emit each one. The frontend groups the chains.
        habits = [
            habit_payload(schedule.habit, chain=schedule.chain_id, order=schedule.order)
            for schedule in plan.schedule_set.all()
        ]
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
        "habits": [habit_payload(h) for h in unscheduled],
    })

    return JsonResponse(data, safe=False)


@csrf_exempt
@require_POST
def log_habit(request, habit_id):
    """Set a habit's status for today.

    The Plan page buttons send one of three statuses:
      - COMPLETED  -> complete it
      - PENDING    -> undo (back to the morning's not-done state)
      - SKIPPED    -> skip it for today
    """
    habit = get_object_or_404(Habit, id=habit_id)

    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    requested_status = body.get("status")
    if requested_status not in HabitLog.Status.values:
        return JsonResponse(
            {"error": f"'status' must be one of {HabitLog.Status.values}."},
            status=400,
        )

    # One log per habit per day; create it the first time it's touched.
    log, _ = HabitLog.objects.get_or_create(habit=habit, date=timezone.localdate())

    log.status = requested_status
    # Only a completion has a meaningful "time done"; clear it otherwise.
    log.time = (
        timezone.localtime().time()
        if requested_status == HabitLog.Status.COMPLETED
        else None
    )
    log.save()

    # Return the saved state so the UI can reconcile against the truth.
    return JsonResponse({
        "habit_id": habit.id,
        "date": log.date,
        "status": log.status,
        "done_today": log.status == HabitLog.Status.COMPLETED,
    })


def logs(request):
    todays_logs = HabitLog.objects.filter(date=timezone.localdate()).order_by("time")
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
