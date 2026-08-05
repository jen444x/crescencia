import json
from collections import defaultdict
from datetime import time as dt_time, timedelta

from django.core.exceptions import MultipleObjectsReturned
from django.db import transaction
from django.db.models import F, Max, Prefetch, Q
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_time
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from .models import Area, Aspiration, Routine, Habit, Chain, ChainDay, ChainTime, Schedule, ScheduleDay, HabitLog, HabitPause, Note, JournalEntry, Tier, TierChoices, HabitTier, TierValue, Version

# Derived (never stored) status: once a day is over, a habit that was never
# completed or skipped reads as "missed". It's computed at read time, so there's
# no MISSED row to create and clients never POST it — log_habit only accepts the
# three real HabitLog.Status values.
MISSED_STATUS = "MISSED"

# Photograph-on-open catch-up window. Every /chains/ load freezes the last N past
# days that were lived but never opened, so a later plan edit can't rewrite them
# (see freeze_day). This is the no-infra alternative to a nightly Railway sweep:
# the user opens the app ~daily, so this catches yesterday-and-back.
FREEZE_CATCHUP_DAYS = 7


def _paused_habit_ids(target_date):
    """Habit ids that were PAUSED on `target_date` — any HabitPause window covers
    it: ``start_date <= date AND (end_date is null OR date < end_date)`` (end is
    exclusive: active again ON end_date). Used to drop retired habits from the
    schedule for that date — the date-aware "is it retired by then" twin of the
    date_added "did it exist yet" rule.

    Reading full windows (not the single `Habit.ended_on`) is what makes resume
    safe: a CLOSED past window keeps the habit off those days forever, so resuming
    (which clears ended_on) can never resurrect a paused day as "missed". Returns
    a lazy queryset of ids — pass straight to ``__in`` (subquery) or wrap in
    ``set()`` for an in-Python membership check.
    """
    return (
        HabitPause.objects.filter(start_date__lte=target_date)
        .filter(Q(end_date__isnull=True) | Q(end_date__gt=target_date))
        .values_list("habit_id", flat=True)
    )


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
    """This habit's ladder rungs low->high: [{level, name, value, version}, ...].

    Sourced from the Version table (was HabitTier + TierValue). `level` is the
    per-habit ladder position (1..N) the cascade orders by; `name` is the OPTIONAL
    Roots/Growth tag ("" when the rung is untagged, e.g. a 2000 between a Roots
    1000 and a Growth 6000); `value` is the rung text; `version` is the rung id a
    log/completion keys on. [] for a plain habit (no rungs). The field is still
    called `tiers` on the wire for now — same shape the frontend already reads,
    plus the `version` id and a possibly-empty `name`."""
    rungs = []
    for v in habit.versions.select_related("label").order_by("level"):
        rungs.append({
            "level": v.level,
            "name": v.label.get_level_display() if v.label_id else "",
            "label": v.label.level if v.label_id else None,  # tag level 1/2/3, or null
            "value": v.value,
            "version": v.id,
        })
    return rungs


def _aspirations_by_habit():
    """habit_id -> [{"id", "color"}, ...] ascending by id, one query over the
    M2M. `color` is the aspiration's chosen bloom index (null = its id-based
    default); the frontend colors the dots from it. Ascending order keeps a
    habit's dots stable everywhere they render."""
    by_habit = defaultdict(list)
    for habit_id, asp_id, color in (
        Aspiration.objects.order_by("id").values_list("habits__id", "id", "color")
    ):
        if habit_id is not None:   # an aspiration with no habits yields (None, id)
            by_habit[habit_id].append({"id": asp_id, "color": color})
    return by_habit


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
    ).values_list("habit_id", "version__level", "status", "notes"):
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
    slot — the generation-aware projection both `/chains/`'s live path and
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
        # Symmetric "no longer applies" twin of the date_added rule above: a habit
        # PAUSED on this date (some HabitPause window covers it) drops out of the
        # projection, so it leaves the Plan and stops generating "missed". Reading
        # windows (not Habit.ended_on) means a CLOSED past window keeps the habit
        # off those days even after resume — history can't be rewritten.
        .exclude(habit_id__in=_paused_habit_ids(target_date))
        .select_related("habit", "routine", "tier")
        # Greatest valid_from (then id) last, so the dict write below keeps the
        # latest generation per slot.
        .order_by("valid_from", "id")
    )
    by_slot = {}
    for s in rows:
        by_slot[(s.habit_id, s.tier_id)] = s
    return list(by_slot.values())


def _chain_times_for_date(target_date):
    """The recurring time in effect for `target_date` per cycle, from `ChainTime` —
    the forward-time twin of `_effective_schedules`'s placement projection.

    `ChainTime` is the "this and every following day" time change (vs `ChainDay`'s
    one-day shift). A cycle can have several rows over time; for a given date we
    keep the one with the GREATEST `valid_from <= target_date` (id breaks a
    same-day tie, last write wins), so a forward retime sticks from its date on
    and an older one keeps covering earlier dates. Returns `{chain_id: start_time}`
    — only cycles that have a ChainTime row in effect by this date appear.

    With ZERO `ChainTime` rows this is an empty dict, so every time read falls back
    exactly as before (Chain.start_time) — behavior is byte-identical to pre-Phase-3.
    """
    rows = (
        ChainTime.objects.filter(valid_from__lte=target_date)
        # Greatest valid_from (then id) last, so the dict write below keeps the
        # latest generation per chain.
        .order_by("valid_from", "id")
        .values_list("chain_id", "start_time")
    )
    by_chain = {}
    for chain_id, start_time in rows:
        by_chain[chain_id] = start_time
    return by_chain


def _effective_chain_times(target_date):
    """Each cycle's effective start time for `target_date`, with the full Phase-3
    precedence applied PER CYCLE:

        frozen day's ChainDay (this date)  >  latest ChainTime (valid_from <= date)
                                           >  Chain.start_time (the recurring time)

    `ChainDay` (the per-day layer — a "running late" shift, or the time locked in
    when a day freezes) wins for that specific date; otherwise the recurring
    forward-time (`ChainTime`) wins; otherwise the chain's own `start_time`. Returns
    `{chain_id: start_time}` for EVERY chain (timeless chains map to None).

    This is the single source the time reads share (`chains`, `freeze_day`,
    `shift_chains`) so they can never disagree. With zero ChainDay and zero ChainTime
    rows it returns `{p.id: p.start_time}` — identical to today's behavior.
    """
    day_overrides = dict(
        ChainDay.objects.filter(date=target_date).values_list("chain_id", "start_time")
    )
    forward_times = _chain_times_for_date(target_date)
    out = {}
    for p in Chain.objects.all():
        if p.id in day_overrides:
            out[p.id] = day_overrides[p.id]            # per-day layer wins for this date
        elif p.id in forward_times:
            out[p.id] = forward_times[p.id]            # recurring forward-time
        else:
            out[p.id] = p.start_time                   # the chain's own recurring time
    return out


@transaction.atomic
def freeze_day(target_date):
    """Snapshot a day's current template arrangement into `ScheduleDay` (and lock
    each block's time into `ChainDay`) — the "photo" that makes a day immutable.

    Idempotent: a day is "frozen" exactly when it has `ScheduleDay` rows, so if
    any already exist we leave everything alone. Otherwise we copy the day's
    effective `Schedule` arrangement — the same rows `/chains/` would project for
    that date (only habits that existed by then, every tier-slot) — into
    `ScheduleDay`, snapshotting `habit_name` so a later habit-delete can't blank
    out the history. We also write a `ChainDay` per block at that block's effective
    time for the day (its existing override if present, else the recurring time),
    so the frozen time travels in `time_by_chain` exactly like the arrangement does.

    Returns a ``{schedule_id: scheduleday_id}`` map for the rows just created
    (empty if the day was already frozen), so a caller mid-freeze — like
    `arrange_day` on a not-yet-frozen day — can translate template ids it was
    handed into the ScheduleDay ids it must now edit.
    """
    if ScheduleDay.objects.filter(date=target_date).exists():
        return {}   # already frozen — no-op, exactly like ChainDay's "no row" rule

    # The same set `/chains/` projects for this date: only habits that already
    # existed by then, and the generation in effect for the date (latest
    # valid_from <= target_date per slot) — see _effective_schedules.
    schedules = _effective_schedules(target_date)

    # Lock each block's time for the day. A chain's effective time is its existing
    # per-day override if one was set (a "running late" shift), else the recurring
    # forward-time in effect that day (ChainTime), else its plain recurring time —
    # the same Phase-3 precedence /chains/ reads (_effective_chain_times). Freezing
    # the resolved time means a later ChainTime edit can't rewrite this day's photo.
    # Timeless chains (no effective time) have nothing to freeze and are skipped.
    effective_times = _effective_chain_times(target_date)
    chain_ids = {s.chain_id for s in schedules if s.chain_id is not None}
    for pid in chain_ids:
        effective = effective_times.get(pid)
        if effective is None:
            continue
        ChainDay.objects.get_or_create(
            chain_id=pid, date=target_date, defaults={"start_time": effective}
        )

    # Copy every Schedule slot (including each tier-slot of a multi-tier habit)
    # into its ScheduleDay twin, recording the schedule->scheduleday id mapping.
    id_map = {}
    for s in schedules:
        sd = ScheduleDay.objects.create(
            date=target_date,
            habit=s.habit,
            habit_name=s.habit.name,
            chain_id=s.chain_id,
            routine_id=s.routine_id,
            tier_id=s.tier_id,
            order=s.order,
        )
        id_map[s.id] = sd.id
    return id_map


def plan(request):
    # Which day to show. Defaults to today; the day-browser passes
    # ?date=YYYY-MM-DD to view any other day. The chain/schedule layout is the
    # same every day — only each habit's status (its HabitLog for that day)
    # changes, so we just swap which date we look the statuses up for.
    target_date, date_error = _resolve_date(request.GET.get("date"))
    if date_error:
        return date_error

    # Once a day is over, a still-pending habit counts as a miss. We derive that
    # in habit_payload rather than storing it (see MISSED_STATUS).
    today = timezone.localdate()
    is_past_day = target_date < today

    # Photograph-on-open catch-up: every chains load also freezes the last
    # FREEZE_CATCHUP_DAYS days *before today* that aren't frozen yet, so a day the
    # user lived but never opened still gets its permanent photo before a later chain
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
    # as it was, so editing the recurring chain later can't rewrite it. Only PAST
    # days, only once (freeze_day is idempotent) — today is still being lived and a
    # future day is a deliberate pre-edit, so neither is auto-frozen on view.
    if is_past_day and not ScheduleDay.objects.filter(date=target_date).exists():
        freeze_day(target_date)

    # A day is "frozen" — read all-or-nothing from its ScheduleDay photo — ONLY when
    # it is in the PAST and has that photo. Past history must stay immutable: a later
    # chain edit can't rewrite a day already lived. TODAY and FUTURE days are NEVER
    # frozen for reads: they always follow the recurring template + any "going
    # forward" change, with any per-habit "just today" tweak LAYERED ON TOP per slot
    # (see the not-frozen path below) — exactly how time already layers ChainDay over
    # ChainTime over Chain.start_time. (A whole-day ScheduleDay snapshot may still exist
    # for today/future from an older freeze, but it is now treated as per-slot
    # overrides, not an all-or-nothing read.)
    is_frozen = is_past_day and ScheduleDay.objects.filter(date=target_date).exists()

    # That day's logs, grouped per habit into per-version buckets (logs are keyed
    # per VERSION now — see _day_logs / _version_status). Habits with no log
    # default to PENDING / "" via the helpers below.
    day_logs = _day_logs(target_date)

    # habit_id -> [aspiration ids, ascending] in ONE query, so every row can
    # carry which aspirations its habit serves (the frontend colors a bloom dot
    # per aspiration) without an N+1 over the M2M.
    asp_map = _aspirations_by_habit()

    # Each cycle's effective time for THIS day, with the full Phase-3 precedence:
    # this date's ChainDay (a "running late" shift, or the time a frozen day locked
    # in) > the recurring forward-time in effect (ChainTime) > the chain's recurring
    # start_time. With zero ChainDay and zero ChainTime rows this is just the plain
    # recurring times — unchanged from before Phase 3. (_effective_chain_times maps
    # EVERY chain, so the .get fallback below is only a defensive guard.)
    time_by_chain = _effective_chain_times(target_date)

    # The habit's tier list, each entry {level,name,value,status,done} for THIS
    # day, memoized so a habit with several tier-slots only builds it once. EVERY
    # /chains/ row carries it: the frontend reads per-version state (Root done /
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
            "aspirations": asp_map.get(habit.id, []),  # aspiration ids this habit serves
        }

    # The arrangement source differs by whether the day is frozen, but the payload
    # shape is IDENTICAL either way — the frontend can't tell which it got.
    #   - Frozen: read each habit's placement from this date's ScheduleDay rows
    #     (the saved photo), keyed for dnd on the ScheduleDay id (`row_id`).
    #   - Not frozen (today/future, no rows): project the live template `Schedule`,
    #     exactly as before, keyed on the Schedule id.
    # Statuses come from HabitLog/_version_status and the day's times from
    # time_by_chain (ChainDay) in BOTH paths — freeze just locks those ChainDay rows.
    by_chain = defaultdict(list)   # chain_id -> [habit_payload, ...]; None = "Anytime"

    if is_frozen:
        # Read the saved arrangement. order_by mirrors the template path: saved
        # position first (nulls last), id breaks ties for a stable list.
        for sd in (ScheduleDay.objects.filter(date=target_date)
                   .select_related("habit", "routine", "tier")
                   .order_by(F("order").asc(nulls_last=True), "id")):
            if sd.habit is None:
                continue   # habit deleted since the freeze; FK went null (history snapshot only)
            by_chain[sd.chain_id].append(
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
        # TODAY / FUTURE (never frozen): project the recurring template + any
        # "going forward" change (_effective_schedules), then OVERLAY each habit's
        # per-day "just today" tweak (its ScheduleDay row for this exact date) ON
        # TOP, per logical slot. This is the placement twin of how time layers
        # ChainDay > ChainTime > Chain.start_time: a slot with a ScheduleDay override
        # for this date uses that override's cycle/order; EVERY other slot keeps
        # following the template/forward arrangement. A one-habit "just today" move
        # therefore never locks the rest of the day.
        #
        # The slot key is (habit_id, tier_id) — the same key _effective_schedules,
        # ScheduleDay and HabitLog all version on. We merge by slot:
        #   - template slot with NO override -> the Schedule row (row_id = its id)
        #   - template slot WITH an override -> the ScheduleDay row (row_id = its id)
        #   - override slot NOT in the template (e.g. an Anytime habit dropped in
        #     "just today", which has no Schedule row) -> the ScheduleDay row
        # A ScheduleDay override may also move a slot to Anytime (chain=None); that's
        # carried through naturally as chain_id=None below.
        #
        # Only habits that already existed on the viewed day are shown: a habit you
        # add today shouldn't appear when you scroll back. (For today/future this is
        # a no-op.) _effective_schedules drops older generations per slot so a habit
        # moved "from D forward" shows in its NEW cycle from D and never twice.
        effective = _effective_schedules(target_date)
        paused_today = set(_paused_habit_ids(target_date))
        overrides = {
            (sd.habit_id, sd.tier_id): sd
            for sd in (ScheduleDay.objects.filter(date=target_date)
                       .select_related("habit", "routine", "tier"))
            # Skip a paused habit's leftover "just today" row too, or a stale
            # ScheduleDay from an earlier same-day freeze would resurrect it on the
            # live day after it was stopped (same pause-window rule as _effective_schedules).
            if sd.habit_id is not None and sd.habit_id not in paused_today
        }

        # Build the merged placement list. Each entry is a small uniform record so
        # the same sort/emit handles a template row and an override row. `kind`
        # marks which so we key row_id correctly (Schedule id vs ScheduleDay id).
        merged = []
        for schedule in effective:
            slot = (schedule.habit_id, schedule.tier_id)
            if slot in overrides:
                continue   # the per-day override below replaces this template slot
            merged.append({
                "habit": schedule.habit,
                "chain_id": schedule.chain_id,
                "routine_id": schedule.routine_id,
                "routine_name": schedule.routine.name if schedule.routine_id else None,
                "order": schedule.order,
                "tier": schedule.tier,
                "row_id": schedule.id,        # template slot -> Schedule id
                "schedule_id": schedule.id,
            })
        for sd in overrides.values():
            merged.append({
                "habit": sd.habit,
                "chain_id": sd.chain_id,
                "routine_id": sd.routine_id,
                "routine_name": sd.routine.name if sd.routine_id else None,
                "order": sd.order,
                "tier": sd.tier,
                "row_id": sd.id,              # overridden slot -> ScheduleDay id
                "schedule_id": None,          # this slot reads from its per-day row
            })

        # Saved position first (nulls last), id breaks ties for a stable list —
        # mirrors the frozen/template orderings.
        merged.sort(key=lambda m: (m["order"] is None, m["order"] or 0, m["row_id"]))
        for m in merged:
            by_chain[m["chain_id"]].append(
                habit_payload(
                    m["habit"],
                    schedule_id=m["schedule_id"],
                    row_id=m["row_id"],
                    routine=m["routine_id"],
                    routine_name=m["routine_name"],
                    order=m["order"],
                    tier=m["tier"],   # this slot's tier (None = untiered slot)
                )
            )

    # One group per time block. The not-frozen path emits EVERY Chain (so an empty
    # block still renders, as before); the frozen path emits only blocks that had
    # habits that day (an empty block left no ScheduleDay rows to remember).
    if is_frozen:
        chain_rows = Chain.objects.filter(
            id__in=[pid for pid in by_chain if pid is not None]
        )
    else:
        chain_rows = Chain.objects.all()
    chain_groups = [
        {
            "id": p.id,
            "time": time_by_chain.get(p.id, p.start_time),  # the day's time
            "name": p.name,                                # the block's cycle name ("" if unnamed)
            "habits": by_chain.get(p.id, []),
        }
        for p in chain_rows
    ]

    # Sort by the day's effective time so a pushed-back cycle slides down the
    # list (the frontend trusts this order). Timeless chains go last; id breaks
    # ties for a stable order.
    chain_groups.sort(key=lambda g: (g["time"] is None, g["time"] or dt_time.min, g["id"]))

    # The "Anytime" group: habits with no placement this day. Frozen = any
    # ScheduleDay row sitting in no chain (placed at Anytime that day) PLUS habits
    # that were never placed at all (no ScheduleDay/Schedule row); not frozen =
    # habits with no EFFECTIVE Schedule row at all for this date. We key off the
    # generation actually in effect (not `schedule__isnull`), so a habit whose only
    # Schedule row is a future generation (valid_from > T) correctly sits in Anytime
    # for earlier dates. Same "existed by then" rule, always last.
    if is_frozen:
        # The day's photo (ScheduleDay) only ever snapshotted habits that HAD an
        # effective Schedule placement when it froze — a never-placed habit has no
        # Schedule row, so it got no ScheduleDay row and would silently vanish the
        # moment a day freezes (e.g. the first drag). Mirror the not-frozen fallback
        # below: also surface habits that existed by this date but sit in NO
        # ScheduleDay row for the day (any cycle, incl. Anytime) and have no
        # effective Schedule placement either. `placed_ids` is every habit already
        # accounted for, so this never double-lists one already shown (in a cycle or
        # in the chain=None Anytime list).
        placed_ids = {
            sd.habit_id
            for sd in ScheduleDay.objects.filter(date=target_date)
            if sd.habit_id is not None
        }
        placed_ids |= {s.habit_id for s in _effective_schedules(target_date)}
        unscheduled = Habit.objects.filter(
            date_added__date__lte=target_date
        ).exclude(id__in=placed_ids).exclude(
            id__in=_paused_habit_ids(target_date)  # drop habits paused on this date
        )
        anytime_habits = by_chain.get(None, []) + [
            habit_payload(h) for h in unscheduled
        ]
    else:
        # Two sources, both legitimately "Anytime" on a not-frozen day:
        #   - merged rows whose effective placement has chain=None (a habit placed at
        #     Anytime via a forward-write OR moved there "just today" by an override)
        #     — already in by_chain[None]
        #   - habits with NO effective placement at all for this date (no template
        #     Schedule row AND no per-day override row)
        # `placed_ids` is every habit that appears in `merged` (template or override),
        # so the second query excludes those (whichever cycle, incl. Anytime) and
        # won't double-list one already shown.
        placed_ids = {m["habit"].id for m in merged}
        unscheduled = Habit.objects.filter(
            date_added__date__lte=target_date
        ).exclude(id__in=placed_ids).exclude(
            id__in=_paused_habit_ids(target_date)  # drop habits paused on this date
        )
        anytime_habits = by_chain.get(None, []) + [
            habit_payload(h) for h in unscheduled
        ]
    data = chain_groups + [{
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

    Body: {"status"?, "notes"?, "version"?: id, "tier"?: 1|2|3, "date"?: "..."} —
    send at least one of `status` / `notes`.
      - status: COMPLETED (complete) | PENDING (undo) | SKIPPED (skip) | MISSED.
      - version: WHICH rung this log is for (its id). Omit for a plain habit or a
        whole-habit action; a rung id writes that rung's row, so each rung is
        tracked independently (one row per habit/date/version). `tier` (1|2|3) is
        still accepted and mapped to the rung with that label, for back-compat.
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

    # WHICH rung this log is for — it keys the row (habit, date, version). Prefer
    # an explicit `version` id; accept a legacy `tier` level and resolve it to the
    # rung wearing that label (a version's level is renumbered per-habit, so we map
    # on the label, not the number). Omit both for a whole-habit action.
    raw_version = body.get("version")
    raw_tier = body.get("tier")
    version_obj = None
    if raw_version is not None:
        version_obj = (Version.objects.filter(habit=habit, id=raw_version)
                       .select_related("label").first())
        if version_obj is None:
            return JsonResponse(
                {"error": f"This habit has no version {raw_version}."}, status=400
            )
    elif raw_tier is not None:
        if raw_tier not in (1, 2, 3):
            return JsonResponse({"error": "'tier' must be 1, 2, or 3."}, status=400)
        version_obj = (Version.objects.filter(habit=habit, label__level=raw_tier)
                       .select_related("label").first())
        if version_obj is None:
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
    # version=None is the untiered/"whole habit" row; a rung is that one version.
    # `tier` is kept in sync from the rung's label (null for an untagged rung) as a
    # cross-check / rollback path until the P3 cleanup drops it.
    with transaction.atomic():
        log, _ = HabitLog.objects.get_or_create(
            habit=habit, date=target_date, version=version_obj,
            defaults={"tier_id": version_obj.label_id if version_obj else None},
        )
        if version_obj is not None and log.tier_id != version_obj.label_id:
            log.tier_id = version_obj.label_id

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
        "version": log.version_id,
        "tier": version_obj.level if version_obj else None,  # ladder position
        "status": log.status,
        "done_today": log.status == HabitLog.Status.COMPLETED,
        "notes": log.notes,
    })


@csrf_exempt
@require_POST
def save_habit_versions(request, habit_id):
    """Save a habit's whole ladder in one shot (the ladder editor's Save).

    Body: {"rungs": [{"id"?: version_id, "value": "1000 steps",
                      "label": 1|2|3|null}, ...]} — in ladder order, low -> high.

    Each rung's `level` becomes its POSITION (1..N), so the cascade always runs
    low->high and she never types a version number. A rung with an `id` updates
    that existing Version (keeping its history); a rung with no id is created; any
    of the habit's existing versions NOT listed is deleted (its logs SET_NULL back
    to whole-habit). A label (1=Roots, 2=Growth) may sit on at most ONE rung.
    Returns the saved {"tiers": [...]} — same shape /plan/ reads.
    """
    habit = get_object_or_404(Habit, id=habit_id)
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    rungs = body.get("rungs")
    if not isinstance(rungs, list):
        return JsonResponse({"error": "'rungs' must be a list."}, status=400)

    seen_labels = set()
    cleaned = []
    for i, r in enumerate(rungs):
        if not isinstance(r, dict):
            return JsonResponse({"error": "each rung must be an object."}, status=400)
        value = r.get("value", "")
        if not isinstance(value, str):
            return JsonResponse({"error": "'value' must be a string."}, status=400)
        label = r.get("label")
        if label not in (None, 1, 2, 3):
            return JsonResponse({"error": "'label' must be 1, 2, 3, or null."}, status=400)
        if label is not None:
            if label in seen_labels:
                return JsonResponse(
                    {"error": "A tag (Roots/Growth) can sit on only one rung."}, status=400
                )
            seen_labels.add(label)
        cleaned.append({"id": r.get("id"), "value": value.strip(),
                        "label": label, "level": i + 1})

    with transaction.atomic():
        existing = {v.id: v for v in habit.versions.all()}
        # Park existing levels out of the 1..N range first, so re-seating rungs to
        # their new positions can't trip unique(habit, level) mid-reconcile.
        habit.versions.update(level=F("level") + 1000)

        kept = set()
        for c in cleaned:
            tier = Tier.objects.get_or_create(level=c["label"])[0] if c["label"] else None
            v = existing.get(c["id"]) if c["id"] is not None else None
            if v is None:
                v = Version(habit=habit)
            v.level, v.value, v.label = c["level"], c["value"], tier
            v.save()
            kept.add(v.id)

        for vid, v in existing.items():
            if vid not in kept:
                # Removing a rung also removes ITS day-records — they meant "I hit
                # this specific amount", which no longer exists as a rung. (We can't
                # just SET_NULL them onto the whole-habit row: the per-day
                # uniqueness would reject a day that already has one.) Relabel a
                # rung instead of deleting it to keep its history.
                HabitLog.objects.filter(version=v).delete()
                v.delete()

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

    # Only habits that APPLIED on that day (same rule /chains/ uses): created by
    # then and not paused on that day, so a blanket skip never touches a habit
    # that was stopped. .order_by() clears the model's default (Schedule-joining)
    # ordering, so a habit with several tier-slots isn't returned once per slot —
    # which would make the blanket skip try to write duplicate untiered rows.
    habit_ids = list(
        Habit.objects.filter(date_added__date__lte=target_date)
        .exclude(id__in=_paused_habit_ids(target_date))
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
      - that day's time shifts (its ChainDay overrides), and
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
        # "no row = use the template" default, just like clearing ChainDay returns
        # its times to the recurring chain. Completions survive (they're HabitLogs,
        # not ScheduleDay rows).
        arrangement_cleared = ScheduleDay.objects.filter(date=target_date).delete()[0]
        shifts_cleared = ChainDay.objects.filter(date=target_date).delete()[0]
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

    `chain` (optional) moves a row into another time block — its value is the
    target Chain's id. That's the cross-block drag: the moved row is sent with its
    new `chain`, usually alongside `routine` null (a same-block tag). Omit `chain`
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
        if "chain" in item:
            # Move this row into another time block (cross-block drag). A real
            # chain id only — null ("drop to Anytime") is a delete, handled
            # elsewhere, not here.
            p = item["chain"]
            if not isinstance(p, int) or isinstance(p, bool):
                return JsonResponse(
                    {"error": "'chain' must be a chain id (integer)."}, status=400
                )
            entry["chain"] = p
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

    chain_ids = {e["chain"] for e in cleaned if "chain" in e}
    if chain_ids:
        known = set(Chain.objects.filter(id__in=chain_ids).values_list("id", flat=True))
        unknown = sorted(chain_ids - known)
        if unknown:
            return JsonResponse({"error": f"Unknown chain ids: {unknown}."}, status=400)

    # Map tier level (1/2/3) -> Tier row id, for any items setting a slot's tier.
    tier_by_level = {t.level: t.id for t in Tier.objects.all()}

    fields = {"order"}
    for e in cleaned:
        schedule = schedules[e["id"]]
        schedule.order = e["order"]
        if "routine" in e:
            schedule.routine_id = e["routine"]
            fields.add("routine")
        if "chain" in e:
            schedule.chain_id = e["chain"]
            fields.add("chain")
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
# RETIRED (apply-to-future Phase 0): no URL route; pending Phase 2 fold-in.
def create_schedule(request):
    """Place an unscheduled habit onto the timeline.

    Body: {"habit": <id>, "chain": <id>, "order"?: <int>}. Creates the Schedule
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
    chain_id = body.get("chain")
    # bool is a subclass of int, so reject it explicitly.
    if not isinstance(habit_id, int) or isinstance(habit_id, bool):
        return JsonResponse({"error": "'habit' must be a habit id (integer)."}, status=400)
    if not isinstance(chain_id, int) or isinstance(chain_id, bool):
        return JsonResponse({"error": "'chain' must be a chain id (integer)."}, status=400)

    if not Habit.objects.filter(id=habit_id).exists():
        return JsonResponse({"error": f"Unknown habit id: {habit_id}."}, status=400)
    if not Chain.objects.filter(id=chain_id).exists():
        return JsonResponse({"error": f"Unknown chain id: {chain_id}."}, status=400)

    order = body.get("order")
    if order is not None and (not isinstance(order, int) or isinstance(order, bool)):
        return JsonResponse({"error": "'order' must be an integer."}, status=400)
    if order is None:
        # Append: one past the block's current highest order (1 if it's empty).
        highest = Schedule.objects.filter(chain_id=chain_id).aggregate(m=Max("order"))["m"]
        order = (highest or 0) + 1

    schedule = Schedule.objects.create(habit_id=habit_id, chain_id=chain_id, order=order)
    return JsonResponse(
        {"schedule_id": schedule.id, "habit": habit_id, "chain": chain_id, "order": order},
        status=201,
    )


@csrf_exempt
@require_POST
def arrange_day(request):
    """Reorder / move / place habits for ONE day only — the per-day twin of
    reorder_schedules + create_schedule. Writes `ScheduleDay`, NEVER `Schedule`,
    so an edit here sticks to that date and can't rewrite the recurring chain.

    Body: {"date": "YYYY-MM-DD", "items": [...]}. Each item is the SAME shape as
    reorder_schedules, except `id` is the row's `row_id` (from /chains/):

        {"id": 11, "order": 2, "routine": 3}    # reorder/retag an existing row
        {"id": 12, "order": 3, "chain": 7}      # move it to another block, that day
        {"habit": 9, "chain": 7, "order"?: 4}   # NEW per-day placement: drop a habit
                                                #   from "Anytime" into a block, today only

    `routine` / `tier` / `chain` are only changed when their key is present (null
    clears the tag); `tier` takes a level 1/2/3 or null.

    Only PAST days lock. The write path forks on whether the edited day is in the
    past:

      * PAST day -> freeze the WHOLE day first (idempotent ScheduleDay snapshot),
        then translate the client's template Schedule ids through the freeze map to
        the ScheduleDay rows and apply the moves. A past day is real history, so it
        reads all-or-nothing from its photo; editing it edits that photo. (Behavior
        unchanged from before.)

      * TODAY / FUTURE day -> NEVER freeze the whole day. Today and future always
        follow the recurring template + "going forward" change; an edit here is a
        per-habit "just today" tweak LAYERED ON TOP, so we create/update a
        ScheduleDay OVERRIDE row ONLY for each habit actually moved/placed and leave
        every other habit following the template. Moving one habit "just today" must
        NOT lock the rest of the day. The override (the per-day layer) WINS over a
        forward change for that habit on that date — same precedence as
        ChainDay > ChainTime.

    A move's `id` is the row's `row_id` from /chains/: on today/future that's the
    ScheduleDay id if the slot already has an override for the date, else the
    template Schedule id. We disambiguate by checking ScheduleDay-for-this-date
    first (the exact reverse of what /chains/ emitted), then fall back to resolving a
    Schedule id to its slot and upserting the override.
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
            pid = item.get("chain")
            # bool is a subclass of int, so reject it explicitly.
            if not isinstance(hid, int) or isinstance(hid, bool):
                return JsonResponse(
                    {"error": "A placement needs an integer 'habit' id."}, status=400
                )
            if not isinstance(pid, int) or isinstance(pid, bool):
                return JsonResponse(
                    {"error": "A placement needs an integer 'chain' id."}, status=400
                )
            entry["habit"] = hid
            entry["chain"] = pid
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
            # Any key we don't read below (e.g. the pre-rename "plan") is ignored,
            # not 400'd, so an older client's stray field can't break the reorder.
            if "routine" in item:
                entry["routine"] = item["routine"]   # None or a routine id
            if "chain" in item:
                # Move this row into another time block (cross-block drag), that
                # day only. A real chain id only — null ("drop to Anytime") clears
                # the placement, so we allow it here (no row off-chain = Anytime).
                p = item["chain"]
                if p is not None and (not isinstance(p, int) or isinstance(p, bool)):
                    return JsonResponse(
                        {"error": "'chain' must be a chain id (integer) or null."}, status=400
                    )
                entry["chain"] = p
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

    chain_ids = {e["chain"] for e in moves if "chain" in e and e["chain"] is not None}
    chain_ids |= {e["chain"] for e in places}
    if chain_ids:
        known = set(Chain.objects.filter(id__in=chain_ids).values_list("id", flat=True))
        unknown = sorted(chain_ids - known)
        if unknown:
            return JsonResponse({"error": f"Unknown chain ids: {unknown}."}, status=400)

    habit_ids = {e["habit"] for e in places}
    if habit_ids:
        known = set(Habit.objects.filter(id__in=habit_ids).values_list("id", flat=True))
        unknown = sorted(habit_ids - known)
        if unknown:
            return JsonResponse({"error": f"Unknown habit ids: {unknown}."}, status=400)

    # Map tier level (1/2/3) -> Tier row id, for any items setting a slot's tier.
    tier_by_level = {t.level: t.id for t in Tier.objects.all()}

    # Only PAST days lock (freeze the whole day); today/future stay template-driven
    # and an edit is a per-habit override layered on top.
    today = timezone.localdate()
    is_past_day = target_date < today

    # A bad row id must NOT leave the day half-edited (or, on a past day, frozen).
    # We signal it with this exception so the atomic block rolls the whole thing
    # back, then turn it into a clean 400 outside.
    class _BadRowId(Exception):
        def __init__(self, row_id):
            self.row_id = row_id

    try:
        with transaction.atomic():
            if is_past_day:
                # PAST day: freeze the whole day (idempotent), then resolve each
                # move's id to a ScheduleDay row. On a not-yet-frozen past day the
                # client's ids are template Schedule ids, translated through the
                # freeze map; on an already-frozen one they're ScheduleDay ids.
                was_frozen = ScheduleDay.objects.filter(date=target_date).exists()
                freeze_map = freeze_day(target_date)   # {schedule_id: scheduleday_id}; {} if frozen

                resolved = []   # (ScheduleDay id, entry) pairs to apply
                for e in moves:
                    sd_id = e["id"] if was_frozen else freeze_map.get(e["id"])
                    if sd_id is None:
                        # A Schedule id that wasn't part of the freeze (e.g. a habit
                        # that didn't exist on that day, so it has no row).
                        raise _BadRowId(e["id"])
                    resolved.append((sd_id, e))

                rows = ScheduleDay.objects.in_bulk([sd_id for sd_id, _ in resolved])
                # A ScheduleDay id the client sent that doesn't exist.
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
                    if "chain" in e:
                        row.chain_id = e["chain"]
                        fields.add("chain")
                    if "tier" in e:
                        row.tier_id = (
                            tier_by_level.get(e["tier"]) if e["tier"] is not None else None
                        )
                        fields.add("tier")
                if rows:
                    ScheduleDay.objects.bulk_update(rows.values(), list(fields))
                touched = list(rows.values())
            else:
                # TODAY / FUTURE: never freeze the whole day. Each move becomes a
                # per-habit override (one ScheduleDay row for the moved slot only),
                # so every untouched habit keeps following the template. The move's
                # id is either an existing override (ScheduleDay-for-this-date) or a
                # template Schedule id — disambiguate by checking the former first,
                # exactly reversing what /chains/ emitted.
                existing_overrides = ScheduleDay.objects.in_bulk(
                    [e["id"] for e in moves], field_name="id"
                )
                existing_overrides = {
                    sd_id: sd for sd_id, sd in existing_overrides.items()
                    if sd.date == target_date
                }
                # Template Schedule rows for any ids that aren't existing overrides.
                template_ids = [e["id"] for e in moves if e["id"] not in existing_overrides]
                template_rows = Schedule.objects.in_bulk(template_ids) if template_ids else {}

                touched = []
                for e in moves:
                    rid = e["id"]
                    if rid in existing_overrides:
                        # An override already exists for this slot/date: edit it.
                        row = existing_overrides[rid]
                    else:
                        # A template Schedule id: seed a fresh per-day override from
                        # the template slot (so an order-only move keeps the slot in
                        # its template block), keyed on the slot's (habit, tier).
                        sched = template_rows.get(rid)
                        if sched is None:
                            raise _BadRowId(rid)
                        row, _ = ScheduleDay.objects.get_or_create(
                            date=target_date,
                            habit_id=sched.habit_id,
                            tier_id=sched.tier_id,
                            defaults={
                                "habit_name": sched.habit.name,
                                "chain_id": sched.chain_id,
                                "routine_id": sched.routine_id,
                                "order": sched.order,
                            },
                        )
                    # Apply the move to this override row (the per-day layer).
                    row.order = e["order"]
                    if "routine" in e:
                        row.routine_id = e["routine"]
                    if "chain" in e:
                        row.chain_id = e["chain"]
                    if "tier" in e:
                        row.tier_id = (
                            tier_by_level.get(e["tier"]) if e["tier"] is not None else None
                        )
                    row.save()
                    touched.append(row)

            # New per-day placements: a habit dragged from Anytime that has no row
            # this day. Create a ScheduleDay row for it (mirrors create_schedule's
            # append logic, on the per-day layer), snapshotting habit_name. Same on
            # past and today/future: a placement is always a per-day override.
            habit_names = dict(
                Habit.objects.filter(id__in=habit_ids).values_list("id", "name")
            )
            created = []
            # For appending on today/future, the block also shows TEMPLATE habits
            # (no override yet), so "append to the bottom" must clear the highest
            # EFFECTIVE order in that block — template Schedule rows in effect for
            # this date PLUS any ScheduleDay overrides — not just the override rows.
            # On a past (frozen) day the day reads all-or-nothing from ScheduleDay,
            # so only those rows count (template_max stays empty).
            template_max_by_chain = {}
            if not is_past_day:
                for s in _effective_schedules(target_date):
                    # The slot's effective placement is its override if one exists.
                    # We only need a ceiling, so the template order is a safe lower
                    # bound even when an override moved the slot elsewhere.
                    if s.chain_id is not None and s.order is not None:
                        cur = template_max_by_chain.get(s.chain_id)
                        if cur is None or s.order > cur:
                            template_max_by_chain[s.chain_id] = s.order
            for e in places:
                order = e["order"]
                if order is None:
                    # Append: one past this block's current highest order that day,
                    # across overrides and (today/future) the template.
                    highest_sd = ScheduleDay.objects.filter(
                        date=target_date, chain_id=e["chain"]
                    ).aggregate(m=Max("order"))["m"]
                    highest = max(
                        highest_sd or 0, template_max_by_chain.get(e["chain"], 0)
                    )
                    order = highest + 1
                sd = ScheduleDay.objects.create(
                    date=target_date,
                    habit_id=e["habit"],
                    habit_name=habit_names[e["habit"]],
                    chain_id=e["chain"],
                    order=order,
                )
                created.append(sd)
    except _BadRowId as bad:
        return JsonResponse(
            {"error": f"Unknown row id for this day: {bad.row_id}."}, status=400
        )

    # Return the day's updated arrangement (touched + created rows), like
    # reorder_schedules. `touched` is set in both branches above (moved/edited
    # override rows); `created` is the new per-day placements.
    all_rows = touched + created
    updated = [
        {"id": sd.id, "order": sd.order, "chain": sd.chain_id, "routine": sd.routine_id}
        for sd in sorted(all_rows, key=lambda sd: (sd.order is None, sd.order or 0, sd.id))
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
            {"habit": 9, "chain": 7, "tier": 2|null, "order": 1},
            {"habit": 3, "chain": null, "order": 2},   # chain null = Anytime
            ...
          ]
        }

    For each item we UPSERT a `Schedule` row at `valid_from = from_date` for the
    logical slot (habit, tier), setting its chain + order (+ routine if sent). Send
    the WHOLE affected cycle(s) as fresh 1..N orders — whole-list & idempotent, the
    pattern reorder used. We NEVER touch earlier-generation rows: they keep covering
    dates < from_date. Re-running the same edit UPDATEs the from_date generation
    (matched on (habit, tier, valid_from)) instead of duplicating it.

    Moving a habit to a new cycle needs nothing more than writing its new
    (chain, order) at from_date: the per-slot read (_effective_schedules) drops the
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
        # `chain` is REQUIRED for a placement (which cycle), but null is allowed and
        # means "Anytime" (no block) — the forward twin of arrange_day's
        # null-chain-clears behavior.
        if "chain" not in item:
            return JsonResponse(
                {"error": "Each item needs a 'chain' (id or null)."}, status=400
            )
        p = item["chain"]
        if p is not None and (not isinstance(p, int) or isinstance(p, bool)):
            return JsonResponse(
                {"error": "'chain' must be a chain id (integer) or null."}, status=400
            )
        entry["chain"] = p
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

    # A coherent arrangement places each logical slot (habit + tier) exactly once.
    # Two items naming the SAME slot would upsert the same Schedule row twice in
    # one pass (last-write-wins, silently dropping the first) — reject it up front,
    # before any DB write, so a malformed payload can't half-apply a generation.
    seen_slots = set()
    for e in cleaned:
        slot = (e["habit"], e["tier"])
        if slot in seen_slots:
            return JsonResponse(
                {"error": "Each (habit, tier) slot may appear at most once in 'items'."},
                status=400,
            )
        seen_slots.add(slot)

    # Validate referenced foreign keys up front.
    habit_ids = {e["habit"] for e in cleaned}
    known = set(Habit.objects.filter(id__in=habit_ids).values_list("id", flat=True))
    unknown = sorted(habit_ids - known)
    if unknown:
        return JsonResponse({"error": f"Unknown habit ids: {unknown}."}, status=400)

    chain_ids = {e["chain"] for e in cleaned if e["chain"] is not None}
    if chain_ids:
        known_p = set(Chain.objects.filter(id__in=chain_ids).values_list("id", flat=True))
        unknown_p = sorted(chain_ids - known_p)
        if unknown_p:
            return JsonResponse({"error": f"Unknown chain ids: {unknown_p}."}, status=400)

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
    try:
        with transaction.atomic():
            for e in cleaned:
                tier_id = (
                    tier_by_level.get(e["tier"]) if e["tier"] is not None else None
                )
                defaults = {"chain_id": e["chain"], "order": e["order"]}
                if "routine" in e:
                    defaults["routine_id"] = e["routine"]
                # UPSERT the from_date generation of this slot (habit, tier):
                # re-running the same forward edit updates it rather than
                # duplicating it. There's no DB unique constraint on
                # (habit, tier, valid_from) — the migration is kept purely
                # additive — so pre-existing duplicate rows (legacy/edge data on
                # Railway) would make update_or_create raise MultipleObjectsReturned.
                # Catch it (below) and 409 rather than 500, leaving the data
                # untouched for a human to reconcile.
                sched, _ = Schedule.objects.update_or_create(
                    habit_id=e["habit"],
                    tier_id=tier_id,
                    valid_from=from_date,
                    defaults=defaults,
                )
                written.append(sched)

                if reflect_today:
                    # Keep today (frozen) in sync so "every day from today"
                    # visibly includes today. Upsert the matching ScheduleDay
                    # slot. (ScheduleDay has a real (date, habit, tier) unique
                    # constraint, so this branch can't itself dup; the catch
                    # below still covers it defensively.)
                    sd_defaults = {
                        "chain_id": e["chain"],
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
    except MultipleObjectsReturned:
        # A pre-existing duplicate (habit, tier, valid_from) row means this slot's
        # generation is ambiguous — update_or_create can't pick one. The atomic
        # block has rolled back, so nothing was written. Surface a clear 409 (a
        # conflict in stored data) instead of an opaque 500.
        return JsonResponse(
            {
                "error": (
                    "This slot has duplicate schedule rows for the same date; "
                    "the arrangement was not saved. Please reconcile the data."
                )
            },
            status=409,
        )

    updated = [
        {
            "id": s.id,
            "habit": s.habit_id,
            "chain": s.chain_id,
            "tier": s.tier.level if s.tier_id else None,
            "order": s.order,
            "valid_from": s.valid_from.isoformat(),
        }
        for s in sorted(written, key=lambda s: (s.order is None, s.order or 0, s.id))
    ]
    return JsonResponse({"from_date": from_date.isoformat(), "updated": updated})


@csrf_exempt
@require_POST
def create_chain(request):
    """Create a new (empty) time block, or reuse the one at that time.

    Body: {"time": "HH:MM"}. Same time = same cycle, so if a Chain already has
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
    chain = Chain.objects.filter(start_time=new_time).first()
    created = chain is None
    if created:
        chain = Chain.objects.create(start_time=new_time)
    return JsonResponse(
        {"id": chain.id, "time": new_time, "created": created},
        status=201 if created else 200,
    )


@csrf_exempt
@require_POST
def name_chain(request, chain_id):
    """Set or rename a time block (the "cycle"). Recurring, every day.

    Body: {"name": "<str>"}. The name is trimmed; an empty string (after trim)
    clears it, so the block goes back to looking unnamed. Naming is cosmetic — the
    block is still keyed/grouped by its time — so this only writes Chain.name.
    Returns {"id": chain_id, "name": <saved name>}.
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
        chain = Chain.objects.get(id=chain_id)
    except Chain.DoesNotExist:
        return JsonResponse({"error": f"Unknown chain id: {chain_id}."}, status=400)

    chain.name = name
    chain.save(update_fields=["name"])
    return JsonResponse({"id": chain.id, "name": chain.name})


@csrf_exempt
@require_POST
def shift_chains(request):
    """Push a cycle and everything later that day to a new time — for today only.

    Body: {"from_chain": <chain id>, "minutes": <int>, "date"?: "YYYY-MM-DD"}.

    Use case: you woke up late, so the morning cycle and everything after it
    needs to slide back. Every chain whose time *that day* is at or after the
    anchor chain's time moves by `minutes` (negative pulls earlier). This writes
    per-day overrides (ChainDay) and never touches the recurring Chain times, so
    tomorrow is back to normal. Shifting again stacks on the current day's time.
    """
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    from_chain_id = body.get("from_chain")
    # bool is a subclass of int, so reject it explicitly.
    if not isinstance(from_chain_id, int) or isinstance(from_chain_id, bool):
        return JsonResponse({"error": "'from_chain' must be a chain id (integer)."}, status=400)

    minutes = body.get("minutes")
    if not isinstance(minutes, int) or isinstance(minutes, bool):
        return JsonResponse(
            {"error": "'minutes' must be an integer (negative pulls earlier)."}, status=400
        )

    target_date, date_error = _resolve_date(body.get("date"))
    if date_error:
        return date_error

    # Each chain's effective time this day, with the full Phase-3 precedence
    # (ChainDay override > ChainTime forward-time > recurring start_time) so a shift
    # anchors on what the cycle actually reads as today. Timeless chains (no
    # effective time) can't anchor or move.
    effective = _effective_chain_times(target_date)

    if from_chain_id not in effective:
        return JsonResponse({"error": f"Unknown chain id: {from_chain_id}."}, status=400)
    threshold = effective[from_chain_id]
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
            ChainDay.objects.update_or_create(
                chain_id=pid,
                date=target_date,
                defaults={"start_time": _shift_time(base, minutes)},
            )

    # Return the day's new times, sorted, so the UI can reconcile.
    updated = sorted(
        ({"chain": pid, "time": _shift_time(base, minutes)} for pid, base in affected.items()),
        key=lambda r: r["time"],
    )
    return JsonResponse({"date": target_date, "updated": updated})


@csrf_exempt
@require_POST
def retime_chain(request):
    """Move ONE cycle to a new time — for today only, no cascade.

    Body: {"chain": <chain id>, "time": "HH:MM", "date"?: "YYYY-MM-DD"}.

    The drag-the-time-header companion to shift_chains: you drop a single cycle at
    an absolute time and *only* that cycle moves — everything else stays put
    (whereas shift slides the anchor and everything after it). Like shift, it
    writes a per-day override (ChainDay) and never touches the recurring Chain time,
    so tomorrow is back to normal. Dropping a cycle on its normal recurring time
    clears the override instead of storing a redundant "no-op" one.
    """
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    chain_id = body.get("chain")
    # bool is a subclass of int, so reject it explicitly.
    if not isinstance(chain_id, int) or isinstance(chain_id, bool):
        return JsonResponse({"error": "'chain' must be a chain id (integer)."}, status=400)

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
        chain = Chain.objects.get(id=chain_id)
    except Chain.DoesNotExist:
        return JsonResponse({"error": f"Unknown chain id: {chain_id}."}, status=400)

    with transaction.atomic():
        if new_time == chain.start_time:
            # Back on its normal time — drop any override so "no row = normal" holds.
            ChainDay.objects.filter(chain=chain, date=target_date).delete()
        else:
            # Absolute set (not a delta): a second drop replaces the first.
            ChainDay.objects.update_or_create(
                chain=chain, date=target_date, defaults={"start_time": new_time}
            )

    return JsonResponse({"date": target_date, "chain": chain_id, "time": new_time})


@csrf_exempt
@require_POST
def retime_forward(request):
    """Move ONE cycle to a new time PERMANENTLY from a date forward — the
    "every day from today" twin of retime_chain's per-day override, and the
    forward-time half of apply-to-future (Phase 3).

    Body: {"chain": <chain id>, "time": "HH:MM", "from_date"?: "YYYY-MM-DD"}.

    Upserts ONE `ChainTime` row (chain, valid_from=from_date, start_time) so this
    cycle's new time sticks from `from_date` (default today) forward — read via
    _effective_chain_times. It writes ONLY this cycle's time: no other cycle moves
    (independence from shift's cascade), and it never touches any Schedule /
    ScheduleDay placement (independence from the placement half). Re-running the
    same forward retime UPDATEs the from_date row rather than duplicating it.

    Frozen TODAY: a frozen day reads each block's locked-in ChainDay time, so a
    pure ChainTime write would be invisible to today, making "every day from today"
    visibly skip today. So when from_date == today and today is frozen we ALSO
    mirror the new time into today's ChainDay for THIS cycle — exactly as
    arrange_forward mirrors placement into today's ScheduleDay. We do this ONLY
    for today; a frozen FUTURE day is a deliberate pre-edit and stays untouched
    (D3), and a non-frozen day reads ChainTime directly so it needs no mirror.
    """
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    chain_id = body.get("chain")
    # bool is a subclass of int, so reject it explicitly.
    if not isinstance(chain_id, int) or isinstance(chain_id, bool):
        return JsonResponse({"error": "'chain' must be a chain id (integer)."}, status=400)

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
    # The app works at minute precision; drop seconds/micros so reads compare clean.
    new_time = new_time.replace(second=0, microsecond=0)

    # from_date is optional and defaults to today (inclusive — "this and
    # following"). Mirrors arrange_forward: today never reaches the past.
    raw_from = body.get("from_date")
    if raw_from is None:
        from_date = timezone.localdate()
    else:
        from_date, date_error = _resolve_date(raw_from)
        if date_error:
            return date_error

    try:
        chain = Chain.objects.get(id=chain_id)
    except Chain.DoesNotExist:
        return JsonResponse({"error": f"Unknown chain id: {chain_id}."}, status=400)

    today = timezone.localdate()
    # Only mirror into a frozen day when that day is TODAY. A frozen FUTURE day is
    # a deliberate pre-edit and stays untouched (D3).
    reflect_today = (
        from_date == today
        and ScheduleDay.objects.filter(date=today).exists()
    )

    with transaction.atomic():
        # UPSERT this cycle's from_date ChainTime generation: re-running updates it
        # rather than duplicating. Only THIS chain is touched.
        ChainTime.objects.update_or_create(
            chain=chain, valid_from=from_date, defaults={"start_time": new_time}
        )
        if reflect_today:
            # Keep today (frozen) in sync so "every day from today" visibly
            # includes today. Upsert ONLY this cycle's ChainDay for today.
            ChainDay.objects.update_or_create(
                chain=chain, date=today, defaults={"start_time": new_time}
            )

    return JsonResponse(
        {"from_date": from_date.isoformat(), "chain": chain_id, "time": new_time}
    )


def _habit_detail(habit):
    """The shape returned after creating or editing a habit."""
    return {
        "id": habit.id,
        "name": habit.name,
        "notes": habit.notes,
        "area": habit.area_id,
        "date_added": habit.date_added,
        "is_support": habit.is_support,
        "ended_on": habit.ended_on,     # null = active; a date = retired (stopped)
        "tiers": _habit_tiers(habit),   # same shape as in /chains/
        # The aspirations this habit works toward (ids only, stable order so the
        # bloom colors stay put). Editable from the habit page for non-helpers.
        "aspirations": list(
            habit.aspirations.order_by("id").values_list("id", flat=True)
        ),
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
    """Create a habit. Body: {"name", "notes"?, "area"?, "is_support"?, "label"?}.

    A new habit starts unscheduled (no chain/time), so it appears in the
    "unscheduled" group of /chains/ until it's placed on the timeline.

    `label` is the Roots/Growth tag (1|2|3, default 1=Roots) the habit's FIRST
    ladder rung wears. We create that one rung here — value "" (no amount yet;
    the row just reads as the habit name) — because the Habits page lists habits
    by their rungs, so a habit with none would be invisible there until someone
    opened the ladder editor. Pass null for a plain, untagged habit.
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

    label = body.get("label", TierChoices.ROOTS)
    if label not in (None, 1, 2, 3):
        return JsonResponse({"error": "'label' must be 1, 2, 3, or null."}, status=400)

    with transaction.atomic():
        habit = Habit.objects.create(
            name=name, notes=notes.strip(), area_id=area_id, is_support=is_support
        )
        if label is not None:
            Version.objects.create(
                habit=habit,
                level=1,
                value="",
                label=Tier.objects.get_or_create(level=label)[0],
            )
    return JsonResponse(_habit_detail(habit), status=201)


@csrf_exempt
@require_POST
def edit_habit(request, habit_id):
    """Update a habit's name / notes / area / aspirations. Partial: only the
    fields present in the body are changed."""
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

    # Aspirations this habit works toward. A present list REPLACES the whole set
    # (same M2M as the aspiration side's habit_ids, just written from the habit).
    # Unknown ids are silently dropped by the filter.
    if "aspiration_ids" in body:
        ids = body["aspiration_ids"]
        if not isinstance(ids, list) or not all(
            isinstance(i, int) and not isinstance(i, bool) for i in ids
        ):
            return JsonResponse(
                {"error": "'aspiration_ids' must be a list of aspiration ids."},
                status=400,
            )
        habit.aspirations.set(Aspiration.objects.filter(id__in=ids))

    habit.save()
    return JsonResponse(_habit_detail(habit))


@csrf_exempt
@require_POST
def delete_habit(request, habit_id):
    """Remove a habit — two modes, mirroring Google Calendar's recurring-event delete.

    Body: {"mode": "stop" | "forever"}.

      - "stop"  (GCal "this and following"): RETIRE the habit as of today. Sets
        ended_on=today, so it drops off the Habits page + Plan from today forward
        and stops counting as "missed" — but every PAST day keeps it intact as
        history (the date-aware ended_on filter only hides it on/after its end
        date). Nothing is deleted; reversible via resume_habit.

      - "forever" (GCal "all events"): PERMANENTLY delete the habit and its whole
        history. CASCADE drops its Schedule placements and HabitTier/TierValue
        versions; we also delete its HabitLogs and ScheduleDays (those FKs are
        SET_NULL, so they'd otherwise linger as nameless rows) and clean up any
        Note left with no habits (the orphan rule, same as delete_note). Its M2M
        links to Aspirations are auto-cleared; the aspirations themselves stay.
    """
    habit = get_object_or_404(Habit, id=habit_id)

    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    mode = body.get("mode")

    if mode == "stop":
        today = timezone.localdate()
        with transaction.atomic():
            habit.ended_on = today          # cheap "paused right now" flag for the UI
            habit.save(update_fields=["ended_on"])
            # Open a pause WINDOW so the gap is remembered permanently; resume
            # closes it, and the closed window keeps these days off the schedule
            # for good (resume can't rewrite history). Guard against a duplicate
            # open window if "stop" is somehow hit twice.
            if not HabitPause.objects.filter(habit=habit, end_date__isnull=True).exists():
                HabitPause.objects.create(habit=habit, start_date=today)
        return JsonResponse(
            {"id": habit_id, "ended": True, "ended_on": habit.ended_on}
        )

    if mode == "forever":
        with transaction.atomic():
            # Capture notes linked to this habit BEFORE the delete unlinks them, so
            # we can sweep any left with zero habits afterwards.
            note_ids = list(habit.day_notes.values_list("id", flat=True))
            # Delete the SET_NULL history rows explicitly while we still know which
            # habit they were — otherwise they'd survive as habit=null, nameless.
            logs_deleted = HabitLog.objects.filter(habit=habit).delete()[0]
            days_deleted = ScheduleDay.objects.filter(habit=habit).delete()[0]
            habit.delete()  # CASCADE: Schedule, HabitTier -> TierValue; M2M unlinked
            notes_deleted = (
                Note.objects.filter(id__in=note_ids, habits__isnull=True).delete()[0]
            )
        return JsonResponse({
            "id": habit_id,
            "deleted": True,
            "logs_deleted": logs_deleted,
            "days_deleted": days_deleted,
            "notes_deleted": notes_deleted,
        })

    return JsonResponse({"error": "'mode' must be 'stop' or 'forever'."}, status=400)


@csrf_exempt
@require_POST
def resume_habit(request, habit_id):
    """Un-retire a "stopped" habit: close its open pause window at today (end is
    exclusive, so it's active again ON today) and clear the ended_on flag. The
    closed window stays as history, so the days it was paused remain off the
    schedule — resuming brings it back going forward WITHOUT resurrecting those
    paused days as "missed"."""
    habit = get_object_or_404(Habit, id=habit_id)
    today = timezone.localdate()
    with transaction.atomic():
        HabitPause.objects.filter(habit=habit, end_date__isnull=True).update(
            end_date=today
        )
        habit.ended_on = None
        habit.save(update_fields=["ended_on"])
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
    ?date=YYYY-MM-DD like /chains/ does."""
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
    own ordering). Honors ?date=YYYY-MM-DD like /chains/ and /days/notes/ do."""
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
    """Every habit with its tiers and completion status for a day — powers the
    Habits overview page.

    `?date=YYYY-MM-DD` picks the day (defaults today); the Habits page's day-nav
    passes it to browse other days, exactly like /plan/. Statuses come from that
    day's logs, and a past untouched day derives MISSED (same rule as the Plan
    page). Returns a flat array, one object per habit, ordered by hand-picked
    Habit.order then area/name (NOT the model default, which JOINs Schedule and
    would duplicate a habit that sits in several time-slots).

    For a given day the list is the habits that APPLIED then: created by that date
    and not paused on it (date-aware, via pause windows) — so browsing back never
    shows a habit before it existed or while it was stopped, and never marks those
    days missed. `?include_ended=1` instead returns ALL habits (incl. currently
    paused, with ended_on set) for the Paused page; it ignores the day filter.

    Each habit carries its tier ladder (`_habit_tiers`, low->high, each entry
    {level,name,value,status,done}) and a habit-level `status` — the whole-habit
    view (done if any version is done).
    """
    today = timezone.localdate()
    target_date, date_error = _resolve_date(request.GET.get("date"))
    if date_error:
        return date_error
    is_past = target_date < today
    day_logs = _day_logs(target_date)

    include_ended = request.GET.get("include_ended") in ("1", "true", "True")

    # Override the model's default ordering (which JOINs Schedule -> duplicates):
    # hand-picked Habit.order first (unplaced habits are null -> sort last), then
    # area/name as the stable fallback. Ordering by Habit fields drops that join,
    # so each habit still appears exactly once.
    habits = Habit.objects.select_related("area").order_by(
        F("order").asc(nulls_last=True), "area__name", "name"
    )
    if not include_ended:
        # Only habits that applied on the viewed day: existed by then and not
        # paused on it. For today this is the usual "active habits" set; browsing
        # back drops habits that didn't exist yet or were stopped that day.
        habits = habits.filter(date_added__date__lte=target_date).exclude(
            id__in=_paused_habit_ids(target_date)
        )

    # habit_id -> [aspiration ids] in one query (bloom dots on the Habits page).
    asp_map = _aspirations_by_habit()

    # Evaluate the queryset once so the streak id-list and the loop below share a
    # single query; then the current streak per habit, as of the viewed day.
    habits = list(habits)
    streaks = _habit_streaks([h.id for h in habits], target_date)

    data = []
    for habit in habits:
        bucket = day_logs.get(habit.id)
        specific = bucket["specific"] if bucket else {}
        fallback = bucket["fallback"] if bucket else None

        tiers = _habit_tiers(habit)
        for t in tiers:
            st = _version_status(specific, fallback, t["level"], is_past)
            t["status"] = st
            t["done"] = st == HabitLog.Status.COMPLETED

        data.append({
            "id": habit.id,
            "name": habit.name,
            "area": habit.area_id,
            "area_name": habit.area.name if habit.area_id else None,
            "is_support": habit.is_support,
            "ended_on": habit.ended_on,            # null = active; a date = retired
            "tiers": tiers,                        # per-version, [] if untiered
            # whole-habit status: done if any version done, else skip/missed/pending
            "status": _version_status(specific, fallback, None, is_past),
            "aspirations": asp_map.get(habit.id, []),  # aspiration ids this habit serves
            "streak": streaks.get(habit.id, 0),        # consecutive completed days
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


# --- Aspirations -----------------------------------------------------------
# A directional intent ("move more") that a set of habits serves. The detail
# view shows each attached habit's recent completion as a row of dots + a
# streak, so you can eyeball whether you've been living the aspiration. A tiered
# habit shows ONE row PER VERSION (Roots/Growth/...) — the same per-version view
# the Habits and Plan pages use — not a single merged row.

ASPIRATION_PROGRESS_DAYS = 14     # dots per version on the DETAIL page (last = today)
ASPIRATION_LIST_DAYS = 7          # dots per habit on the LIST page accordion
ASPIRATION_STREAK_LOOKBACK = 90   # how far back a current streak may reach


def _aspiration_habit_progress(habits, today):
    """Per-habit (and per-version) recent completion for the aspiration rows.

    For each habit we resolve, for every day in the lookback, that day's logs into
    the {specific, fallback} shape `_version_status` needs, so a version reads
    "done" exactly as it does elsewhere — including the higher-completes-lower
    cascade. A tiered habit returns a `tiers` list (one entry per version, each
    with its own dots + streak); an untiered habit returns top-level dots + streak
    (its `tiers` is []). "Done" on a day = that version reads COMPLETED.

    Each row carries `days` (last ASPIRATION_PROGRESS_DAYS as booleans, oldest
    first so the rightmost dot is today) and `streak` (consecutive completed days
    ending today; a still-pending today doesn't break it).
    """
    habits = list(habits)
    if not habits:
        return []

    habit_ids = [h.id for h in habits]
    earliest = today - timedelta(days=ASPIRATION_STREAK_LOOKBACK)
    # (habit_id, date) -> {"specific": {level: status}, "fallback": status|None},
    # one pass over every log in the window (mirrors _day_logs, but range-wide).
    buckets = defaultdict(lambda: {"specific": {}, "fallback": None})
    for hid, d, level, status in HabitLog.objects.filter(
        habit_id__in=habit_ids,
        date__gte=earliest,
        date__lte=today,
    ).values_list("habit_id", "date", "version__level", "status"):
        b = buckets[(hid, d)]
        if level is None:
            b["fallback"] = status
        else:
            b["specific"][level] = status

    window = [today - timedelta(days=i)
              for i in range(ASPIRATION_PROGRESS_DAYS - 1, -1, -1)]

    def done_on(hid, day, level):
        b = buckets.get((hid, day))
        specific = b["specific"] if b else {}
        fallback = b["fallback"] if b else None
        status = _version_status(specific, fallback, level, is_past=day < today)
        return status == HabitLog.Status.COMPLETED

    def progress(hid, level):
        days = [done_on(hid, day, level) for day in window]
        # Current streak: start at today (or yesterday if today isn't done yet),
        # walk back while each day reads completed.
        streak = 0
        cursor = today if done_on(hid, today, level) else today - timedelta(days=1)
        while cursor >= earliest and done_on(hid, cursor, level):
            streak += 1
            cursor -= timedelta(days=1)
        return {"days": days, "streak": streak}

    rows = []
    for h in habits:
        tiers = _habit_tiers(h)   # [] for an untiered habit
        if tiers:
            rows.append({
                "id": h.id,
                "name": h.name,
                "tiers": [
                    {"level": t["level"], "name": t["name"], "value": t["value"],
                     **progress(h.id, t["level"])}
                    for t in tiers
                ],
                "days": [],
                "streak": 0,
            })
        else:
            rows.append({
                "id": h.id,
                "name": h.name,
                "tiers": [],
                **progress(h.id, None),
            })
    return rows


def _aspiration_heatmap(asp, habits, today):
    """Per-day completion across a dated aspiration's window, for the goal heatmap.

    The window runs from the day the aspiration was created (`created_at`) through
    its `target_date`, inclusive. For each ELAPSED day we report how many of the
    aspiration's habits read COMPLETED that day (`done`) out of how many APPLIED
    that day (`total`) — a habit applies once it exists and until it's retired,
    the same date-aware rule the Habits page uses (Habit.date_added/ended_on).
    Future days carry `done=null` so the frontend can draw them hollow ("still to
    come"). The frontend shades each day by done/total and lays the days out as a
    month calendar; `days_left`/`elapsed_days` feed the countdown.
    """
    habits = list(habits)
    start = timezone.localtime(asp.created_at).date()
    target = asp.target_date
    if target < start:            # a target before the start -> empty window
        target = start

    # done_on(hid, day): did this habit read COMPLETED that day (any version)?
    # One windowed query over just the ELAPSED span, same bucket shape as the
    # list/detail progress helpers.
    last_elapsed = min(today, target)
    buckets = defaultdict(lambda: {"specific": {}, "fallback": None})
    habit_ids = [h.id for h in habits]
    if habit_ids and last_elapsed >= start:
        for hid, d, level, status in HabitLog.objects.filter(
            habit_id__in=habit_ids, date__gte=start, date__lte=last_elapsed,
        ).values_list("habit_id", "date", "version__level", "status"):
            b = buckets[(hid, d)]
            if level is None:
                b["fallback"] = status
            else:
                b["specific"][level] = status

    def done_on(hid, day):
        b = buckets.get((hid, day))
        specific = b["specific"] if b else {}
        fallback = b["fallback"] if b else None
        return _version_status(
            specific, fallback, None, is_past=day < today
        ) == HabitLog.Status.COMPLETED

    # A habit applies on `day` once it exists and until it's retired (ended_on is
    # exclusive) — mirrors the Habit model docstring / Habits-page filter.
    added = {h.id: timezone.localtime(h.date_added).date() for h in habits}

    def applies_on(h, day):
        if day < added[h.id]:
            return False
        return h.ended_on is None or h.ended_on > day

    days = []
    all_done_days = 0
    day = start
    while day <= target:
        applied = [h for h in habits if applies_on(h, day)]
        total = len(applied)
        if day <= today:
            done = sum(1 for h in applied if done_on(h.id, day))
            if total and done >= total:
                all_done_days += 1
        else:
            done = None                       # future -> hollow
        days.append({"d": day.isoformat(), "done": done, "total": total})
        day += timedelta(days=1)

    total_days = (target - start).days + 1
    elapsed_days = min((today - start).days + 1, total_days) if today >= start else 0
    return {
        "start_date": start.isoformat(),
        "target_date": target.isoformat(),
        "today": today.isoformat(),
        "total_days": total_days,
        "elapsed_days": elapsed_days,
        "days_left": max((target - today).days, 0),
        "all_done_days": all_done_days,
        "days": days,
    }


def _habit_streaks(habit_ids, as_of):
    """Whole-habit current streak per habit, as of `as_of`: the run of consecutive
    days ending on `as_of` where the habit read COMPLETED (any version counts). A
    still-pending `as_of` doesn't break it — the count just starts the day before
    (same rule as the aspiration streaks). One windowed query, so the Habits list
    stays a fixed number of queries instead of one per habit.
    """
    if not habit_ids:
        return {}
    earliest = as_of - timedelta(days=ASPIRATION_STREAK_LOOKBACK)
    # (habit_id, date) -> {specific: {level: status}, fallback: status|None},
    # one pass over every log in the window (mirrors _day_logs, range-wide).
    buckets = defaultdict(lambda: {"specific": {}, "fallback": None})
    for hid, d, level, status in HabitLog.objects.filter(
        habit_id__in=habit_ids,
        date__gte=earliest,
        date__lte=as_of,
    ).values_list("habit_id", "date", "version__level", "status"):
        b = buckets[(hid, d)]
        if level is None:
            b["fallback"] = status
        else:
            b["specific"][level] = status

    def done_on(hid, day):
        b = buckets.get((hid, day))
        specific = b["specific"] if b else {}
        fallback = b["fallback"] if b else None
        status = _version_status(specific, fallback, None, is_past=day < as_of)
        return status == HabitLog.Status.COMPLETED

    streaks = {}
    for hid in habit_ids:
        streak = 0
        cursor = as_of if done_on(hid, as_of) else as_of - timedelta(days=1)
        while cursor >= earliest and done_on(hid, cursor):
            streak += 1
            cursor -= timedelta(days=1)
        streaks[hid] = streak
    return streaks


def aspirations(request):
    """List all aspirations, newest first, each WITH its habits — and, for a
    tiered habit, one strip PER VERSION (Roots/Growth/...) — so the list page can
    show an expandable per-version habit strip per aspiration in one round-trip.

    Each day is {"done", "existed"}: `existed` is False for days before the habit
    was created (the list greys those out — it couldn't have been done then), else
    `done` is whether THAT VERSION read COMPLETED that day (same higher-completes-
    lower cascade as the detail/Habits pages). A tiered habit returns a `tiers`
    list; an untiered one returns top-level `days` (its `tiers` is [])."""
    today = timezone.localdate()
    # Prefetch habits ordered by a Habit field (name), NOT the model default
    # (`schedule__*`), which JOINs Schedule and would list a habit once per
    # time-slot it sits in — the same trap habits_list guards against.
    asps = list(
        Aspiration.objects.order_by("-created_at").prefetch_related(
            Prefetch("habits", queryset=Habit.objects.order_by("name"))
        )
    )

    window = [today - timedelta(days=i)
              for i in range(ASPIRATION_LIST_DAYS - 1, -1, -1)]
    habit_ids = {h.id for a in asps for h in a.habits.all()}

    # (habit_id, date) -> {specific, fallback}, one query across every listed habit.
    buckets = defaultdict(lambda: {"specific": {}, "fallback": None})
    if habit_ids:
        for hid, d, level, status in HabitLog.objects.filter(
            habit_id__in=habit_ids, date__gte=window[0], date__lte=today,
        ).values_list("habit_id", "date", "version__level", "status"):
            b = buckets[(hid, d)]
            if level is None:
                b["fallback"] = status
            else:
                b["specific"][level] = status

    def cell(habit, day, level):
        if day < timezone.localtime(habit.date_added).date():
            return {"done": False, "existed": False}     # before it existed -> grey
        b = buckets.get((habit.id, day))
        specific = b["specific"] if b else {}
        fallback = b["fallback"] if b else None
        done = _version_status(
            specific, fallback, level, is_past=day < today
        ) == HabitLog.Status.COMPLETED
        return {"done": done, "existed": True}

    def habit_strip(h):
        tiers = _habit_tiers(h)   # [] for an untiered habit
        if tiers:
            return {
                "id": h.id, "name": h.name,
                "tiers": [
                    {"level": t["level"], "name": t["name"], "value": t["value"],
                     "days": [cell(h, day, t["level"]) for day in window]}
                    for t in tiers
                ],
                "days": [],
            }
        return {
            "id": h.id, "name": h.name, "tiers": [],
            "days": [cell(h, day, None) for day in window],
        }

    data = [
        {
            "id": a.id,
            "name": a.name,
            "color": a.color,   # chosen bloom index, or null for the id default
            "habits": [
                habit_strip(h)
                for h in sorted(a.habits.all(), key=lambda h: h.name.lower())
            ],
        }
        for a in asps
    ]
    # `window` names the strip's actual dates (oldest first, last = today) so
    # the frontend can label the columns. Without it the cells are purely
    # positional and a client in another timezone would label them off-by-one
    # (its local "today" can differ from this server-side window's end).
    return JsonResponse(
        {"window": [d.isoformat() for d in window], "aspirations": data}
    )


def aspiration(request, aspiration_id):
    """One aspiration: its text fields, the ids of its attached habits, and each
    attached habit's recent completion (for the per-habit progress rows)."""
    asp = get_object_or_404(Aspiration, id=aspiration_id)
    habits = list(asp.habits.order_by("name"))
    today = timezone.localdate()
    return JsonResponse({
        "id": asp.id,
        "name": asp.name,
        "reason": asp.reason,
        "motivation": asp.motivation,
        "notes": asp.notes,
        "color": asp.color,   # chosen bloom index, or null for the id default
        "created_at": asp.created_at,
        "target_date": asp.target_date,   # null = open-ended; a date = dated goal
        "habit_ids": [h.id for h in habits],
        "habits": _aspiration_habit_progress(habits, today),
        # The countdown + completion heatmap, only for a dated aspiration.
        "goal": _aspiration_heatmap(asp, habits, today) if asp.target_date else None,
        "progress_days": ASPIRATION_PROGRESS_DAYS,
    })


ASPIRATION_COLOR_COUNT = 6   # size of the frontend BLOOMS palette (0..5)


def _color_error(value):
    """None if `value` is a usable color (null, or an index 0..5), else a 400."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) \
            or not (0 <= value < ASPIRATION_COLOR_COUNT):
        return JsonResponse(
            {"error": f"'color' must be null or 0..{ASPIRATION_COLOR_COUNT - 1}."},
            status=400,
        )
    return None


def _parse_target_date(value):
    """(date_or_None, error_response_or_None) from a `target_date` body value.
    null/'' clears it (an open-ended aspiration); otherwise it must be an ISO
    'YYYY-MM-DD' string."""
    if value in (None, ""):
        return None, None
    if not isinstance(value, str) or parse_date(value) is None:
        return None, JsonResponse(
            {"error": "'target_date' must be null or a YYYY-MM-DD date."}, status=400
        )
    return parse_date(value), None


@csrf_exempt
@require_POST
def create_aspiration(request):
    """Create an aspiration. Body: {name, reason?, motivation?, notes?, color?,
    target_date?, habit_ids?}. habit_ids attaches existing habits to it; color is
    a bloom index (0..5) or null for the id-based default; target_date (YYYY-MM-DD
    or null) turns it into a dated goal with a countdown + heatmap."""
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    name = (body.get("name") or "").strip()
    if not name:
        return JsonResponse({"error": "Name is required."}, status=400)

    color_error = _color_error(body.get("color"))
    if color_error:
        return color_error

    target_date, td_error = _parse_target_date(body.get("target_date"))
    if td_error:
        return td_error

    asp = Aspiration.objects.create(
        name=name,
        reason=(body.get("reason") or "").strip(),
        motivation=(body.get("motivation") or "").strip(),
        notes=(body.get("notes") or "").strip(),
        color=body.get("color"),
        target_date=target_date,
    )
    habit_ids = body.get("habit_ids")
    if habit_ids:
        asp.habits.set(Habit.objects.filter(id__in=habit_ids))
    return JsonResponse({"id": asp.id}, status=201)


@csrf_exempt
@require_POST
def edit_aspiration(request, aspiration_id):
    """Update an aspiration. Body may carry any of name, reason, motivation,
    notes, color, target_date, habit_ids; absent keys are left unchanged. A
    present habit_ids REPLACES the whole attached-habit set (the edit form always
    sends it); a present target_date (YYYY-MM-DD or null) sets or clears the
    deadline."""
    asp = get_object_or_404(Aspiration, id=aspiration_id)
    try:
        body = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Request body must be valid JSON."}, status=400)

    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            return JsonResponse({"error": "Name is required."}, status=400)
        asp.name = name
    if "reason" in body:
        asp.reason = (body.get("reason") or "").strip()
    if "motivation" in body:
        asp.motivation = (body.get("motivation") or "").strip()
    if "notes" in body:
        asp.notes = (body.get("notes") or "").strip()
    if "color" in body:
        color_error = _color_error(body.get("color"))
        if color_error:
            return color_error
        asp.color = body.get("color")
    if "target_date" in body:
        target_date, td_error = _parse_target_date(body.get("target_date"))
        if td_error:
            return td_error
        asp.target_date = target_date
    asp.save()

    if "habit_ids" in body:
        asp.habits.set(Habit.objects.filter(id__in=(body.get("habit_ids") or [])))
    return JsonResponse({"id": asp.id})


# --- Everyday routine ------------------------------------------------------
# The recurring/default schedule that plays every day, before any per-day edits.
# Read-only here; the Everyday Routine page edits it through the sanctioned
# recurring writer (/schedules/arrange-forward/), never by writing Schedule rows
# directly — that's what the docstring on arrange_forward insists on.

def recurring_schedule(request):
    """The everyday/recurring default schedule as of today.

    Built from `_effective_schedules(today)` — the same generation-aware
    projection `/plan/` and `freeze_day` read — so this page can never disagree
    with what actually plays on a fresh (unedited) day. Blocks are Chains (time +
    name) each holding their habits in `order`; habits with no chain are the
    "Anytime" group, returned last. Times overlay any recurring ChainTime change.
    """
    # Project for the requested date (the page passes tomorrow, since edits here
    # apply from tomorrow forward — so what's shown matches what's being edited).
    target, _err = _resolve_date(request.GET.get("date"))
    schedules = _effective_schedules(target)
    times = _chain_times_for_date(target)           # {chain_id: start_time} override
    chains = {c.id: c for c in Chain.objects.all()}

    by_chain = defaultdict(list)
    for s in schedules:
        by_chain[s.chain_id].append(s)

    blocks = []
    for chain_id, rows in by_chain.items():
        rows.sort(key=lambda s: s.order if s.order is not None else 0)
        if chain_id is None:
            name, start_time = "", None
        else:
            c = chains.get(chain_id)
            name = c.name if c else ""
            start_time = times.get(chain_id) or (c.start_time if c else None)
        blocks.append({
            "chain": chain_id,
            "name": name,
            "time": start_time,                     # "HH:MM:SS" or null (Anytime)
            "habits": [
                {
                    "schedule": s.id,
                    "habit": s.habit_id,
                    "name": s.habit.name,
                    "tier": s.tier.level if s.tier_id else None,
                    "tier_name": s.tier.get_level_display() if s.tier_id else None,
                    "routine": s.routine_id,
                    "routine_name": s.routine.name if s.routine_id else None,
                    "order": s.order,
                }
                for s in rows
            ],
        })

    # Timed blocks first (by time), the Anytime block (no time) last.
    blocks.sort(key=lambda b: (b["time"] is None, b["time"] or ""))
    return JsonResponse({"blocks": blocks})
