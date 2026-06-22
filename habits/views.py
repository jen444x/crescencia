import json
from datetime import time as dt_time

from django.db import transaction
from django.db.models import F, Prefetch
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_time
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from .models import Area, Chain, Routine, Habit, Plan, PlanDay, Schedule, HabitLog, Note, JournalEntry, Tier, HabitTier, TierValue

# Derived (never stored) status: once a day is over, a habit that was never
# completed or skipped reads as "missed". It's computed at read time, so there's
# no MISSED row to create and clients never POST it — log_habit only accepts the
# three real HabitLog.Status values.
MISSED_STATUS = "MISSED"


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


def _shift_time(base, minutes):
    """`base` (a datetime.time) moved by `minutes`, clamped within the same day.

    Negative minutes pull earlier. Clamping (not wrapping) keeps a big shift from
    silently jumping a routine across midnight to the wrong end of the day.
    """
    total = base.hour * 60 + base.minute + minutes
    total = max(0, min(total, 23 * 60 + 59))
    return dt_time(total // 60, total % 60)


def _habit_tiers(habit):
    """This habit's tiers low->high, each with its current value (the newest
    TierValue). Returns [] for an untiered habit. Shape matches the /plan/ and
    habit-detail contract: [{level, name, value}, ...]."""
    tiers = []
    for ht in (HabitTier.objects.filter(habit=habit)
               .select_related("tier").order_by("tier__level")):
        if ht.tier is None:        # tier FK is SET_NULL; skip an orphaned row
            continue
        current = TierValue.objects.filter(habit_tier=ht).first()  # ordering -> newest
        tiers.append({
            "level": ht.tier.level,
            "name": ht.tier.get_level_display(),
            "value": current.value if current else "",
        })
    return tiers


def plan(request):
    # Which day to show. Defaults to today; the day-browser passes
    # ?date=YYYY-MM-DD to view any other day. The plan/schedule layout is the
    # same every day — only each habit's status (its HabitLog for that day)
    # changes, so we just swap which date we look the statuses up for.
    target_date, date_error = _resolve_date(request.GET.get("date"))
    if date_error:
        return date_error

    # Once a day is over, a still-pending habit counts as a miss. We derive that
    # in habit_payload rather than storing it (see MISSED_STATUS).
    is_past_day = target_date < timezone.localdate()

    # That day's status + per-day note for each habit. Habits with no log for the
    # day default to PENDING / empty note below.
    logs_by_habit = {
        hid: (status, notes, tier_level)
        for hid, status, notes, tier_level in HabitLog.objects.filter(date=target_date).values_list(
            "habit_id", "status", "notes", "achieved_tier__level"
        )
    }

    # Per-day time overrides for this day (from a "running late" shift). A plan
    # with no override here just uses its normal recurring time. Lets a
    # pushed-back cycle show its real time for the day without touching the
    # recurring Plan row.
    time_by_plan = dict(
        PlanDay.objects.filter(date=target_date).values_list("plan_id", "start_time")
    )

    # The habit's tier list ([{level,name,value}], current value each), memoized so
    # a habit with several tier-slots only builds it once. EVERY /plan/ row carries
    # it: Case A (slot fixed to a tier) shows its own tier's value; Case B (tiers
    # share one slot, e.g. meditate) lets the frontend swap the value by day-tier.
    tiers_by_habit = {}

    def habit_tier_list(habit):
        if habit.id not in tiers_by_habit:
            tiers_by_habit[habit.id] = _habit_tiers(habit)
        return tiers_by_habit[habit.id]

    def habit_payload(habit, schedule_id=None, chain=None, order=None,
                      routine=None, routine_name=None, tier=None):
        # One HabitLog per habit per day, shared by all the habit's tier-slots.
        raw_status, notes, achieved = logs_by_habit.get(
            habit.id, (HabitLog.Status.PENDING, "", None)
        )
        tiers = habit_tier_list(habit)
        tier_level = tier.level if tier else None
        if tier_level is not None:
            # A tier-slot is one of a habit's easy/hard versions sitting at its own
            # time. It reads done when the day's achieved_tier reaches this slot's
            # level (cascade) — so completing Growth ticks the Roots slot too.
            # Skipping the habit skips every slot; a still-pending slot on a past
            # day reads missed.
            if raw_status == HabitLog.Status.SKIPPED:
                status = HabitLog.Status.SKIPPED
            elif achieved is not None and achieved >= tier_level:
                status = HabitLog.Status.COMPLETED
            elif is_past_day:
                status = MISSED_STATUS
            else:
                status = HabitLog.Status.PENDING
            done = achieved is not None and achieved >= tier_level
            tier_name = tier.get_level_display()
            tier_value = next(
                (t["value"] for t in tiers if t["level"] == tier_level), None
            )
        else:
            # Untiered slot OR Case B (tiers share one slot, tier null): status/done
            # straight from the log; the frontend swaps the value by the day-tier.
            status = raw_status
            if is_past_day and status == HabitLog.Status.PENDING:
                status = MISSED_STATUS
            done = status == HabitLog.Status.COMPLETED
            tier_name = None
            tier_value = None
        return {
            "id": habit.id,                # SAME across a habit's slots; FE groups by it
            "schedule_id": schedule_id,    # THIS slot — the row to target when reordering
            "name": habit.name,
            "chain": chain,   # cycle id, or None if standalone
            "routine": routine,            # routine (group) id, or None if ungrouped
            "routine_name": routine_name,  # the group's name, for the block header
            "order": order,
            "status": status,
            "done_today": done,
            "notes": notes,   # that day's HabitLog.notes ("" if none)
            "is_important": habit.is_important,  # starred "one I care about"
            "tier": tier_level,            # this slot's tier level, or null (untiered/Case B)
            "tier_name": tier_name,        # "Roots"/"Growth", or null
            "tier_value": tier_value,      # Case A: this slot's tier value, else null
            "tiers": tiers,                # habit's tier->value list, [] if untiered
            "achieved_tier": achieved,     # habit's highest tier completed today, or null
        }

    # One query for the plans + their schedules + habits, with schedules sorted
    # by their saved position so /plan/ reflects reordering. Habits with no
    # explicit order (nulls) go last; id breaks ties so the list is stable.
    #
    # Only habits that already existed on the viewed day are shown: a habit you
    # add today shouldn't appear when you scroll back to last week, since it
    # didn't exist then. (For today/future days this filter matches everything,
    # so it's a no-op there.)
    ordered_schedules = Schedule.objects.select_related(
        "habit", "routine", "tier"
    ).filter(
        habit__date_added__date__lte=target_date
    ).order_by(F("order").asc(nulls_last=True), "id")
    plans = Plan.objects.prefetch_related(
        Prefetch("schedule_set", queryset=ordered_schedules)
    )

    plan_groups = []
    for plan in plans:
        # Each Schedule row carries its own habit, chain (cycle), and order,
        # so we just emit each one. The frontend groups the chains.
        habits = [
            habit_payload(
                schedule.habit,
                schedule_id=schedule.id,
                chain=schedule.chain_id,
                routine=schedule.routine_id,
                routine_name=schedule.routine.name if schedule.routine_id else None,
                order=schedule.order,
                tier=schedule.tier,   # this slot's tier (None = untiered slot)
            )
            for schedule in plan.schedule_set.all()
        ]
        plan_groups.append({
            "id": plan.id,
            "time": time_by_plan.get(plan.id, plan.start_time),  # the day's time
            "habits": habits,
        })

    # Sort by the day's effective time so a pushed-back cycle slides down the
    # list (the frontend trusts this order). Timeless plans go last; id breaks
    # ties for a stable order.
    plan_groups.sort(key=lambda g: (g["time"] is None, g["time"] or dt_time.min, g["id"]))

    # Habits that aren't scheduled in any plan (same "existed by then" filter),
    # always last.
    unscheduled = Habit.objects.filter(
        schedule__isnull=True, date_added__date__lte=target_date
    )
    data = plan_groups + [{
        "id": None,
        "time": None,
        "habits": [habit_payload(h) for h in unscheduled],
    }]

    return JsonResponse(data, safe=False)


@csrf_exempt
@require_POST
def log_habit(request, habit_id):
    """Set a habit's status and/or notes for a given day (defaults to today).

    Body: {"status"?: ..., "notes"?: "...", "date"?: "YYYY-MM-DD"} — send at least
    one of `status` / `notes`.
      - status: COMPLETED (complete) | PENDING (undo) | SKIPPED (skip).
      - notes: free text for the day; settable WITHOUT a status, so jotting a note
        doesn't mark the habit done. Send "" to clear it.
    """
    habit = get_object_or_404(Habit, id=habit_id)

    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    has_status = "status" in body
    has_notes = "notes" in body
    if not has_status and not has_notes:
        return JsonResponse(
            {"error": "Send a 'status' and/or 'notes'."}, status=400
        )

    if has_status and body["status"] not in HabitLog.Status.values:
        return JsonResponse(
            {"error": f"'status' must be one of {HabitLog.Status.values}."},
            status=400,
        )
    if has_notes and not isinstance(body["notes"], str):
        return JsonResponse({"error": "'notes' must be a string."}, status=400)

    # Optional: the tier LEVEL completed. Validated up front; it's only *recorded*
    # on a completion (below). A tier the habit doesn't have is a 400.
    raw_tier = body.get("tier")
    has_tier = "tier" in body and raw_tier is not None
    if has_tier:
        if raw_tier not in (1, 2, 3):
            return JsonResponse({"error": "'tier' must be 1, 2, or 3."}, status=400)
        if not HabitTier.objects.filter(habit=habit, tier__level=raw_tier).exists():
            return JsonResponse(
                {"error": f"This habit has no tier {raw_tier}."}, status=400
            )

    # Which day this log is for. Defaults to today, so the existing toggle keeps
    # working unchanged; the day-browser passes "date" to log against the day
    # it's showing (e.g. ticking off something you forgot yesterday).
    target_date, date_error = _resolve_date(body.get("date"))
    if date_error:
        return date_error

    # One log per habit per day; create it the first time it's touched.
    with transaction.atomic():
        log, _ = HabitLog.objects.get_or_create(habit=habit, date=target_date)

        if has_status:
            log.status = body["status"]
            # Only a completion has a meaningful "time done"; clear it otherwise.
            log.time = (
                timezone.localtime().time()
                if log.status == HabitLog.Status.COMPLETED
                else None
            )
            # Record the tier only on a completion; any other status clears it.
            if log.status == HabitLog.Status.COMPLETED and has_tier:
                log.achieved_tier = Tier.objects.filter(level=raw_tier).first()
            else:
                log.achieved_tier = None
        if has_notes:
            log.notes = body["notes"].strip()
        log.save()

    # Return the saved state so the UI can reconcile against the truth.
    return JsonResponse({
        "habit_id": habit.id,
        "date": log.date,
        "status": log.status,
        "done_today": log.status == HabitLog.Status.COMPLETED,
        "notes": log.notes,
        "achieved_tier": log.achieved_tier.level if log.achieved_tier_id else None,
    })


@csrf_exempt
@require_POST
def add_habit_tier(request, habit_id):
    """Add a tier to a habit, or set/bump its value — all are "append a value".

    Body: {"tier": 1|2|3, "value": "7 min" (OPTIONAL)}. Ensures the HabitTier
    exists; if a non-empty value is given, appends a TierValue dated today (the
    new current value; the old one stays as history). No value = a plain tier tag
    (e.g. a Growth-only habit like makeup). Returns {"tiers": [...]} — same shape
    as /plan/.
    """
    habit = get_object_or_404(Habit, id=habit_id)

    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    level = body.get("tier")
    if level not in (1, 2, 3):
        return JsonResponse({"error": "'tier' must be 1, 2, or 3."}, status=400)
    # Value is OPTIONAL: a habit can simply belong to a tier with no number/label
    # (e.g. "makeup" is a Growth-only habit). Only append a TierValue when a
    # non-empty value is actually given.
    value = body.get("value")
    if value is not None and not isinstance(value, str):
        return JsonResponse({"error": "'value' must be a string."}, status=400)

    with transaction.atomic():
        tier, _ = Tier.objects.get_or_create(level=level)
        habit_tier, _ = HabitTier.objects.get_or_create(habit=habit, tier=tier)
        if isinstance(value, str) and value.strip():
            TierValue.objects.create(
                habit_tier=habit_tier,
                value=value.strip(),
                started=timezone.localdate(),
            )

    return JsonResponse({"tiers": _habit_tiers(habit)})


@csrf_exempt
@require_POST
def delete_habit_tier(request, habit_id, level):
    """Drop a tier from a habit. Deletes the HabitTier and its TierValue history
    (CASCADE); the habit just stops existing at that tier. Past logs keep their
    achieved_tier (it's a Tier FK, not a HabitTier FK). Returns the remaining
    {"tiers": [...]}. No such tier on the habit -> 404.
    """
    habit = get_object_or_404(Habit, id=habit_id)
    habit_tier = HabitTier.objects.filter(habit=habit, tier__level=level).first()
    if habit_tier is None:
        return JsonResponse({"error": f"This habit has no tier {level}."}, status=404)
    habit_tier.delete()
    return JsonResponse({"tiers": _habit_tiers(habit)})


@csrf_exempt
@require_POST
def skip_day(request):
    """Skip every habit for a whole day in one shot (e.g. you're out of town).

    Body: {"date"?: "YYYY-MM-DD"} (defaults today). Marks every habit that
    existed on that day SKIPPED — but leaves ones already COMPLETED alone, so a
    blanket skip never erases a win. One log per habit per day, so re-running it
    changes nothing new (idempotent).
    """
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    target_date, date_error = _resolve_date(body.get("date"))
    if date_error:
        return date_error

    # Only habits that existed on that day (same rule /plan/ uses).
    habit_ids = list(
        Habit.objects.filter(date_added__date__lte=target_date).values_list("id", flat=True)
    )
    todays_logs = HabitLog.objects.filter(date=target_date, habit_id__in=habit_ids)

    with transaction.atomic():
        # Flip the ones already logged-but-not-completed to SKIPPED...
        updated = todays_logs.exclude(status=HabitLog.Status.COMPLETED).update(
            status=HabitLog.Status.SKIPPED, time=None
        )
        # ...and add a SKIPPED log for habits that had none yet. (Habits already
        # COMPLETED keep their existing log, so they're preserved untouched.)
        logged_ids = set(todays_logs.values_list("habit_id", flat=True))
        created = HabitLog.objects.bulk_create([
            HabitLog(habit_id=hid, date=target_date, status=HabitLog.Status.SKIPPED)
            for hid in habit_ids if hid not in logged_ids
        ])

    skipped = updated + len(created)
    return JsonResponse({
        "date": target_date,
        "skipped": skipped,
        "kept_completed": len(habit_ids) - skipped,
    })


@csrf_exempt
@require_POST
def clear_day(request):
    """Undo a day's per-day adjustments, back to its default — for "undo a skip"
    or a mis-fired "running late" shift.

    Body: {"date"?: "YYYY-MM-DD"} (defaults today). Removes:
      - that day's time shifts (its PlanDay overrides), and
      - skips / pendings (HabitLogs that aren't COMPLETED).
    Completions are kept (your wins stay), and any notes are kept — a note-bearing
    log is reset to PENDING but holds onto its text; only empty, non-completed
    logs are deleted outright (PENDING + no note == the default no-row state).
    """
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    target_date, date_error = _resolve_date(body.get("date"))
    if date_error:
        return date_error

    non_completed = HabitLog.objects.filter(date=target_date).exclude(
        status=HabitLog.Status.COMPLETED
    )

    with transaction.atomic():
        shifts_cleared = PlanDay.objects.filter(date=target_date).delete()[0]
        # Keep notes: a note-bearing skip/pending goes back to PENDING but holds
        # its text; everything else with nothing to keep is removed.
        notes_kept = non_completed.exclude(notes="").update(
            status=HabitLog.Status.PENDING, time=None
        )
        logs_removed = non_completed.filter(notes="").delete()[0]

    return JsonResponse({
        "date": target_date,
        "shifts_cleared": shifts_cleared,
        "logs_cleared": notes_kept + logs_removed,
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
        if "routine" in item:
            entry["routine"] = item["routine"]   # None or a routine id
        if "tier" in item:
            t = item["tier"]   # None (clear) or a tier level 1/2/3
            if t is not None and (
                not isinstance(t, int) or isinstance(t, bool) or t not in (1, 2, 3)
            ):
                return JsonResponse(
                    {"error": "'tier' must be 1, 2, 3, or null."}, status=400
                )
            entry["tier"] = t
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

    routine_ids = {e["routine"] for e in cleaned if e.get("routine") is not None}
    if routine_ids:
        known = set(Routine.objects.filter(id__in=routine_ids).values_list("id", flat=True))
        unknown = sorted(routine_ids - known)
        if unknown:
            return JsonResponse({"error": f"Unknown routine ids: {unknown}."}, status=400)

    # Map tier level (1/2/3) -> Tier row id, for any items setting a slot's tier.
    tier_by_level = {t.level: t.id for t in Tier.objects.all()}

    fields = {"order"}
    for e in cleaned:
        schedule = schedules[e["id"]]
        schedule.order = e["order"]
        if "chain" in e:
            schedule.chain_id = e["chain"]
            fields.add("chain")
        if "routine" in e:
            schedule.routine_id = e["routine"]
            fields.add("routine")
        if "tier" in e:
            schedule.tier_id = (
                tier_by_level.get(e["tier"]) if e["tier"] is not None else None
            )
            fields.add("tier")

    # One UPDATE for the whole batch, all-or-nothing.
    with transaction.atomic():
        Schedule.objects.bulk_update(schedules.values(), list(fields))

    updated = [
        {"id": s.id, "order": s.order, "chain": s.chain_id, "routine": s.routine_id}
        for s in sorted(schedules.values(), key=lambda s: s.order)
    ]
    return JsonResponse({"updated": updated})


@csrf_exempt
@require_POST
def shift_plans(request):
    """Push a cycle and everything later that day to a new time — for today only.

    Body: {"from_plan": <plan id>, "minutes": <int>, "date"?: "YYYY-MM-DD"}.

    Use case: you woke up late, so the morning cycle and everything after it
    needs to slide back. Every plan whose time *that day* is at or after the
    anchor plan's time moves by `minutes` (negative pulls earlier). This writes
    per-day overrides (PlanDay) and never touches the recurring Plan times, so
    tomorrow is back to normal. Shifting again stacks on the current day's time.
    """
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    from_plan_id = body.get("from_plan")
    # bool is a subclass of int, so reject it explicitly.
    if not isinstance(from_plan_id, int) or isinstance(from_plan_id, bool):
        return JsonResponse({"error": "'from_plan' must be a plan id (integer)."}, status=400)

    minutes = body.get("minutes")
    if not isinstance(minutes, int) or isinstance(minutes, bool):
        return JsonResponse(
            {"error": "'minutes' must be an integer (negative pulls earlier)."}, status=400
        )

    target_date, date_error = _resolve_date(body.get("date"))
    if date_error:
        return date_error

    # Each plan's effective time this day: its override if one exists, else its
    # recurring time. Timeless plans (no start_time) can't anchor or move.
    overrides = dict(
        PlanDay.objects.filter(date=target_date).values_list("plan_id", "start_time")
    )
    effective = {
        p.id: overrides.get(p.id, p.start_time) for p in Plan.objects.all()
    }

    if from_plan_id not in effective:
        return JsonResponse({"error": f"Unknown plan id: {from_plan_id}."}, status=400)
    threshold = effective[from_plan_id]
    if threshold is None:
        return JsonResponse(
            {"error": "That cycle has no time set, so there's nothing to shift from."},
            status=400,
        )

    # The anchor cycle and everything at or after it that day move together.
    affected = {
        pid: t for pid, t in effective.items() if t is not None and t >= threshold
    }

    with transaction.atomic():
        for pid, base in affected.items():
            PlanDay.objects.update_or_create(
                plan_id=pid,
                date=target_date,
                defaults={"start_time": _shift_time(base, minutes)},
            )

    # Return the day's new times, sorted, so the UI can reconcile.
    updated = sorted(
        ({"plan": pid, "time": _shift_time(base, minutes)} for pid, base in affected.items()),
        key=lambda r: r["time"],
    )
    return JsonResponse({"date": target_date, "updated": updated})


@csrf_exempt
@require_POST
def retime_plan(request):
    """Move ONE cycle to a new time — for today only, no cascade.

    Body: {"plan": <plan id>, "time": "HH:MM", "date"?: "YYYY-MM-DD"}.

    The drag-the-time-header companion to shift_plans: you drop a single cycle at
    an absolute time and *only* that cycle moves — everything else stays put
    (whereas shift slides the anchor and everything after it). Like shift, it
    writes a per-day override (PlanDay) and never touches the recurring Plan time,
    so tomorrow is back to normal. Dropping a cycle on its normal recurring time
    clears the override instead of storing a redundant "no-op" one.
    """
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    plan_id = body.get("plan")
    # bool is a subclass of int, so reject it explicitly.
    if not isinstance(plan_id, int) or isinstance(plan_id, bool):
        return JsonResponse({"error": "'plan' must be a plan id (integer)."}, status=400)

    raw_time = body.get("time")
    if not isinstance(raw_time, str):
        return JsonResponse({"error": "'time' must be an 'HH:MM' string."}, status=400)
    try:
        new_time = parse_time(raw_time)   # None if the format is wrong
    except ValueError:
        new_time = None                   # right shape, impossible time (e.g. 25:00)
    if new_time is None:
        return JsonResponse(
            {"error": f"'time' must be a valid 'HH:MM' time, got {raw_time!r}."},
            status=400,
        )
    # The rest of the app works at minute precision; drop any seconds/micros so a
    # "back to recurring" compare below is exact.
    new_time = new_time.replace(second=0, microsecond=0)

    target_date, date_error = _resolve_date(body.get("date"))
    if date_error:
        return date_error

    try:
        plan = Plan.objects.get(id=plan_id)
    except Plan.DoesNotExist:
        return JsonResponse({"error": f"Unknown plan id: {plan_id}."}, status=400)

    with transaction.atomic():
        if new_time == plan.start_time:
            # Back on its normal time — drop any override so "no row = normal" holds.
            PlanDay.objects.filter(plan=plan, date=target_date).delete()
        else:
            # Absolute set (not a delta): a second drop replaces the first.
            PlanDay.objects.update_or_create(
                plan=plan, date=target_date, defaults={"start_time": new_time}
            )

    return JsonResponse({"date": target_date, "plan": plan_id, "time": new_time})


def _habit_detail(habit):
    """The shape returned after creating or editing a habit."""
    return {
        "id": habit.id,
        "name": habit.name,
        "notes": habit.notes,
        "area": habit.area_id,
        "date_added": habit.date_added,
        "is_important": habit.is_important,
        "tiers": _habit_tiers(habit),   # same shape as in /plan/
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

    is_important = body.get("is_important", False)
    if not isinstance(is_important, bool):
        return JsonResponse({"error": "'is_important' must be true or false."}, status=400)

    habit = Habit.objects.create(
        name=name, notes=notes.strip(), area_id=area_id, is_important=is_important
    )
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

    if "is_important" in body:
        if not isinstance(body["is_important"], bool):
            return JsonResponse({"error": "'is_important' must be true or false."}, status=400)
        habit.is_important = body["is_important"]

    habit.save()
    return JsonResponse(_habit_detail(habit))


# --- Per-day notes (Note model) ---------------------------------------------
# A Note is its own row (body + date) linked to one or more habits (M2M). Unlike
# the legacy HabitLog.notes (one string per habit per day), a habit can now have
# several notes a day, and one note can be shared across habits. That shared case
# is why edit/delete carry a "scope": "all" touches the shared note itself, while
# "one" peels a single habit off it (copy-on-write on edit; unlink on delete).

def _note_detail(note):
    """Shape of a Note in responses. `shared` is a UI hint: when a note sits on
    more than one habit, the client should offer "change this one vs. all"."""
    habit_ids = sorted(h.id for h in note.habits.all())
    return {
        "id": note.id,
        "body": note.body,
        "date": note.date,
        "habits": habit_ids,
        "shared": len(habit_ids) > 1,
        "created_at": note.created_at,
        "updated_at": note.updated_at,
    }


def _valid_id(value):
    """True if `value` is a usable id (int, not bool — bool is an int subclass)."""
    return isinstance(value, int) and not isinstance(value, bool)


def day_notes(request):
    """Every note for a day (defaults today). One call for the Plan page; the
    client groups them by the habit ids in each note's `habits` list. Honors
    ?date=YYYY-MM-DD like /plan/ does."""
    target_date, date_error = _resolve_date(request.GET.get("date"))
    if date_error:
        return date_error
    notes = Note.objects.filter(date=target_date).prefetch_related("habits")
    return JsonResponse([_note_detail(n) for n in notes], safe=False)


def habit_notes(request, habit_id):
    """Every note for one habit on a day (defaults today). Powers the habit
    detail page's notes section, where a date picker lets you browse any day.
    Honors ?date=YYYY-MM-DD like /days/notes/ does."""
    target_date, date_error = _resolve_date(request.GET.get("date"))
    if date_error:
        return date_error
    habit = get_object_or_404(Habit, id=habit_id)
    notes = Note.objects.filter(habits=habit, date=target_date).prefetch_related("habits")
    return JsonResponse([_note_detail(n) for n in notes], safe=False)


@csrf_exempt
@require_POST
def create_note(request):
    """Create a note for one or more habits on a day.

    Body: {"body": "...", "habits": [<id>, ...], "date"?: "YYYY-MM-DD"}.
    """
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    text = body.get("body")
    if not isinstance(text, str) or not text.strip():
        return JsonResponse({"error": "'body' is required."}, status=400)
    text = text.strip()

    habit_ids = body.get("habits")
    if not isinstance(habit_ids, list) or not habit_ids:
        return JsonResponse(
            {"error": "'habits' must be a non-empty list of habit ids."}, status=400
        )
    if not all(_valid_id(hid) for hid in habit_ids):
        return JsonResponse({"error": "Each habit id must be an integer."}, status=400)

    wanted = set(habit_ids)
    found = set(Habit.objects.filter(id__in=wanted).values_list("id", flat=True))
    missing = sorted(wanted - found)
    if missing:
        return JsonResponse({"error": f"Unknown habit ids: {missing}."}, status=400)

    target_date, date_error = _resolve_date(body.get("date"))
    if date_error:
        return date_error

    with transaction.atomic():
        note = Note.objects.create(body=text, date=target_date)
        note.habits.set(found)
    return JsonResponse(_note_detail(note), status=201)


@csrf_exempt
@require_POST
def edit_note(request, note_id):
    """Edit a note's text.

    Body: {"body": "...", "scope"?: "all" | "one", "habit"?: <id>}.
      - scope "all" (default): change the shared note in place — every habit on
        it sees the new text.
      - scope "one": change it for just one habit. If the note is on other habits
        too, that habit is peeled onto a NEW note (copy-on-write) so the others
        keep the original; if it was the only habit, this is just a plain edit.
    """
    note = get_object_or_404(Note, id=note_id)
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    text = body.get("body")
    if not isinstance(text, str) or not text.strip():
        return JsonResponse({"error": "'body' is required."}, status=400)
    text = text.strip()

    scope = body.get("scope", "all")
    if scope not in ("all", "one"):
        return JsonResponse({"error": "'scope' must be 'all' or 'one'."}, status=400)

    if scope == "all":
        note.body = text
        note.save()
        return JsonResponse(_note_detail(note))

    # scope == "one"
    habit_id = body.get("habit")
    if not _valid_id(habit_id):
        return JsonResponse(
            {"error": "'habit' (id) is required when scope is 'one'."}, status=400
        )
    linked = set(note.habits.values_list("id", flat=True))
    if habit_id not in linked:
        return JsonResponse(
            {"error": "That habit isn't attached to this note."}, status=400
        )

    # Only habit on the note → editing "one" is just editing it.
    if len(linked) == 1:
        note.body = text
        note.save()
        return JsonResponse(_note_detail(note))

    # Shared note → fork a copy for this habit, leave the rest on the original.
    with transaction.atomic():
        note.habits.remove(habit_id)
        forked = Note.objects.create(body=text, date=note.date)
        forked.habits.add(habit_id)
    return JsonResponse(_note_detail(forked), status=201)


@csrf_exempt
@require_POST
def delete_note(request, note_id):
    """Delete a note, or detach it from one habit.

    Body: {"scope"?: "all" | "one", "habit"?: <id>}.
      - scope "all" (default): delete the note for every habit on it.
      - scope "one": detach just one habit. If that leaves the note with no
        habits, the note is deleted too (the orphan rule).
    """
    note = get_object_or_404(Note, id=note_id)
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    scope = body.get("scope", "all")
    if scope not in ("all", "one"):
        return JsonResponse({"error": "'scope' must be 'all' or 'one'."}, status=400)

    if scope == "all":
        note.delete()
        return JsonResponse({"note_id": note_id, "note_deleted": True})

    habit_id = body.get("habit")
    if not _valid_id(habit_id):
        return JsonResponse(
            {"error": "'habit' (id) is required when scope is 'one'."}, status=400
        )
    linked = set(note.habits.values_list("id", flat=True))
    if habit_id not in linked:
        return JsonResponse(
            {"error": "That habit isn't attached to this note."}, status=400
        )

    with transaction.atomic():
        note.habits.remove(habit_id)
        remaining = note.habits.count()
        note_deleted = remaining == 0
        if note_deleted:
            note.delete()

    return JsonResponse({
        "note_id": note_id,
        "unlinked_habit": habit_id,
        "note_deleted": note_deleted,
        "remaining_habits": remaining,
    })


# --- Journal entries (JournalEntry model) -----------------------------------
# A day-level free-text entry, not tied to any habit. Several per day are fine;
# they read as a timeline (oldest first within a day). Much simpler than notes —
# each entry stands alone: no habits, no shared/scope, no orphan rule.

def _journal_detail(entry):
    """Shape of a JournalEntry in responses."""
    return {
        "id": entry.id,
        "body": entry.body,
        "date": entry.date,
        "created_at": entry.created_at,
        "updated_at": entry.updated_at,
    }


@csrf_exempt
@require_POST
def create_journal(request):
    """Add a journal entry for a day. Body: {"body": "...", "date"?: "YYYY-MM-DD"}.

    `date` defaults to today; several entries per day are allowed.
    """
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    text = body.get("body")
    if not isinstance(text, str) or not text.strip():
        return JsonResponse({"error": "'body' is required."}, status=400)
    text = text.strip()

    target_date, date_error = _resolve_date(body.get("date"))
    if date_error:
        return date_error

    entry = JournalEntry.objects.create(body=text, date=target_date)
    return JsonResponse(_journal_detail(entry), status=201)


def day_journal(request):
    """Every journal entry for a day (defaults today), oldest first (the model's
    own ordering). Honors ?date=YYYY-MM-DD like /plan/ and /days/notes/ do."""
    target_date, date_error = _resolve_date(request.GET.get("date"))
    if date_error:
        return date_error
    entries = JournalEntry.objects.filter(date=target_date)
    return JsonResponse([_journal_detail(e) for e in entries], safe=False)


@csrf_exempt
@require_POST
def edit_journal(request, entry_id):
    """Edit one journal entry's text. Body: {"body": "..."}."""
    entry = get_object_or_404(JournalEntry, id=entry_id)
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    text = body.get("body")
    if not isinstance(text, str) or not text.strip():
        return JsonResponse({"error": "'body' is required."}, status=400)
    entry.body = text.strip()
    entry.save()
    return JsonResponse(_journal_detail(entry))


@csrf_exempt
@require_POST
def delete_journal(request, entry_id):
    """Delete one journal entry."""
    entry = get_object_or_404(JournalEntry, id=entry_id)
    entry.delete()
    return JsonResponse({"deleted": entry_id})


# --- Routines (Routine model) -----------------------------------------------
# A Routine is a named group of habits that the Plan page renders as ONE
# collapsible block (e.g. "Morning routine"). Membership lives on
# `Schedule.routine`, exactly like `Schedule.chain` — a habit can be in a
# routine, a chain, both, or neither. A routine's "done" state is NEVER stored:
# the block reads as done because its member habits' HabitLogs do (the frontend
# derives it). `log_routine` is just a fan-out that writes one status to every
# member — there is no routine-level log row.

def _routine_detail(routine):
    """Shape of a Routine in responses, with its current member schedule ids."""
    return {
        "id": routine.id,
        "name": routine.name,
        "schedules": list(
            Schedule.objects.filter(routine=routine).values_list("id", flat=True)
        ),
    }


def _routine_name_error(name, *, blank_word="required"):
    """None if `name` is a usable routine name, else a 400 response. `blank_word`
    tailors the message: 'required' on create, 'blank' on edit."""
    if not isinstance(name, str) or not name.strip():
        return JsonResponse({"error": f"'name' is {blank_word}."}, status=400)
    if len(name.strip()) > 100:
        return JsonResponse({"error": "'name' must be at most 100 characters."}, status=400)
    return None


def _check_schedule_ids(ids):
    """Validate a list of schedule ids. Returns (set_of_ids, None) when every id
    is a real Schedule, or (None, error_response) otherwise."""
    if not isinstance(ids, list):
        return None, JsonResponse(
            {"error": "Expected a list of schedule ids."}, status=400
        )
    if not all(_valid_id(sid) for sid in ids):
        return None, JsonResponse(
            {"error": "Each schedule id must be an integer."}, status=400
        )
    wanted = set(ids)
    if wanted:
        found = set(Schedule.objects.filter(id__in=wanted).values_list("id", flat=True))
        missing = sorted(wanted - found)
        if missing:
            return None, JsonResponse(
                {"error": f"Unknown schedule ids: {missing}."}, status=400
            )
    return wanted, None


def routines(request):
    """Every routine (id + name), for an "add to routine" picker."""
    return JsonResponse(
        list(Routine.objects.order_by("name").values("id", "name")), safe=False
    )


@csrf_exempt
@require_POST
def create_routine(request):
    """Create a routine. Body: {"name", "schedules"?: [schedule_id, ...]}.

    `schedules` (optional) tags those existing Schedule rows into the new routine
    immediately, so you can build "Morning routine" from habits already on the
    plan in one step. Omit it to start an empty routine and add habits later.
    """
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    name_error = _routine_name_error(body.get("name"))
    if name_error:
        return name_error

    wanted, sched_error = _check_schedule_ids(body.get("schedules", []))
    if sched_error:
        return sched_error

    with transaction.atomic():
        routine = Routine.objects.create(name=body["name"].strip())
        if wanted:
            Schedule.objects.filter(id__in=wanted).update(routine=routine)
    return JsonResponse(_routine_detail(routine), status=201)


@csrf_exempt
@require_POST
def edit_routine(request, routine_id):
    """Rename a routine. Body: {"name"}."""
    routine = get_object_or_404(Routine, id=routine_id)
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    name_error = _routine_name_error(body.get("name"), blank_word="blank")
    if name_error:
        return name_error

    routine.name = body["name"].strip()
    routine.save()
    return JsonResponse(_routine_detail(routine))


@csrf_exempt
@require_POST
def delete_routine(request, routine_id):
    """Delete a routine. Its member habits STAY on the plan as standalone rows
    (Schedule.routine is SET_NULL), so deleting a group never deletes habits."""
    routine = get_object_or_404(Routine, id=routine_id)
    ungrouped = Schedule.objects.filter(routine=routine).count()
    routine.delete()
    return JsonResponse(
        {"routine_id": routine_id, "deleted": True, "ungrouped": ungrouped}
    )


@csrf_exempt
@require_POST
def routine_members(request, routine_id):
    """Add and/or remove habits from a routine — "add habits over time".

    Body: {"add"?: [schedule_id, ...], "remove"?: [schedule_id, ...]}.
      - add:    tags those Schedule rows into this routine.
      - remove: clears the routine on those rows, but only ones currently in THIS
        routine, so a remove can't yank a habit out of a different group.
    Send either or both.
    """
    routine = get_object_or_404(Routine, id=routine_id)
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    add, remove = body.get("add", []), body.get("remove", [])
    if not add and not remove:
        return JsonResponse({"error": "Send 'add' and/or 'remove'."}, status=400)

    add_ids, add_error = _check_schedule_ids(add)
    if add_error:
        return add_error
    remove_ids, remove_error = _check_schedule_ids(remove)
    if remove_error:
        return remove_error

    with transaction.atomic():
        if add_ids:
            Schedule.objects.filter(id__in=add_ids).update(routine=routine)
        if remove_ids:
            Schedule.objects.filter(id__in=remove_ids, routine=routine).update(
                routine=None
            )
    return JsonResponse(_routine_detail(routine))


@csrf_exempt
@require_POST
def log_routine(request, routine_id):
    """Apply ONE status to every habit in a routine for a day — the block's
    "complete" (and skip / undo) action.

    Body: {"status": COMPLETED|SKIPPED|PENDING, "date"?: "YYYY-MM-DD"}.
      - COMPLETED: write a COMPLETED log for every member (the block checkbox).
      - SKIPPED:   mark every member skipped.
      - PENDING:   reset every member to pending (undo the block).
    Uniform and explicit: unlike /days/skip/, this overwrites members that were
    already completed/skipped, since you tapped the block on purpose. One log per
    habit per day, so each member's log is upserted. Nothing about "done" is
    stored on the routine — the block reads as done because its members do.
    """
    routine = get_object_or_404(Routine, id=routine_id)
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    status = body.get("status")
    if status not in HabitLog.Status.values:
        return JsonResponse(
            {"error": f"'status' must be one of {HabitLog.Status.values}."}, status=400
        )

    target_date, date_error = _resolve_date(body.get("date"))
    if date_error:
        return date_error

    habit_ids = list(
        Schedule.objects.filter(routine=routine).values_list("habit_id", flat=True)
    )
    # Only a completion has a meaningful "time done".
    log_time = timezone.localtime().time() if status == HabitLog.Status.COMPLETED else None

    with transaction.atomic():
        existing_ids = set(
            HabitLog.objects.filter(habit_id__in=habit_ids, date=target_date)
            .values_list("habit_id", flat=True)
        )
        HabitLog.objects.filter(habit_id__in=habit_ids, date=target_date).update(
            status=status, time=log_time
        )
        HabitLog.objects.bulk_create([
            HabitLog(habit_id=hid, date=target_date, status=status, time=log_time)
            for hid in habit_ids if hid not in existing_ids
        ])

    return JsonResponse({
        "routine_id": routine.id,
        "date": target_date,
        "status": status,
        "updated": len(habit_ids),
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


def habits_list(request):
    """Every habit with its tiers and today's completion status — powers the
    Habits overview page.

    Returns a flat array, one object per habit, ordered by area name then habit
    name. Unlike /plan/ (which emits a row per Schedule slot), this lists each
    habit ONCE: we order_by("area__name", "name") instead of relying on the
    model's default ordering, which JOINs Schedule and would duplicate a habit
    that sits in several time-slots.

    Each habit carries its tier ladder (`_habit_tiers`, low->high, [] if
    untiered) and TODAY's HabitLog status/achieved tier (PENDING with no log).
    """
    today = timezone.localdate()

    # One query for today's logs: habit id -> (status, achieved tier level).
    # achieved_tier__level is null when the habit isn't completed/untiered.
    logs_by_habit = {
        hid: (status, achieved_level)
        for hid, status, achieved_level in HabitLog.objects.filter(
            date=today
        ).values_list("habit_id", "status", "achieved_tier__level")
    }

    # Override the model's default ordering (which JOINs Schedule -> duplicates);
    # ordering by area__name/name drops that join so each habit appears once.
    habits = Habit.objects.select_related("area").order_by("area__name", "name")

    data = []
    for habit in habits:
        status, achieved_level = logs_by_habit.get(
            habit.id, (HabitLog.Status.PENDING, None)
        )
        data.append({
            "id": habit.id,
            "name": habit.name,
            "area": habit.area_id,
            "area_name": habit.area.name if habit.area_id else None,
            "is_important": habit.is_important,
            "tiers": _habit_tiers(habit),          # low->high, [] if untiered
            "status": status,                      # today's status, PENDING if no log
            "achieved_tier": achieved_level,       # today's highest tier level, or null
        })

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
