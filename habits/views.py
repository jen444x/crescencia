import json
from collections import defaultdict
from datetime import time as dt_time, timedelta

from django.db import transaction
from django.db.models import F, Max, Prefetch
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_time
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from .models import Area, Routine, Habit, Plan, PlanDay, Schedule, ScheduleDay, HabitLog, Note, JournalEntry, Tier, HabitTier, TierValue

# Derived (never stored) status: once a day is over, a habit that was never
# completed or skipped reads as "missed". It's computed at read time, so there's
# no MISSED row to create and clients never POST it — log_habit only accepts the
# three real HabitLog.Status values.
MISSED_STATUS = "MISSED"

# Photograph-on-open catch-up window. Every /plan/ load freezes the last N past
# days that were lived but never opened, so a later plan edit can't rewrite them
# (see freeze_day). This is the no-infra alternative to a nightly Railway sweep:
# the user opens the app ~daily, so this catches yesterday-and-back.
FREEZE_CATCHUP_DAYS = 7


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


def _day_logs(target_date):
    """That day's HabitLogs grouped per habit into the shape `_version_status`
    needs: ``habit_id -> {specific:{level:status}, fallback:status|None,
    notes_by_tier:{level:notes}, fallback_notes:str}``.

    `specific` holds the habit's tier-specific rows; `fallback` is the untiered
    ("whole habit") row — a regular habit's only row, or a blanket-skip row.
    """
    buckets = defaultdict(
        lambda: {"specific": {}, "fallback": None,
                 "notes_by_tier": {}, "fallback_notes": ""}
    )
    for hid, level, status, notes in HabitLog.objects.filter(
        date=target_date
    ).values_list("habit_id", "tier__level", "status", "notes"):
        b = buckets[hid]
        if level is None:
            b["fallback"] = status
            b["fallback_notes"] = notes
        else:
            b["specific"][level] = status
            b["notes_by_tier"][level] = notes
    return buckets


def _version_status(specific, fallback, level, is_past):
    """Display status for ONE version of a habit on a day, from that day's logs.

    `specific` = ``{tier_level: status}`` (tier-specific rows), `fallback` = the
    untiered/whole-habit row's status or None, `level` = the version to resolve
    (a tier level, or None for an untiered slot / regular habit).

    Rules (docs/contracts/per-version-status.md): completing a HIGHER version
    cascades DOWN (lower ones read done); completing a LOWER one never touches a
    higher one; a whole-habit row (e.g. a blanket skip) applies to every version;
    an untouched past day derives MISSED.
    """
    completed = [lv for lv, st in specific.items()
                 if st == HabitLog.Status.COMPLETED]
    max_completed = max(completed) if completed else None
    whole_completed = fallback == HabitLog.Status.COMPLETED

    if level is None:
        # Untiered slot / regular habit — the whole-habit view. Done if anything
        # was completed; else the explicit whole-habit status; else derived.
        if whole_completed or max_completed is not None:
            return HabitLog.Status.COMPLETED
        if fallback is not None:
            return fallback
        return MISSED_STATUS if is_past else HabitLog.Status.PENDING

    # A specific version.
    if whole_completed or (max_completed is not None and max_completed >= level):
        return HabitLog.Status.COMPLETED          # cascade down from a higher win
    if level in specific:
        return specific[level]                    # its own SKIPPED / MISSED / PENDING
    if fallback is not None:
        return fallback                           # e.g. a blanket skip covers it
    return MISSED_STATUS if is_past else HabitLog.Status.PENDING


def _effective_schedules(target_date):
    """The recurring `Schedule` rows in effect for `target_date`, one per logical
    slot — the generation-aware projection both `/plan/`'s live path and
    `freeze_day` read from, so they can never disagree.

    The template is versioned by date (`Schedule.valid_from`). A "from D forward"
    placement edit writes a NEW generation of the affected slot(s) stamped
    `valid_from = D`; the old rows stay so they keep covering dates < D. For a
    given date a slot can therefore have several rows, and we must pick exactly
    one: the one that's actually in effect that day.

    A logical slot is `(habit_id, tier_id)` — the same key `ScheduleDay`/`HabitLog`
    version on (a habit can sit in two cycles via two tier-slots, e.g. Roots at
    11am + Growth at 7:30, so each tier is its own slot). For each slot we keep the
    row with the GREATEST `valid_from <= target_date`, dropping older generations
    of that same slot so a moved habit never shows twice and is gone from its old
    cycle for dates >= the edit. `id` breaks a same-day tie (last write wins).

    Also enforces the existing "didn't exist yet" rule (only habits added by then).
    With a single base generation (today's data) this returns the identical set as
    a plain `Schedule.objects.filter(...)` did, so behavior is unchanged.
    """
    rows = (
        Schedule.objects.filter(
            habit__date_added__date__lte=target_date,
            valid_from__lte=target_date,
        )
        .select_related("habit", "routine", "tier")
        # Greatest valid_from (then id) last, so the dict write below keeps the
        # latest generation per slot.
        .order_by("valid_from", "id")
    )
    by_slot = {}
    for s in rows:
        by_slot[(s.habit_id, s.tier_id)] = s
    return list(by_slot.values())


@transaction.atomic
def freeze_day(target_date):
    """Snapshot a day's current template arrangement into `ScheduleDay` (and lock
    each block's time into `PlanDay`) — the "photo" that makes a day immutable.

    Idempotent: a day is "frozen" exactly when it has `ScheduleDay` rows, so if
    any already exist we leave everything alone. Otherwise we copy the day's
    effective `Schedule` arrangement — the same rows `/plan/` would project for
    that date (only habits that existed by then, every tier-slot) — into
    `ScheduleDay`, snapshotting `habit_name` so a later habit-delete can't blank
    out the history. We also write a `PlanDay` per block at that block's effective
    time for the day (its existing override if present, else the recurring time),
    so the frozen time travels in `time_by_plan` exactly like the arrangement does.

    Returns a ``{schedule_id: scheduleday_id}`` map for the rows just created
    (empty if the day was already frozen), so a caller mid-freeze — like
    `arrange_day` on a not-yet-frozen day — can translate template ids it was
    handed into the ScheduleDay ids it must now edit.
    """
    if ScheduleDay.objects.filter(date=target_date).exists():
        return {}   # already frozen — no-op, exactly like PlanDay's "no row" rule

    # The same set `/plan/` projects for this date: only habits that already
    # existed by then, and the generation in effect for the date (latest
    # valid_from <= target_date per slot) — see _effective_schedules.
    schedules = _effective_schedules(target_date)

    # Lock each block's time for the day. A plan's effective time is its existing
    # override if one was set (a "running late" shift), else its recurring time;
    # timeless plans (no start_time) have nothing to freeze and are skipped.
    overrides = dict(
        PlanDay.objects.filter(date=target_date).values_list("plan_id", "start_time")
    )
    plan_ids = {s.plan_id for s in schedules if s.plan_id is not None}
    for pid in plan_ids:
        plan_obj = Plan.objects.get(id=pid)
        effective = overrides.get(pid, plan_obj.start_time)
        if effective is None:
            continue
        PlanDay.objects.get_or_create(
            plan_id=pid, date=target_date, defaults={"start_time": effective}
        )

    # Copy every Schedule slot (including each tier-slot of a multi-tier habit)
    # into its ScheduleDay twin, recording the schedule->scheduleday id mapping.
    id_map = {}
    for s in schedules:
        sd = ScheduleDay.objects.create(
            date=target_date,
            habit=s.habit,
            habit_name=s.habit.name,
            plan_id=s.plan_id,
            routine_id=s.routine_id,
            tier_id=s.tier_id,
            order=s.order,
        )
        id_map[s.id] = sd.id
    return id_map


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
    today = timezone.localdate()
    is_past_day = target_date < today

    # Photograph-on-open catch-up: every plan load also freezes the last
    # FREEZE_CATCHUP_DAYS days *before today* that aren't frozen yet, so a day the
    # user lived but never opened still gets its permanent photo before a later plan
    # edit can rewrite it (the no-cron alternative to a nightly sweep). One query for
    # the already-frozen dates in the window, then idempotent freeze_day on the gaps.
    # Never today or a future day — those aren't history yet.
    window = [today - timedelta(days=n) for n in range(1, FREEZE_CATCHUP_DAYS + 1)]
    already_frozen = set(
        ScheduleDay.objects.filter(date__in=window)
        .values_list("date", flat=True)
        .distinct()
    )
    for d in window:
        if d not in already_frozen:
            freeze_day(d)

    # Lazy "photo on first view of a past day": looking back at history freezes it
    # as it was, so editing the recurring plan later can't rewrite it. Only PAST
    # days, only once (freeze_day is idempotent) — today is still being lived and a
    # future day is a deliberate pre-edit, so neither is auto-frozen on view.
    if is_past_day and not ScheduleDay.objects.filter(date=target_date).exists():
        freeze_day(target_date)

    # A day is "frozen" iff it has ScheduleDay rows: its arrangement was snapshotted
    # so it reads from that copy, not the live template (which would let a later
    # plan edit rewrite the past). No rows = project the template, as before.
    is_frozen = ScheduleDay.objects.filter(date=target_date).exists()

    # That day's logs, grouped per habit into per-version buckets (logs are keyed
    # per VERSION now — see _day_logs / _version_status). Habits with no log
    # default to PENDING / "" via the helpers below.
    day_logs = _day_logs(target_date)

    # Per-day time overrides for this day (from a "running late" shift). A plan
    # with no override here just uses its normal recurring time. Lets a
    # pushed-back cycle show its real time for the day without touching the
    # recurring Plan row.
    time_by_plan = dict(
        PlanDay.objects.filter(date=target_date).values_list("plan_id", "start_time")
    )

    # The habit's tier list, each entry {level,name,value,status,done} for THIS
    # day, memoized so a habit with several tier-slots only builds it once. EVERY
    # /plan/ row carries it: the frontend reads per-version state (Root done /
    # Growth missed) straight from here, independent of which slot the row is.
    tiers_by_habit = {}

    def habit_tier_list(habit):
        if habit.id not in tiers_by_habit:
            bucket = day_logs.get(habit.id)
            specific = bucket["specific"] if bucket else {}
            fallback = bucket["fallback"] if bucket else None
            tiers = _habit_tiers(habit)
            for t in tiers:
                st = _version_status(specific, fallback, t["level"], is_past_day)
                t["status"] = st
                t["done"] = st == HabitLog.Status.COMPLETED
            tiers_by_habit[habit.id] = tiers
        return tiers_by_habit[habit.id]

    def habit_payload(habit, schedule_id=None, order=None,
                      routine=None, routine_name=None, tier=None, row_id=None):
        bucket = day_logs.get(habit.id)
        specific = bucket["specific"] if bucket else {}
        fallback = bucket["fallback"] if bucket else None
        tiers = habit_tier_list(habit)
        tier_level = tier.level if tier else None

        # This slot's status is its OWN version's status (the slot's tier, or the
        # whole-habit view when the slot is untiered). Per-version & independent:
        # a lower one done never closes a higher one; a higher one done cascades
        # down. A still-pending slot on a past day derives missed. (_version_status)
        status = _version_status(specific, fallback, tier_level, is_past_day)
        done = status == HabitLog.Status.COMPLETED

        if tier_level is not None:
            tier_name = tier.get_level_display()
            tier_value = next(
                (t["value"] for t in tiers if t["level"] == tier_level), None
            )
            # This version's note, falling back to a whole-habit note if none.
            notes = (bucket["notes_by_tier"].get(tier_level, "") if bucket else "") \
                or (bucket["fallback_notes"] if bucket else "")
        else:
            tier_name = None
            tier_value = None
            notes = bucket["fallback_notes"] if bucket else ""

        return {
            "id": habit.id,                # SAME across a habit's slots; FE groups by it
            # The stable per-row key dnd + /days/arrange/ target. It's the
            # ScheduleDay id on a frozen day, else the Schedule id — so the id a
            # drag keys on doesn't change when a day flips template -> frozen.
            "row_id": row_id if row_id is not None else schedule_id,
            "schedule_id": schedule_id,    # back-compat: the template slot id (None on a frozen row)
            "name": habit.name,
            "routine": routine,            # routine (group) id, or None if ungrouped
            "routine_name": routine_name,  # the group's name, for the block header
            "order": order,
            "status": status,
            "done_today": done,
            "notes": notes,   # that day's note for this version ("" if none)
            "is_support": habit.is_support,  # True = helper/support habit
            "tier": tier_level,            # this slot's tier level, or null (untiered/Case B)
            "tier_name": tier_name,        # "Roots"/"Growth", or null
            "tier_value": tier_value,      # Case A: this slot's tier value, else null
            "tiers": tiers,                # per-version [{level,name,value,status,done}], [] if untiered
        }

    # The arrangement source differs by whether the day is frozen, but the payload
    # shape is IDENTICAL either way — the frontend can't tell which it got.
    #   - Frozen: read each habit's placement from this date's ScheduleDay rows
    #     (the saved photo), keyed for dnd on the ScheduleDay id (`row_id`).
    #   - Not frozen (today/future, no rows): project the live template `Schedule`,
    #     exactly as before, keyed on the Schedule id.
    # Statuses come from HabitLog/_version_status and the day's times from
    # time_by_plan (PlanDay) in BOTH paths — freeze just locks those PlanDay rows.
    by_plan = defaultdict(list)   # plan_id -> [habit_payload, ...]; None = "Anytime"

    if is_frozen:
        # Read the saved arrangement. order_by mirrors the template path: saved
        # position first (nulls last), id breaks ties for a stable list.
        for sd in (ScheduleDay.objects.filter(date=target_date)
                   .select_related("habit", "routine", "tier")
                   .order_by(F("order").asc(nulls_last=True), "id")):
            if sd.habit is None:
                continue   # habit deleted since the freeze; FK went null (history snapshot only)
            by_plan[sd.plan_id].append(
                habit_payload(
                    sd.habit,
                    row_id=sd.id,            # the row dnd + /days/arrange/ target
                    routine=sd.routine_id,
                    routine_name=sd.routine.name if sd.routine_id else None,
                    order=sd.order,
                    tier=sd.tier,            # this slot's tier (None = untiered slot)
                )
            )
    else:
        # One query for the plans + their schedules + habits, with schedules sorted
        # by their saved position so /plan/ reflects reordering. Habits with no
        # explicit order (nulls) go last; id breaks ties so the list is stable.
        #
        # Only habits that already existed on the viewed day are shown: a habit you
        # add today shouldn't appear when you scroll back to last week, since it
        # didn't exist then. (For today/future days this filter matches everything,
        # so it's a no-op there.)
        # _effective_schedules drops older generations per slot (one row per
        # (habit, tier) — the row with the greatest valid_from <= target_date), so
        # a habit moved "from D forward" shows in its NEW cycle from D and never
        # twice. order_by mirrors the old query: saved position first (nulls last),
        # id breaks ties for a stable list.
        effective = _effective_schedules(target_date)
        ordered_schedules = sorted(
            effective,
            key=lambda s: (s.order is None, s.order or 0, s.id),
        )
        for schedule in ordered_schedules:
            # Each Schedule row carries its own habit, block, and order, so we
            # just emit each one. The frontend groups them by time block.
            by_plan[schedule.plan_id].append(
                habit_payload(
                    schedule.habit,
                    schedule_id=schedule.id,
                    routine=schedule.routine_id,
                    routine_name=schedule.routine.name if schedule.routine_id else None,
                    order=schedule.order,
                    tier=schedule.tier,   # this slot's tier (None = untiered slot)
                )
            )

    # One group per time block. The not-frozen path emits EVERY Plan (so an empty
    # block still renders, as before); the frozen path emits only blocks that had
    # habits that day (an empty block left no ScheduleDay rows to remember).
    if is_frozen:
        plan_rows = Plan.objects.filter(
            id__in=[pid for pid in by_plan if pid is not None]
        )
    else:
        plan_rows = Plan.objects.all()
    plan_groups = [
        {
            "id": p.id,
            "time": time_by_plan.get(p.id, p.start_time),  # the day's time
            "name": p.name,                                # the block's cycle name ("" if unnamed)
            "habits": by_plan.get(p.id, []),
        }
        for p in plan_rows
    ]

    # Sort by the day's effective time so a pushed-back cycle slides down the
    # list (the frontend trusts this order). Timeless plans go last; id breaks
    # ties for a stable order.
    plan_groups.sort(key=lambda g: (g["time"] is None, g["time"] or dt_time.min, g["id"]))

    # The "Anytime" group: habits with no placement this day. Frozen = any
    # ScheduleDay row sitting in no plan (placed at Anytime that day); not frozen =
    # habits with no EFFECTIVE Schedule row at all for this date. We key off the
    # generation actually in effect (not `schedule__isnull`), so a habit whose only
    # Schedule row is a future generation (valid_from > T) correctly sits in Anytime
    # for earlier dates. Same "existed by then" rule, always last.
    if is_frozen:
        anytime_habits = by_plan.get(None, [])
    else:
        # Two sources, both legitimately "Anytime" on a not-frozen day:
        #   - rows whose effective generation has plan=None (a habit explicitly
        #     placed at Anytime, e.g. via a forward-write) — already in by_plan[None]
        #   - habits with NO effective Schedule row at all for this date
        # `placed_ids` is every habit with an effective row, so the second query
        # excludes those (whichever cycle, incl. Anytime) and won't double-list.
        placed_ids = {s.habit_id for s in effective}
        unscheduled = Habit.objects.filter(
            date_added__date__lte=target_date
        ).exclude(id__in=placed_ids)
        anytime_habits = by_plan.get(None, []) + [
            habit_payload(h) for h in unscheduled
        ]
    data = plan_groups + [{
        "id": None,
        "time": None,
        "name": "",   # "Anytime" isn't a cycle, so it's never named
        "habits": anytime_habits,
    }]

    return JsonResponse(data, safe=False)


@csrf_exempt
@require_POST
def log_habit(request, habit_id):
    """Set a habit's status and/or notes for a given day (defaults to today).

    Body: {"status"?, "notes"?, "tier"?: 1|2|3, "date"?: "YYYY-MM-DD"} — send at
    least one of `status` / `notes`.
      - status: COMPLETED (complete) | PENDING (undo) | SKIPPED (skip) | MISSED.
      - tier: WHICH version this log is for. Omit for an untiered habit or a
        whole-habit action; a level writes that version's row, so Root and Growth
        are tracked independently (one row per habit/date/tier).
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

    # Optional: WHICH version (tier level) this log is for — it keys the row
    # (habit, date, tier). Validated up front; a tier the habit doesn't have is a 400.
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

    # One log per (habit, date, version); create it the first time it's touched.
    # tier=None is the untiered/"whole habit" row; a level is that one version.
    tier_obj = Tier.objects.filter(level=raw_tier).first() if has_tier else None
    with transaction.atomic():
        log, _ = HabitLog.objects.get_or_create(
            habit=habit, date=target_date, tier=tier_obj
        )

        if has_status:
            log.status = body["status"]
            # Only a completion has a meaningful "time done"; clear it otherwise.
            log.time = (
                timezone.localtime().time()
                if log.status == HabitLog.Status.COMPLETED
                else None
            )
        if has_notes:
            log.notes = body["notes"].strip()
        log.save()

    # Return the saved state so the UI can reconcile against the truth.
    return JsonResponse({
        "habit_id": habit.id,
        "date": log.date,
        "tier": log.tier.level if log.tier_id else None,
        "status": log.status,
        "done_today": log.status == HabitLog.Status.COMPLETED,
        "notes": log.notes,
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
    `tier` (it's a Tier FK, not a HabitTier FK). Returns the remaining
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

    # Only habits that existed on that day (same rule /plan/ uses). .order_by()
    # clears the model's default (Schedule-joining) ordering, so a habit with
    # several tier-slots isn't returned once per slot — which would make the
    # blanket skip try to write duplicate untiered rows.
    habit_ids = list(
        Habit.objects.filter(date_added__date__lte=target_date)
        .order_by().values_list("id", flat=True)
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
      - that day's saved arrangement (its ScheduleDay rows), so the day stops
        being frozen and projects the recurring template again ("back to
        default"), and
      - that day's time shifts (its PlanDay overrides), and
      - skips / pendings (HabitLogs that aren't COMPLETED).
    Completions are kept (your wins stay) — they're keyed per habit/date/tier and
    are independent of ScheduleDay, so they survive the un-freeze. Any notes are
    kept too — a note-bearing log is reset to PENDING but holds onto its text;
    only empty, non-completed logs are deleted outright (PENDING + no note == the
    default no-row state).

    On a PAST day this discards that day's frozen arrangement, so the next time
    it's viewed it re-freezes from the *current* template (the intended "reset =
    discard this day's adjustments" meaning).
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
        # Un-freeze the day: dropping its ScheduleDay rows returns it to the
        # "no row = use the template" default, just like clearing PlanDay returns
        # its times to the recurring plan. Completions survive (they're HabitLogs,
        # not ScheduleDay rows).
        arrangement_cleared = ScheduleDay.objects.filter(date=target_date).delete()[0]
        shifts_cleared = PlanDay.objects.filter(date=target_date).delete()[0]
        # Keep notes: a note-bearing skip/pending goes back to PENDING but holds
        # its text; everything else with nothing to keep is removed.
        notes_kept = non_completed.exclude(notes="").update(
            status=HabitLog.Status.PENDING, time=None
        )
        logs_removed = non_completed.filter(notes="").delete()[0]

    return JsonResponse({
        "date": target_date,
        "arrangement_cleared": arrangement_cleared,
        "shifts_cleared": shifts_cleared,
        "logs_cleared": notes_kept + logs_removed,
    })


@csrf_exempt
@require_POST
# RETIRED (apply-to-future Phase 0): no URL route; pending Phase 2 fold-in.
def reorder_schedules(request):
    """Apply a new arrangement to a set of schedules in one shot.

    After a drag-and-drop the Plan page sends every affected row with its new
    position (and its new routine, if it was regrouped):

        {"items": [
            {"id": 10, "order": 1},                 # just moved within the list
            {"id": 11, "order": 2, "routine": 3},   # also moved into routine 3
            {"id": 12, "order": 3, "routine": null} # pulled out to ungrouped
        ]}

    `routine` is optional: it's only changed when the key is present (null means
    "no group"). Sending the whole list — instead of "move row X up one" — keeps
    this idempotent and avoids shuffling neighbours one index at a time.

    `plan` (optional) moves a row into another time block — its value is the
    target Plan's id. That's the cross-block drag: the moved row is sent with its
    new `plan`, usually alongside `routine` null (a same-block tag). Omit `plan`
    and the row stays in its current block.
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
        # A stray "chain" key (from an older client) is ignored — the Chain model
        # is gone — rather than 400'd, so it can't break a mid-update frontend.
        if "routine" in item:
            entry["routine"] = item["routine"]   # None or a routine id
        if "plan" in item:
            # Move this row into another time block (cross-block drag). A real
            # plan id only — null ("drop to Anytime") is a delete, handled
            # elsewhere, not here.
            p = item["plan"]
            if not isinstance(p, int) or isinstance(p, bool):
                return JsonResponse(
                    {"error": "'plan' must be a plan id (integer)."}, status=400
                )
            entry["plan"] = p
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

    routine_ids = {e["routine"] for e in cleaned if e.get("routine") is not None}
    if routine_ids:
        known = set(Routine.objects.filter(id__in=routine_ids).values_list("id", flat=True))
        unknown = sorted(routine_ids - known)
        if unknown:
            return JsonResponse({"error": f"Unknown routine ids: {unknown}."}, status=400)

    plan_ids = {e["plan"] for e in cleaned if "plan" in e}
    if plan_ids:
        known = set(Plan.objects.filter(id__in=plan_ids).values_list("id", flat=True))
        unknown = sorted(plan_ids - known)
        if unknown:
            return JsonResponse({"error": f"Unknown plan ids: {unknown}."}, status=400)

    # Map tier level (1/2/3) -> Tier row id, for any items setting a slot's tier.
    tier_by_level = {t.level: t.id for t in Tier.objects.all()}

    fields = {"order"}
    for e in cleaned:
        schedule = schedules[e["id"]]
        schedule.order = e["order"]
        if "routine" in e:
            schedule.routine_id = e["routine"]
            fields.add("routine")
        if "plan" in e:
            schedule.plan_id = e["plan"]
            fields.add("plan")
        if "tier" in e:
            schedule.tier_id = (
                tier_by_level.get(e["tier"]) if e["tier"] is not None else None
            )
            fields.add("tier")

    # One UPDATE for the whole batch, all-or-nothing.
    with transaction.atomic():
        Schedule.objects.bulk_update(schedules.values(), list(fields))

    updated = [
        {"id": s.id, "order": s.order, "plan": s.plan_id, "routine": s.routine_id}
        for s in sorted(schedules.values(), key=lambda s: s.order)
    ]
    return JsonResponse({"updated": updated})


@csrf_exempt
@require_POST
# RETIRED (apply-to-future Phase 0): no URL route; pending Phase 2 fold-in.
def create_schedule(request):
    """Place an unscheduled habit onto the timeline.

    Body: {"habit": <id>, "plan": <id>, "order"?: <int>}. Creates the Schedule
    row that puts a habit (one with none yet — i.e. it's sitting in the "Anytime"
    group) into a time block. `order` is optional; without it the row lands at
    the bottom of that block (max order + 1). Returns the new schedule id so the
    page can drop it straight into the block without a refetch.
    """
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    habit_id = body.get("habit")
    plan_id = body.get("plan")
    # bool is a subclass of int, so reject it explicitly.
    if not isinstance(habit_id, int) or isinstance(habit_id, bool):
        return JsonResponse({"error": "'habit' must be a habit id (integer)."}, status=400)
    if not isinstance(plan_id, int) or isinstance(plan_id, bool):
        return JsonResponse({"error": "'plan' must be a plan id (integer)."}, status=400)

    if not Habit.objects.filter(id=habit_id).exists():
        return JsonResponse({"error": f"Unknown habit id: {habit_id}."}, status=400)
    if not Plan.objects.filter(id=plan_id).exists():
        return JsonResponse({"error": f"Unknown plan id: {plan_id}."}, status=400)

    order = body.get("order")
    if order is not None and (not isinstance(order, int) or isinstance(order, bool)):
        return JsonResponse({"error": "'order' must be an integer."}, status=400)
    if order is None:
        # Append: one past the block's current highest order (1 if it's empty).
        highest = Schedule.objects.filter(plan_id=plan_id).aggregate(m=Max("order"))["m"]
        order = (highest or 0) + 1

    schedule = Schedule.objects.create(habit_id=habit_id, plan_id=plan_id, order=order)
    return JsonResponse(
        {"schedule_id": schedule.id, "habit": habit_id, "plan": plan_id, "order": order},
        status=201,
    )


@csrf_exempt
@require_POST
def arrange_day(request):
    """Reorder / move / place habits for ONE day only — the per-day twin of
    reorder_schedules + create_schedule. Writes `ScheduleDay`, NEVER `Schedule`,
    so an edit here sticks to that date and can't rewrite the recurring plan.

    Body: {"date": "YYYY-MM-DD", "items": [...]}. Each item is the SAME shape as
    reorder_schedules, except `id` is the row's `row_id` (from /plan/):

        {"id": 11, "order": 2, "routine": 3}    # reorder/retag an existing row
        {"id": 12, "order": 3, "plan": 7}       # move it to another block, that day
        {"habit": 9, "plan": 7, "order"?: 4}    # NEW per-day placement: drop a habit
                                                #   from "Anytime" into a block, today only

    `routine` / `tier` / `plan` are only changed when their key is present (null
    clears the tag); `tier` takes a level 1/2/3 or null.

    Freezing: editing a day freezes it first. We snapshot whether the day was
    already frozen, then call freeze_day (idempotent). On a NOT-yet-frozen day the
    `id`s the client holds are template Schedule ids (that's what /plan/ emitted),
    so we translate them through the freeze map to the ScheduleDay rows we just
    created; on an already-frozen day they're ScheduleDay ids already.
    """
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    target_date, date_error = _resolve_date(body.get("date"))
    if date_error:
        return date_error
    if body.get("date") is None:
        # Unlike status logs, an arrange MUST name its day — silently defaulting to
        # today would let a missing field rewrite the wrong day's arrangement.
        return JsonResponse({"error": "'date' is required."}, status=400)

    items = body.get("items")
    if not isinstance(items, list) or not items:
        return JsonResponse({"error": "'items' must be a non-empty list."}, status=400)

    # Validate everything before touching the DB (mirrors reorder_schedules), so a
    # bad item can never leave a half-applied arrangement — or a freeze — behind.
    # An item is either an EDIT/move of an existing row (has "id") or a NEW per-day
    # placement of an Anytime habit (has "habit", no "id").
    moves, places = [], []
    for item in items:
        if not isinstance(item, dict):
            return JsonResponse({"error": "Each item must be an object."}, status=400)

        is_place = "id" not in item and "habit" in item
        if is_place:
            entry = {}
            hid = item.get("habit")
            pid = item.get("plan")
            # bool is a subclass of int, so reject it explicitly.
            if not isinstance(hid, int) or isinstance(hid, bool):
                return JsonResponse(
                    {"error": "A placement needs an integer 'habit' id."}, status=400
                )
            if not isinstance(pid, int) or isinstance(pid, bool):
                return JsonResponse(
                    {"error": "A placement needs an integer 'plan' id."}, status=400
                )
            entry["habit"] = hid
            entry["plan"] = pid
            order = item.get("order")
            if order is not None and (not isinstance(order, int) or isinstance(order, bool)):
                return JsonResponse({"error": "'order' must be an integer."}, status=400)
            entry["order"] = order   # None = append at the bottom of the block
        else:
            rid, order = item.get("id"), item.get("order")
            if not isinstance(rid, int) or isinstance(rid, bool) \
                    or not isinstance(order, int) or isinstance(order, bool):
                return JsonResponse(
                    {"error": "Each item needs an integer 'id' and 'order'."}, status=400
                )
            entry = {"id": rid, "order": order}
            # A stray "chain" key (older client) is ignored, not 400'd — the
            # Chain model is gone, so it just no longer means anything.
            if "routine" in item:
                entry["routine"] = item["routine"]   # None or a routine id
            if "plan" in item:
                # Move this row into another time block (cross-block drag), that
                # day only. A real plan id only — null ("drop to Anytime") clears
                # the placement, so we allow it here (no row off-plan = Anytime).
                p = item["plan"]
                if p is not None and (not isinstance(p, int) or isinstance(p, bool)):
                    return JsonResponse(
                        {"error": "'plan' must be a plan id (integer) or null."}, status=400
                    )
                entry["plan"] = p
            if "tier" in item:
                t = item["tier"]   # None (clear) or a tier level 1/2/3
                if t is not None and (
                    not isinstance(t, int) or isinstance(t, bool) or t not in (1, 2, 3)
                ):
                    return JsonResponse(
                        {"error": "'tier' must be 1, 2, 3, or null."}, status=400
                    )
                entry["tier"] = t
            moves.append(entry)
        if is_place:
            places.append(entry)

    # Validate referenced foreign keys up front (like reorder_schedules).
    routine_ids = {e["routine"] for e in moves if e.get("routine") is not None}
    if routine_ids:
        known = set(Routine.objects.filter(id__in=routine_ids).values_list("id", flat=True))
        unknown = sorted(routine_ids - known)
        if unknown:
            return JsonResponse({"error": f"Unknown routine ids: {unknown}."}, status=400)

    plan_ids = {e["plan"] for e in moves if "plan" in e and e["plan"] is not None}
    plan_ids |= {e["plan"] for e in places}
    if plan_ids:
        known = set(Plan.objects.filter(id__in=plan_ids).values_list("id", flat=True))
        unknown = sorted(plan_ids - known)
        if unknown:
            return JsonResponse({"error": f"Unknown plan ids: {unknown}."}, status=400)

    habit_ids = {e["habit"] for e in places}
    if habit_ids:
        known = set(Habit.objects.filter(id__in=habit_ids).values_list("id", flat=True))
        unknown = sorted(habit_ids - known)
        if unknown:
            return JsonResponse({"error": f"Unknown habit ids: {unknown}."}, status=400)

    # Map tier level (1/2/3) -> Tier row id, for any items setting a slot's tier.
    tier_by_level = {t.level: t.id for t in Tier.objects.all()}

    # A bad row id must NOT leave the day frozen (the freeze runs inside the same
    # transaction). We signal it with this exception so the atomic block rolls the
    # whole thing — freeze included — back, then turn it into a clean 400 outside.
    class _BadRowId(Exception):
        def __init__(self, row_id):
            self.row_id = row_id

    try:
        with transaction.atomic():
            # Freeze the day if needed, then resolve each move's id to a
            # ScheduleDay row. On a not-yet-frozen day the client's ids are
            # template Schedule ids, so we translate them through the freeze map;
            # on a frozen day they're already ScheduleDay ids.
            was_frozen = ScheduleDay.objects.filter(date=target_date).exists()
            freeze_map = freeze_day(target_date)   # {schedule_id: scheduleday_id}; {} if was_frozen

            resolved = []   # (ScheduleDay id, entry) pairs to apply
            for e in moves:
                sd_id = e["id"] if was_frozen else freeze_map.get(e["id"])
                if sd_id is None:
                    # A Schedule id that wasn't part of the freeze (e.g. a habit
                    # that didn't exist on that day, so it has no row).
                    raise _BadRowId(e["id"])
                resolved.append((sd_id, e))

            rows = ScheduleDay.objects.in_bulk([sd_id for sd_id, _ in resolved])
            # A ScheduleDay id the client sent that doesn't exist (frozen-day case).
            for sd_id, e in resolved:
                if sd_id not in rows:
                    raise _BadRowId(e["id"])
            fields = {"order"}
            for sd_id, e in resolved:
                row = rows[sd_id]
                row.order = e["order"]
                if "routine" in e:
                    row.routine_id = e["routine"]
                    fields.add("routine")
                if "plan" in e:
                    row.plan_id = e["plan"]
                    fields.add("plan")
                if "tier" in e:
                    row.tier_id = (
                        tier_by_level.get(e["tier"]) if e["tier"] is not None else None
                    )
                    fields.add("tier")
            if rows:
                ScheduleDay.objects.bulk_update(rows.values(), list(fields))

            # New per-day placements: a habit dragged from Anytime that has no row
            # this day. Create a ScheduleDay row for it (mirrors create_schedule's
            # append logic, on the per-day layer), snapshotting habit_name.
            habit_names = dict(
                Habit.objects.filter(id__in=habit_ids).values_list("id", "name")
            )
            created = []
            for e in places:
                order = e["order"]
                if order is None:
                    # Append: one past this block's current highest order that day.
                    highest = ScheduleDay.objects.filter(
                        date=target_date, plan_id=e["plan"]
                    ).aggregate(m=Max("order"))["m"]
                    order = (highest or 0) + 1
                sd = ScheduleDay.objects.create(
                    date=target_date,
                    habit_id=e["habit"],
                    habit_name=habit_names[e["habit"]],
                    plan_id=e["plan"],
                    order=order,
                )
                created.append(sd)
    except _BadRowId as bad:
        return JsonResponse(
            {"error": f"Unknown row id for this day: {bad.row_id}."}, status=400
        )

    # Return the day's updated arrangement (touched rows), like reorder_schedules.
    touched = list(rows.values()) + created
    updated = [
        {"id": sd.id, "order": sd.order, "plan": sd.plan_id, "routine": sd.routine_id}
        for sd in sorted(touched, key=lambda sd: (sd.order is None, sd.order or 0, sd.id))
    ]
    return JsonResponse({"date": target_date, "updated": updated})


@csrf_exempt
@require_POST
def arrange_forward(request):
    """Apply a placement arrangement (which cycle a habit is in + its order)
    PERMANENTLY from a date forward — the "every day from today" twin of
    arrange_day's per-day write. This is the ONLY sanctioned recurring placement
    writer (the legacy /schedules/create|reorder/ are retired); it writes a DATED
    `Schedule` generation, never a dateless one, so it can never reach into the
    past (apply-to-future Phase 2 / docs/contracts/apply-to-future.md).

    Body (placement only — time is a separate Phase-3 edit):
        {
          "from_date": "YYYY-MM-DD",   # optional, defaults to today; inclusive (D2)
          "items": [
            {"habit": 9, "plan": 7, "tier": 2|null, "order": 1},
            {"habit": 3, "plan": null, "order": 2},   # plan null = Anytime
            ...
          ]
        }

    For each item we UPSERT a `Schedule` row at `valid_from = from_date` for the
    logical slot (habit, tier), setting its plan + order (+ routine if sent). Send
    the WHOLE affected cycle(s) as fresh 1..N orders — whole-list & idempotent, the
    pattern reorder used. We NEVER touch earlier-generation rows: they keep covering
    dates < from_date. Re-running the same edit UPDATEs the from_date generation
    (matched on (habit, tier, valid_from)) instead of duplicating it.

    Moving a habit to a new cycle needs nothing more than writing its new
    (plan, order) at from_date: the per-slot read (_effective_schedules) drops the
    habit's older-generation row for dates >= from_date, so it leaves the old cycle
    automatically and is never shown twice.

    Frozen days: a frozen day reads its own ScheduleDay, so this template write is
    invisible to it — which is exactly right for a pre-edited FUTURE day (D3: its
    deliberate arrangement wins, it's skipped). The one exception is TODAY: if
    from_date == today and today is already frozen, a pure template write wouldn't
    show on today, so "every day from today" would visibly exclude today. To keep
    it honest we ALSO mirror the new placement into today's ScheduleDay. We do this
    ONLY for today, never a frozen future day.
    """
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    # from_date is optional and defaults to today (inclusive — "this and
    # following", D2). Unlike arrange_day's required per-day date, a missing
    # from_date here is a safe default: today never reaches the past.
    raw_from = body.get("from_date")
    if raw_from is None:
        from_date = timezone.localdate()
    else:
        from_date, date_error = _resolve_date(raw_from)
        if date_error:
            return date_error

    items = body.get("items")
    if not isinstance(items, list) or not items:
        return JsonResponse({"error": "'items' must be a non-empty list."}, status=400)

    # Validate everything before touching the DB, so a bad item can never leave a
    # half-applied generation behind (mirrors reorder_schedules/arrange_day).
    cleaned = []
    for item in items:
        if not isinstance(item, dict):
            return JsonResponse({"error": "Each item must be an object."}, status=400)
        hid, order = item.get("habit"), item.get("order")
        # bool is a subclass of int, so reject it explicitly.
        if not isinstance(hid, int) or isinstance(hid, bool) \
                or not isinstance(order, int) or isinstance(order, bool):
            return JsonResponse(
                {"error": "Each item needs an integer 'habit' and 'order'."},
                status=400,
            )
        entry = {"habit": hid, "order": order}
        # `plan` is REQUIRED for a placement (which cycle), but null is allowed and
        # means "Anytime" (no block) — the forward twin of arrange_day's
        # null-plan-clears behavior.
        if "plan" not in item:
            return JsonResponse(
                {"error": "Each item needs a 'plan' (id or null)."}, status=400
            )
        p = item["plan"]
        if p is not None and (not isinstance(p, int) or isinstance(p, bool)):
            return JsonResponse(
                {"error": "'plan' must be a plan id (integer) or null."}, status=400
            )
        entry["plan"] = p
        if "tier" in item:
            t = item["tier"]   # None (untiered slot) or a tier level 1/2/3
            if t is not None and (
                not isinstance(t, int) or isinstance(t, bool) or t not in (1, 2, 3)
            ):
                return JsonResponse(
                    {"error": "'tier' must be 1, 2, 3, or null."}, status=400
                )
            entry["tier"] = t
        else:
            entry["tier"] = None
        if "routine" in item:
            entry["routine"] = item["routine"]   # None or a routine id
        cleaned.append(entry)

    # Validate referenced foreign keys up front.
    habit_ids = {e["habit"] for e in cleaned}
    known = set(Habit.objects.filter(id__in=habit_ids).values_list("id", flat=True))
    unknown = sorted(habit_ids - known)
    if unknown:
        return JsonResponse({"error": f"Unknown habit ids: {unknown}."}, status=400)

    plan_ids = {e["plan"] for e in cleaned if e["plan"] is not None}
    if plan_ids:
        known_p = set(Plan.objects.filter(id__in=plan_ids).values_list("id", flat=True))
        unknown_p = sorted(plan_ids - known_p)
        if unknown_p:
            return JsonResponse({"error": f"Unknown plan ids: {unknown_p}."}, status=400)

    routine_ids = {e["routine"] for e in cleaned if e.get("routine") is not None}
    if routine_ids:
        known_r = set(Routine.objects.filter(id__in=routine_ids).values_list("id", flat=True))
        unknown_r = sorted(routine_ids - known_r)
        if unknown_r:
            return JsonResponse({"error": f"Unknown routine ids: {unknown_r}."}, status=400)

    # Map tier level (1/2/3) -> Tier row id.
    tier_by_level = {t.level: t.id for t in Tier.objects.all()}

    today = timezone.localdate()
    # Only mirror into a frozen day when that day is TODAY (D2/today-reflect). A
    # frozen FUTURE day is a deliberate pre-edit and stays untouched (D3).
    reflect_today = (
        from_date == today
        and ScheduleDay.objects.filter(date=today).exists()
    )

    written = []
    with transaction.atomic():
        for e in cleaned:
            tier_id = (
                tier_by_level.get(e["tier"]) if e["tier"] is not None else None
            )
            defaults = {"plan_id": e["plan"], "order": e["order"]}
            if "routine" in e:
                defaults["routine_id"] = e["routine"]
            # UPSERT the from_date generation of this slot (habit, tier): re-running
            # the same forward edit updates it rather than duplicating it.
            sched, _ = Schedule.objects.update_or_create(
                habit_id=e["habit"],
                tier_id=tier_id,
                valid_from=from_date,
                defaults=defaults,
            )
            written.append(sched)

            if reflect_today:
                # Keep today (frozen) in sync so "every day from today" visibly
                # includes today. Upsert the matching ScheduleDay slot.
                sd_defaults = {
                    "plan_id": e["plan"],
                    "order": e["order"],
                    "habit_name": Habit.objects.values_list("name", flat=True).get(
                        id=e["habit"]
                    ),
                }
                if "routine" in e:
                    sd_defaults["routine_id"] = e["routine"]
                ScheduleDay.objects.update_or_create(
                    date=today,
                    habit_id=e["habit"],
                    tier_id=tier_id,
                    defaults=sd_defaults,
                )

    updated = [
        {
            "id": s.id,
            "habit": s.habit_id,
            "plan": s.plan_id,
            "tier": s.tier.level if s.tier_id else None,
            "order": s.order,
            "valid_from": s.valid_from.isoformat(),
        }
        for s in sorted(written, key=lambda s: (s.order is None, s.order or 0, s.id))
    ]
    return JsonResponse({"from_date": from_date.isoformat(), "updated": updated})


@csrf_exempt
@require_POST
def create_plan(request):
    """Create a new (empty) time block, or reuse the one at that time.

    Body: {"time": "HH:MM"}. Same time = same cycle, so if a Plan already has
    that start_time we return it instead of making a second block at the same
    minute. The page then renders the (possibly empty) block so a habit can be
    dragged into it. `created` tells the caller which happened.
    """
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

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
    new_time = new_time.replace(second=0, microsecond=0)

    # Reuse an existing block at this minute rather than duplicating it.
    plan = Plan.objects.filter(start_time=new_time).first()
    created = plan is None
    if created:
        plan = Plan.objects.create(start_time=new_time)
    return JsonResponse(
        {"id": plan.id, "time": new_time, "created": created},
        status=201 if created else 200,
    )


@csrf_exempt
@require_POST
def name_plan(request, plan_id):
    """Set or rename a time block (the "cycle"). Recurring, every day.

    Body: {"name": "<str>"}. The name is trimmed; an empty string (after trim)
    clears it, so the block goes back to looking unnamed. Naming is cosmetic — the
    block is still keyed/grouped by its time — so this only writes Plan.name.
    Returns {"id": plan_id, "name": <saved name>}.
    """
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    name = body.get("name")
    if not isinstance(name, str):
        return JsonResponse({"error": "'name' must be a string."}, status=400)
    name = name.strip()
    if len(name) > 100:
        return JsonResponse(
            {"error": "'name' must be at most 100 characters."}, status=400
        )

    try:
        plan = Plan.objects.get(id=plan_id)
    except Plan.DoesNotExist:
        return JsonResponse({"error": f"Unknown plan id: {plan_id}."}, status=400)

    plan.name = name
    plan.save(update_fields=["name"])
    return JsonResponse({"id": plan.id, "name": plan.name})


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
        "is_support": habit.is_support,
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
    """Create a habit. Body: {"name", "notes"?, "area"?, "is_support"?}.

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

    is_support = body.get("is_support", False)
    if not isinstance(is_support, bool):
        return JsonResponse({"error": "'is_support' must be true or false."}, status=400)

    habit = Habit.objects.create(
        name=name, notes=notes.strip(), area_id=area_id, is_support=is_support
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

    if "is_support" in body:
        if not isinstance(body["is_support"], bool):
            return JsonResponse({"error": "'is_support' must be true or false."}, status=400)
        habit.is_support = body["is_support"]

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
# `Schedule.routine` — a habit can be in a routine or not. A routine's "done"
# state is NEVER stored:
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

    # distinct(): a habit with several tier-slots in this routine must be logged
    # once, not once per slot (which would duplicate its untiered row).
    habit_ids = list(
        Schedule.objects.filter(routine=routine)
        .values_list("habit_id", flat=True).distinct()
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

    Each habit carries its tier ladder (`_habit_tiers`, low->high, each entry
    {level,name,value,status,done} for today; [] if untiered) and a habit-level
    `status` — the whole-habit view (done if any version is done).
    """
    today = timezone.localdate()
    day_logs = _day_logs(today)

    # Override the model's default ordering (which JOINs Schedule -> duplicates):
    # hand-picked Habit.order first (unplaced habits are null -> sort last), then
    # area/name as the stable fallback. Ordering by Habit fields drops that join,
    # so each habit still appears exactly once.
    habits = Habit.objects.select_related("area").order_by(
        F("order").asc(nulls_last=True), "area__name", "name"
    )

    data = []
    for habit in habits:
        bucket = day_logs.get(habit.id)
        specific = bucket["specific"] if bucket else {}
        fallback = bucket["fallback"] if bucket else None

        tiers = _habit_tiers(habit)
        for t in tiers:
            st = _version_status(specific, fallback, t["level"], is_past=False)
            t["status"] = st
            t["done"] = st == HabitLog.Status.COMPLETED

        data.append({
            "id": habit.id,
            "name": habit.name,
            "area": habit.area_id,
            "area_name": habit.area.name if habit.area_id else None,
            "is_support": habit.is_support,
            "tiers": tiers,                        # per-version, [] if untiered
            # whole-habit status: done if any version done, else skip/missed/pending
            "status": _version_status(specific, fallback, None, is_past=False),
        })

    return JsonResponse(data, safe=False)


@csrf_exempt
@require_POST
def reorder_habits(request):
    """Persist a new top-to-bottom order for the Habits page in one shot.

    Body: {"items": [{"id": <habit_id>, "order": <n>}, ...]} — the whole list
    with each habit's new position. Sending the full list (not "move X up one")
    keeps it idempotent and avoids renumbering neighbours one at a time. Mirrors
    reorder_schedules, but the position lives on Habit, because the Habits page
    lists habits, not schedule slots.
    """
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    items = body.get("items")
    if not isinstance(items, list) or not items:
        return JsonResponse({"error": "'items' must be a non-empty list."}, status=400)

    # Validate everything before touching the DB, so a bad item can't leave a
    # half-applied order behind.
    cleaned = []
    for item in items:
        if not isinstance(item, dict):
            return JsonResponse({"error": "Each item must be an object."}, status=400)
        hid, order = item.get("id"), item.get("order")
        # bool is a subclass of int, so reject it explicitly.
        if not isinstance(hid, int) or isinstance(hid, bool) \
                or not isinstance(order, int) or isinstance(order, bool):
            return JsonResponse(
                {"error": "Each item needs an integer 'id' and 'order'."}, status=400
            )
        cleaned.append({"id": hid, "order": order})

    habits = Habit.objects.in_bulk([e["id"] for e in cleaned])
    missing = [e["id"] for e in cleaned if e["id"] not in habits]
    if missing:
        return JsonResponse({"error": f"Unknown habit ids: {missing}."}, status=400)

    for e in cleaned:
        habits[e["id"]].order = e["order"]

    # One UPDATE for the whole batch, all-or-nothing.
    with transaction.atomic():
        Habit.objects.bulk_update(habits.values(), ["order"])

    updated = [
        {"id": h.id, "order": h.order}
        for h in sorted(habits.values(), key=lambda h: h.order)
    ]
    return JsonResponse({"updated": updated})


def areas(request):
    areas = Area.objects.all().order_by('name')
    data = list(areas.values('id', 'name'))
    return JsonResponse(data, safe=False)


def area(request, area_id):
    area = Area.objects.get(id=area_id)
    habits = area.habit_set.order_by('-date_added')
    data = list(habits.values('id', 'name', 'notes'))
    return JsonResponse({"area": area.name, "habits": data})
