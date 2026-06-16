import json

from django.db import transaction
from django.db.models import F, Prefetch
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_date
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from .models import Area, Chain, Habit, Plan, Schedule, HabitLog


def index(request):
    return JsonResponse({"message": "Hello from Django!"})


def _resolve_date(value):
    """Turn an optional 'YYYY-MM-DD' string into a date.

    Returns ``(date, None)`` for a usable value, or ``(None, error_response)``
    so callers can ``if err: return err``. ``value`` of ``None`` means "today",
    so endpoints that omit the field keep their old today-only behaviour.
    """
    if value is None:
        return timezone.localdate(), None
    if not isinstance(value, str):
        return None, JsonResponse(
            {"error": "'date' must be a 'YYYY-MM-DD' string."}, status=400
        )
    try:
        parsed = parse_date(value)   # None if the format is wrong
    except ValueError:
        parsed = None                # right format, impossible date (e.g. 2026-02-30)
    if parsed is None:
        return None, JsonResponse(
            {"error": f"'date' must be a valid 'YYYY-MM-DD' date, got {value!r}."},
            status=400,
        )
    return parsed, None


def plan(request):
    # Which day to show. Defaults to today; the day-browser passes
    # ?date=YYYY-MM-DD to view any other day. The plan/schedule layout is the
    # same every day — only each habit's status (its HabitLog for that day)
    # changes, so we just swap which date we look the statuses up for.
    target_date, date_error = _resolve_date(request.GET.get("date"))
    if date_error:
        return date_error

    # That day's status for each habit, so the UI shows the right state
    # (pending / completed / skipped). Habits with no log for the day default
    # to PENDING below.
    status_by_habit = dict(
        HabitLog.objects.filter(date=target_date).values_list("habit_id", "status")
    )

    def habit_payload(habit, schedule_id=None, chain=None, order=None):
        status = status_by_habit.get(habit.id, HabitLog.Status.PENDING)
        return {
            "id": habit.id,
            "schedule_id": schedule_id,   # the row to target when reordering
            "name": habit.name,
            "chain": chain,   # cycle id, or None if standalone
            "order": order,
            "status": status,
            "done_today": status == HabitLog.Status.COMPLETED,
        }

    data = []
    # One query for the plans + their schedules + habits, with schedules sorted
    # by their saved position so /plan/ reflects reordering. Habits with no
    # explicit order (nulls) go last; id breaks ties so the list is stable.
    #
    # Only habits that already existed on the viewed day are shown: a habit you
    # add today shouldn't appear when you scroll back to last week, since it
    # didn't exist then. (For today/future days this filter matches everything,
    # so it's a no-op there.)
    ordered_schedules = Schedule.objects.select_related("habit").filter(
        habit__date_added__date__lte=target_date
    ).order_by(F("order").asc(nulls_last=True), "id")
    plans = Plan.objects.prefetch_related(
        Prefetch("schedule_set", queryset=ordered_schedules)
    )
    for plan in plans:
        # Each Schedule row carries its own habit, chain (cycle), and order,
        # so we just emit each one. The frontend groups the chains.
        habits = [
            habit_payload(
                schedule.habit,
                schedule_id=schedule.id,
                chain=schedule.chain_id,
                order=schedule.order,
            )
            for schedule in plan.schedule_set.all()
        ]
        data.append({
            "id": plan.id,
            "time": plan.start_time,
            "habits": habits,
        })

    # Habits that aren't scheduled in any plan (same "existed by then" filter).
    unscheduled = Habit.objects.filter(
        schedule__isnull=True, date_added__date__lte=target_date
    )
    data.append({
        "id": None,
        "time": None,
        "habits": [habit_payload(h) for h in unscheduled],
    })

    return JsonResponse(data, safe=False)


@csrf_exempt
@require_POST
def log_habit(request, habit_id):
    """Set a habit's status for a given day (defaults to today).

    Body: {"status": ..., "date"?: "YYYY-MM-DD"}. The Plan page buttons send one
    of three statuses:
      - COMPLETED  -> complete it
      - PENDING    -> undo (back to the morning's not-done state)
      - SKIPPED    -> skip it for the day
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

    # Which day this log is for. Defaults to today, so the existing toggle keeps
    # working unchanged; the day-browser passes "date" to log against the day
    # it's showing (e.g. ticking off something you forgot yesterday).
    target_date, date_error = _resolve_date(body.get("date"))
    if date_error:
        return date_error

    # One log per habit per day; create it the first time it's touched.
    log, _ = HabitLog.objects.get_or_create(habit=habit, date=target_date)

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


@csrf_exempt
@require_POST
def reorder_schedules(request):
    """Apply a new arrangement to a set of schedules in one shot.

    After a drag-and-drop the Plan page sends every affected row with its new
    position (and its new cycle, if it was moved between chains):

        {"items": [
            {"id": 10, "order": 1},               # just moved within the list
            {"id": 11, "order": 2, "chain": 3},   # also moved into cycle 3
            {"id": 12, "order": 3, "chain": null} # pulled out to standalone
        ]}

    `chain` is optional: it's only changed when the key is present (null means
    "no cycle"). Sending the whole list — instead of "move row X up one" — keeps
    this idempotent and avoids shuffling neighbours one index at a time.
    """
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    items = body.get("items")
    if not isinstance(items, list) or not items:
        return JsonResponse({"error": "'items' must be a non-empty list."}, status=400)

    # Validate everything before touching the DB, so a bad item can never leave
    # a half-applied order behind.
    cleaned = []
    for item in items:
        if not isinstance(item, dict):
            return JsonResponse({"error": "Each item must be an object."}, status=400)
        sid, order = item.get("id"), item.get("order")
        # bool is a subclass of int, so reject it explicitly.
        if not isinstance(sid, int) or isinstance(sid, bool) \
                or not isinstance(order, int) or isinstance(order, bool):
            return JsonResponse(
                {"error": "Each item needs an integer 'id' and 'order'."}, status=400
            )
        entry = {"id": sid, "order": order}
        if "chain" in item:
            entry["chain"] = item["chain"]   # None or a chain id
        cleaned.append(entry)

    schedules = Schedule.objects.in_bulk([e["id"] for e in cleaned])
    missing = [e["id"] for e in cleaned if e["id"] not in schedules]
    if missing:
        return JsonResponse({"error": f"Unknown schedule ids: {missing}."}, status=400)

    # Validate any chain ids referenced before applying.
    chain_ids = {e["chain"] for e in cleaned if e.get("chain") is not None}
    if chain_ids:
        known = set(Chain.objects.filter(id__in=chain_ids).values_list("id", flat=True))
        unknown = sorted(chain_ids - known)
        if unknown:
            return JsonResponse({"error": f"Unknown chain ids: {unknown}."}, status=400)

    fields = {"order"}
    for e in cleaned:
        schedule = schedules[e["id"]]
        schedule.order = e["order"]
        if "chain" in e:
            schedule.chain_id = e["chain"]
            fields.add("chain")

    # One UPDATE for the whole batch, all-or-nothing.
    with transaction.atomic():
        Schedule.objects.bulk_update(schedules.values(), list(fields))

    updated = [
        {"id": s.id, "order": s.order, "chain": s.chain_id}
        for s in sorted(schedules.values(), key=lambda s: s.order)
    ]
    return JsonResponse({"updated": updated})


def _habit_detail(habit):
    """The shape returned after creating or editing a habit."""
    return {
        "id": habit.id,
        "name": habit.name,
        "notes": habit.notes,
        "area": habit.area_id,
        "date_added": habit.date_added,
    }


def _area_error(area_id):
    """None if area_id is usable (a real area id, or None), else a 400 response."""
    if area_id is None:
        return None
    if isinstance(area_id, bool) or not isinstance(area_id, int) \
            or not Area.objects.filter(id=area_id).exists():
        return JsonResponse({"error": f"Unknown area id: {area_id}."}, status=400)
    return None


def habit(request, habit_id):
    """Read one habit's editable fields (used to pre-fill the edit form)."""
    return JsonResponse(_habit_detail(get_object_or_404(Habit, id=habit_id)))


@csrf_exempt
@require_POST
def create_habit(request):
    """Create a habit. Body: {"name", "notes"?, "area"?}.

    A new habit starts unscheduled (no plan/time), so it appears in the
    "unscheduled" group of /plan/ until it's placed on the timeline.
    """
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    name = body.get("name")
    if not isinstance(name, str) or not name.strip():
        return JsonResponse({"error": "'name' is required."}, status=400)
    name = name.strip()
    if len(name) > 200:
        return JsonResponse({"error": "'name' must be at most 200 characters."}, status=400)

    notes = body.get("notes", "")
    if not isinstance(notes, str):
        return JsonResponse({"error": "'notes' must be a string."}, status=400)

    area_id = body.get("area")
    area_error = _area_error(area_id)
    if area_error:
        return area_error

    habit = Habit.objects.create(name=name, notes=notes.strip(), area_id=area_id)
    return JsonResponse(_habit_detail(habit), status=201)


@csrf_exempt
@require_POST
def edit_habit(request, habit_id):
    """Update a habit's name / notes / area. Partial: only the fields present in
    the body are changed."""
    habit = get_object_or_404(Habit, id=habit_id)

    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    if "name" in body:
        name = body["name"]
        if not isinstance(name, str) or not name.strip():
            return JsonResponse({"error": "'name' cannot be blank."}, status=400)
        name = name.strip()
        if len(name) > 200:
            return JsonResponse({"error": "'name' must be at most 200 characters."}, status=400)
        habit.name = name

    if "notes" in body:
        notes = body["notes"]
        if not isinstance(notes, str):
            return JsonResponse({"error": "'notes' must be a string."}, status=400)
        habit.notes = notes.strip()

    if "area" in body:
        area_error = _area_error(body["area"])
        if area_error:
            return area_error
        habit.area_id = body["area"]

    habit.save()
    return JsonResponse(_habit_detail(habit))


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
