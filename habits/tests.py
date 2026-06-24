import json
from datetime import time, timedelta
from io import StringIO

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from .models import (
    Area, Habit, HabitLog, HabitTier, Note, Plan, PlanDay, Routine, Schedule,
    ScheduleDay, Tier, TierValue,
)
from .views import FREEZE_CATCHUP_DAYS, freeze_day


class BrowseDaysTests(TestCase):
    """`/plan/` and the log endpoint must be able to look at any day, not just
    today — that's what powers moving between days in the UI."""

    def setUp(self):
        self.today = timezone.localdate()
        self.yesterday = self.today - timedelta(days=1)

        # A single scheduled habit is enough to assert per-day status. Backdate
        # it (update() bypasses auto_now_add) so it counts as already existing on
        # past days — otherwise the "hide habits that didn't exist yet" filter
        # would correctly drop it from any earlier day.
        self.habit = Habit.objects.create(name="Stretch")
        Habit.objects.filter(id=self.habit.id).update(
            date_added=timezone.now() - timedelta(days=30)
        )
        self.plan = Plan.objects.create()
        Schedule.objects.create(habit=self.habit, plan=self.plan, order=1)

    def _statuses(self, response):
        """Map of habit id -> status across every group in a /plan/ payload."""
        groups = json.loads(response.content)
        return {
            h["id"]: h["status"]
            for group in groups
            for h in group["habits"]
        }

    def test_plan_defaults_to_today(self):
        response = self.client.get(reverse("habits:plan"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._statuses(response)[self.habit.id], "PENDING")

    def test_plan_reads_the_requested_day(self):
        # Completed yesterday, untouched today.
        HabitLog.objects.create(
            habit=self.habit, date=self.yesterday, status=HabitLog.Status.COMPLETED
        )

        yesterday = self.client.get(
            reverse("habits:plan"), {"date": self.yesterday.isoformat()}
        )
        today = self.client.get(reverse("habits:plan"))

        self.assertEqual(self._statuses(yesterday)[self.habit.id], "COMPLETED")
        self.assertEqual(self._statuses(today)[self.habit.id], "PENDING")

    def test_plan_rejects_a_bad_date(self):
        for bad in ("not-a-date", "2026-13-40"):
            response = self.client.get(reverse("habits:plan"), {"date": bad})
            self.assertEqual(response.status_code, 400, bad)

    def test_plan_hides_habits_created_after_the_viewed_day(self):
        # self.habit is 30 days old (see setUp). Add a second habit that only
        # exists as of today.
        new_habit = Habit.objects.create(name="Meditate")
        Schedule.objects.create(habit=new_habit, plan=self.plan, order=2)

        three_days_ago = (self.today - timedelta(days=3)).isoformat()
        past = self._statuses(self.client.get(reverse("habits:plan"), {"date": three_days_ago}))
        today = self._statuses(self.client.get(reverse("habits:plan")))

        # Three days ago: only the week-old habit existed.
        self.assertIn(self.habit.id, past)
        self.assertNotIn(new_habit.id, past)
        # Today: both show.
        self.assertIn(new_habit.id, today)

    def test_past_pending_reads_as_missed(self):
        # Nothing logged. Yesterday is over → missed; today still has time → pending.
        yesterday = self._statuses(
            self.client.get(reverse("habits:plan"), {"date": self.yesterday.isoformat()})
        )
        today = self._statuses(self.client.get(reverse("habits:plan")))
        self.assertEqual(yesterday[self.habit.id], "MISSED")
        self.assertEqual(today[self.habit.id], "PENDING")

    def test_intentional_skip_is_not_a_miss(self):
        # An explicit skip on a past day stays SKIPPED — only untouched is a miss.
        HabitLog.objects.create(
            habit=self.habit, date=self.yesterday, status=HabitLog.Status.SKIPPED
        )
        yesterday = self._statuses(
            self.client.get(reverse("habits:plan"), {"date": self.yesterday.isoformat()})
        )
        self.assertEqual(yesterday[self.habit.id], "SKIPPED")

    def test_log_targets_the_given_day(self):
        url = reverse("habits:log_habit", args=[self.habit.id])
        response = self.client.post(
            url,
            data={"status": "COMPLETED", "date": self.yesterday.isoformat()},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.content)["date"], self.yesterday.isoformat())
        # The log landed on yesterday, leaving today untouched.
        log = HabitLog.objects.get(habit=self.habit, date=self.yesterday)
        self.assertEqual(log.status, "COMPLETED")
        self.assertFalse(HabitLog.objects.filter(habit=self.habit, date=self.today).exists())

    def test_log_defaults_to_today(self):
        url = reverse("habits:log_habit", args=[self.habit.id])
        response = self.client.post(
            url, data={"status": "COMPLETED"}, content_type="application/json"
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(
            HabitLog.objects.filter(habit=self.habit, date=self.today).exists()
        )

    def test_log_rejects_a_bad_date(self):
        url = reverse("habits:log_habit", args=[self.habit.id])
        response = self.client.post(
            url,
            data={"status": "COMPLETED", "date": "nope"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)


class ShiftPlansTests(TestCase):
    """Waking up late pushes a cycle and everything after it to a new time —
    for that day only, never touching the recurring routine."""

    def setUp(self):
        self.today = timezone.localdate()
        self.tomorrow = self.today + timedelta(days=1)
        # Three time slots; we'll anchor shifts on the 9:00 one.
        self.early = Plan.objects.create(start_time=time(8, 0))
        self.mid = Plan.objects.create(start_time=time(9, 0))
        self.late = Plan.objects.create(start_time=time(10, 0))
        self.url = reverse("habits:shift_plans")

    def _shift(self, **body):
        return self.client.post(self.url, data=body, content_type="application/json")

    def _plan_times(self, response):
        """Map of plan id -> time string from a /plan/ payload (skips unscheduled)."""
        groups = json.loads(response.content)
        return {g["id"]: g["time"] for g in groups if g["id"] is not None}

    def _today_times(self):
        return self._plan_times(self.client.get(reverse("habits:plan")))

    def test_shifts_anchor_and_everything_after(self):
        response = self._shift(from_plan=self.mid.id, minutes=45)
        self.assertEqual(response.status_code, 200)

        times = self._today_times()
        self.assertEqual(times[self.early.id], "08:00:00")  # before anchor: unchanged
        self.assertEqual(times[self.mid.id], "09:45:00")    # anchor: moved
        self.assertEqual(times[self.late.id], "10:45:00")   # after anchor: cascaded

    def test_shift_is_today_only(self):
        self._shift(from_plan=self.mid.id, minutes=45)
        tomorrow = self._plan_times(
            self.client.get(reverse("habits:plan"), {"date": self.tomorrow.isoformat()})
        )
        self.assertEqual(tomorrow[self.mid.id], "09:00:00")  # recurring time intact

    def test_negative_minutes_pull_earlier(self):
        self._shift(from_plan=self.mid.id, minutes=-30)
        self.assertEqual(self._today_times()[self.mid.id], "08:30:00")

    def test_repeated_shifts_stack(self):
        self._shift(from_plan=self.mid.id, minutes=30)
        self._shift(from_plan=self.mid.id, minutes=15)
        self.assertEqual(self._today_times()[self.mid.id], "09:45:00")  # 9:00 +30 +15
        # ...and still just one override row for that plan/day.
        self.assertEqual(
            PlanDay.objects.filter(plan=self.mid, date=self.today).count(), 1
        )

    def test_rejects_bad_input(self):
        self.assertEqual(self._shift(from_plan=999999, minutes=10).status_code, 400)
        self.assertEqual(self._shift(from_plan=self.mid.id, minutes="lots").status_code, 400)
        self.assertEqual(self._shift(minutes=10).status_code, 400)  # missing from_plan


class RetimePlanTests(TestCase):
    """Drag one cycle's time header to an absolute time — today only, no cascade
    (the single-block companion to the 'running late' shift)."""

    def setUp(self):
        self.today = timezone.localdate()
        self.tomorrow = self.today + timedelta(days=1)
        self.early = Plan.objects.create(start_time=time(8, 0))
        self.mid = Plan.objects.create(start_time=time(9, 0))
        self.late = Plan.objects.create(start_time=time(10, 0))
        self.url = reverse("habits:retime_plan")

    def _retime(self, **body):
        return self.client.post(self.url, data=body, content_type="application/json")

    def _plan_times(self, response):
        """Map of plan id -> time string from a /plan/ payload (skips unscheduled)."""
        groups = json.loads(response.content)
        return {g["id"]: g["time"] for g in groups if g["id"] is not None}

    def _today_times(self):
        return self._plan_times(self.client.get(reverse("habits:plan")))

    def test_moves_only_the_one_cycle(self):
        response = self._retime(plan=self.mid.id, time="08:30")
        self.assertEqual(response.status_code, 200)

        times = self._today_times()
        self.assertEqual(times[self.early.id], "08:00:00")  # untouched
        self.assertEqual(times[self.mid.id], "08:30:00")    # moved to the absolute time
        self.assertEqual(times[self.late.id], "10:00:00")   # NOT cascaded (unlike shift)
        self.assertEqual(PlanDay.objects.filter(date=self.today).count(), 1)

    def test_is_today_only(self):
        self._retime(plan=self.mid.id, time="08:30")
        tomorrow = self._plan_times(
            self.client.get(reverse("habits:plan"), {"date": self.tomorrow.isoformat()})
        )
        self.assertEqual(tomorrow[self.mid.id], "09:00:00")  # recurring time intact

    def test_repeated_retime_replaces_not_stacks(self):
        self._retime(plan=self.mid.id, time="08:30")
        self._retime(plan=self.mid.id, time="11:15")
        # Absolute, so the second drop replaces the first (a shift would stack).
        self.assertEqual(self._today_times()[self.mid.id], "11:15:00")
        self.assertEqual(
            PlanDay.objects.filter(plan=self.mid, date=self.today).count(), 1
        )

    def test_back_to_recurring_clears_the_override(self):
        self._retime(plan=self.mid.id, time="08:30")   # create an override
        self._retime(plan=self.mid.id, time="09:00")   # exactly its recurring time
        self.assertFalse(
            PlanDay.objects.filter(plan=self.mid, date=self.today).exists()
        )
        self.assertEqual(self._today_times()[self.mid.id], "09:00:00")

    def test_rejects_bad_input(self):
        self.assertEqual(self._retime(plan=999999, time="08:30").status_code, 400)  # unknown plan
        self.assertEqual(self._retime(plan=self.mid.id, time="nope").status_code, 400)  # bad time
        self.assertEqual(self._retime(plan=self.mid.id, time="25:00").status_code, 400)  # impossible
        self.assertEqual(self._retime(time="08:30").status_code, 400)  # missing plan
        self.assertEqual(self._retime(plan=self.mid.id).status_code, 400)  # missing time


class NamePlanTests(TestCase):
    """Name a time block (the "cycle"). Optional + cosmetic: an unnamed block
    reads as "" and looks unchanged; naming it persists and shows in /plan/."""

    def setUp(self):
        self.plan = Plan.objects.create(start_time=time(8, 0))
        self.url = reverse("habits:name_plan", args=[self.plan.id])

    def _name(self, plan_id=None, **body):
        url = reverse("habits:name_plan", args=[plan_id or self.plan.id])
        return self.client.post(url, data=body, content_type="application/json")

    def _block_name(self, plan_id):
        """The name of one block from the /plan/ payload."""
        groups = json.loads(self.client.get(reverse("habits:plan")).content)
        return next(g["name"] for g in groups if g["id"] == plan_id)

    def test_name_defaults_to_blank(self):
        # A brand-new block has no name, in the DB and in /plan/.
        self.assertEqual(self.plan.name, "")
        self.assertEqual(self._block_name(self.plan.id), "")

    def test_setting_a_name_persists_and_shows_in_plan(self):
        response = self._name(name="Morning routine")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.content),
                         {"id": self.plan.id, "name": "Morning routine"})
        self.plan.refresh_from_db()
        self.assertEqual(self.plan.name, "Morning routine")
        self.assertEqual(self._block_name(self.plan.id), "Morning routine")

    def test_empty_string_clears_the_name(self):
        self._name(name="Morning routine")
        response = self._name(name="")
        self.assertEqual(response.status_code, 200)
        self.plan.refresh_from_db()
        self.assertEqual(self.plan.name, "")
        self.assertEqual(self._block_name(self.plan.id), "")

    def test_name_is_trimmed(self):
        response = self._name(name="  Wind down  ")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.content)["name"], "Wind down")
        self.plan.refresh_from_db()
        self.assertEqual(self.plan.name, "Wind down")

    def test_whitespace_only_clears_the_name(self):
        self._name(name="Morning routine")
        self._name(name="   ")   # trims to "" -> clears
        self.plan.refresh_from_db()
        self.assertEqual(self.plan.name, "")

    def test_rejects_bad_input(self):
        self.assertEqual(self._name(name=123).status_code, 400)         # not a string
        self.assertEqual(self._name(name=None).status_code, 400)        # missing/null
        self.assertEqual(self._name().status_code, 400)                 # no 'name' key
        self.assertEqual(self._name(name="x" * 101).status_code, 400)   # too long
        # Exactly 100 chars is allowed.
        self.assertEqual(self._name(name="x" * 100).status_code, 200)

    def test_unknown_plan_id_errors(self):
        self.assertEqual(self._name(plan_id=999999, name="Nope").status_code, 400)

    def test_plan_shape_unchanged_plus_name(self):
        # Every group still has the original keys, and now a "name" too. An
        # unnamed block (and the trailing "Anytime" group) report "".
        groups = json.loads(self.client.get(reverse("habits:plan")).content)
        for g in groups:
            self.assertEqual(
                set(g.keys()), {"id", "time", "name", "habits"}
            )
        self.assertEqual(self._block_name(self.plan.id), "")  # unnamed -> ""
        anytime = next(g for g in groups if g["id"] is None)
        self.assertEqual(anytime["name"], "")                 # Anytime is never named


class SkipDayTests(TestCase):
    """Skip every habit for a whole day in one tap (e.g. out of town), without
    erasing anything you'd already completed."""

    def setUp(self):
        self.today = timezone.localdate()
        self.url = reverse("habits:skip_day")
        self.a = Habit.objects.create(name="A")
        self.b = Habit.objects.create(name="B")
        self.c = Habit.objects.create(name="C")

    def _skip(self, **body):
        return self.client.post(self.url, data=body, content_type="application/json")

    def _status(self, habit, date=None):
        return HabitLog.objects.get(habit=habit, date=date or self.today).status

    def test_skips_every_habit_today(self):
        response = self._skip()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.content)["skipped"], 3)
        for habit in (self.a, self.b, self.c):
            self.assertEqual(self._status(habit), "SKIPPED")

    def test_keeps_completions(self):
        HabitLog.objects.create(
            habit=self.a, date=self.today, status=HabitLog.Status.COMPLETED
        )
        body = json.loads(self._skip().content)
        self.assertEqual(body["skipped"], 2)
        self.assertEqual(body["kept_completed"], 1)
        self.assertEqual(self._status(self.a), "COMPLETED")  # win preserved
        self.assertEqual(self._status(self.b), "SKIPPED")

    def test_idempotent_no_duplicate_logs(self):
        self._skip()
        self._skip()
        self.assertEqual(HabitLog.objects.filter(date=self.today).count(), 3)

    def test_only_skips_habits_that_existed_that_day(self):
        # All three were created today, so two days ago none existed.
        two_days_ago = (self.today - timedelta(days=2)).isoformat()
        body = json.loads(self._skip(date=two_days_ago).content)
        self.assertEqual(body["skipped"], 0)
        self.assertEqual(HabitLog.objects.count(), 0)

    def test_rejects_bad_date(self):
        self.assertEqual(self._skip(date="nope").status_code, 400)


class NotesTests(TestCase):
    """A per-day note lives on that day's HabitLog and is settable on its own,
    without marking the habit done."""

    def setUp(self):
        self.today = timezone.localdate()
        self.habit = Habit.objects.create(name="Stretch")
        self.plan = Plan.objects.create()
        Schedule.objects.create(habit=self.habit, plan=self.plan, order=1)
        self.log_url = reverse("habits:log_habit", args=[self.habit.id])

    def _plan_note(self):
        groups = json.loads(self.client.get(reverse("habits:plan")).content)
        for group in groups:
            for habit in group["habits"]:
                if habit["id"] == self.habit.id:
                    return habit["notes"]
        return None

    def _post(self, **body):
        return self.client.post(self.log_url, data=body, content_type="application/json")

    def test_plan_reports_the_note(self):
        self.assertEqual(self._plan_note(), "")  # no log yet
        HabitLog.objects.create(habit=self.habit, date=self.today, notes="before bed")
        self.assertEqual(self._plan_note(), "before bed")

    def test_note_settable_without_status(self):
        response = self._post(notes="buy milk")
        self.assertEqual(response.status_code, 200)
        body = json.loads(response.content)
        self.assertEqual(body["notes"], "buy milk")
        self.assertEqual(body["status"], "PENDING")  # a note didn't complete it
        log = HabitLog.objects.get(habit=self.habit, date=self.today)
        self.assertEqual((log.notes, log.status), ("buy milk", "PENDING"))

    def test_changing_status_later_keeps_the_note(self):
        self._post(notes="keep me")
        self._post(status="COMPLETED")
        log = HabitLog.objects.get(habit=self.habit, date=self.today)
        self.assertEqual((log.notes, log.status), ("keep me", "COMPLETED"))

    def test_empty_body_rejected(self):
        self.assertEqual(self._post().status_code, 400)

    def test_non_string_note_rejected(self):
        self.assertEqual(self._post(notes=5).status_code, 400)


class ClearDayTests(TestCase):
    """Undo a day: drop its skips and time shifts, keep completions and notes."""

    def setUp(self):
        self.today = timezone.localdate()
        self.url = reverse("habits:clear_day")
        self.a = Habit.objects.create(name="A")
        self.b = Habit.objects.create(name="B")
        self.plan = Plan.objects.create(start_time=time(9, 0))

    def _clear(self, **body):
        return self.client.post(self.url, data=body, content_type="application/json")

    def test_drops_skips_and_shifts_keeps_completion(self):
        HabitLog.objects.create(habit=self.a, date=self.today, status=HabitLog.Status.COMPLETED)
        HabitLog.objects.create(habit=self.b, date=self.today, status=HabitLog.Status.SKIPPED)
        PlanDay.objects.create(plan=self.plan, date=self.today, start_time=time(9, 45))

        response = self._clear()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(HabitLog.objects.filter(habit=self.a, status="COMPLETED").exists())
        self.assertFalse(HabitLog.objects.filter(habit=self.b).exists())  # skip removed
        self.assertFalse(PlanDay.objects.filter(date=self.today).exists())  # shift removed

    def test_keeps_a_note_but_resets_its_status(self):
        HabitLog.objects.create(
            habit=self.a, date=self.today, status=HabitLog.Status.SKIPPED, notes="away"
        )
        self._clear()
        log = HabitLog.objects.get(habit=self.a, date=self.today)
        self.assertEqual((log.status, log.notes), ("PENDING", "away"))

    def test_unfreezes_the_arrangement_keeping_completions(self):
        # A frozen, rearranged day: clearing it drops the ScheduleDay rows so the
        # day reverts to the template, while a completion on that day survives.
        Schedule.objects.create(habit=self.a, plan=self.plan, order=1)
        Schedule.objects.create(habit=self.b, plan=self.plan, order=2)
        HabitLog.objects.create(
            habit=self.a, date=self.today, status=HabitLog.Status.COMPLETED
        )

        # Freeze + rearrange today via /days/arrange/ (swap A and B's order).
        s_a = Schedule.objects.get(habit=self.a)
        s_b = Schedule.objects.get(habit=self.b)
        arrange = self.client.post(
            reverse("habits:arrange_day"),
            data=json.dumps({
                "date": self.today.isoformat(),
                "items": [{"id": s_a.id, "order": 2}, {"id": s_b.id, "order": 1}],
            }),
            content_type="application/json",
        )
        self.assertEqual(arrange.status_code, 200)
        self.assertTrue(ScheduleDay.objects.filter(date=self.today).exists())

        response = self._clear()
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["arrangement_cleared"], 2)  # both ScheduleDay rows gone

        # Day un-frozen: no ScheduleDay rows, /plan/ reverts to the template order.
        self.assertFalse(ScheduleDay.objects.filter(date=self.today).exists())
        groups = self.client.get(
            reverse("habits:plan"), {"date": self.today.isoformat()}
        ).json()
        rows = [h for g in groups for h in g["habits"]]
        order_by_habit = {h["id"]: h["order"] for h in rows}
        self.assertEqual(order_by_habit[self.a.id], 1)  # back to template order
        self.assertEqual(order_by_habit[self.b.id], 2)
        # The completion survived the un-freeze.
        self.assertTrue(
            HabitLog.objects.filter(habit=self.a, status="COMPLETED").exists()
        )

    def test_rejects_bad_date(self):
        self.assertEqual(self._clear(date="nope").status_code, 400)


class NoteApiTests(TestCase):
    """The shared per-day Note model: create / read / edit (all vs one,
    copy-on-write) / delete (all vs one, with the orphan rule)."""

    def setUp(self):
        self.today = timezone.localdate()
        self.a = Habit.objects.create(name="A")
        self.b = Habit.objects.create(name="B")

    def _create(self, **body):
        return self.client.post(
            reverse("habits:create_note"), data=body, content_type="application/json"
        )

    def _edit(self, note_id, **body):
        return self.client.post(
            reverse("habits:edit_note", args=[note_id]),
            data=body, content_type="application/json",
        )

    def _delete(self, note_id, **body):
        return self.client.post(
            reverse("habits:delete_note", args=[note_id]),
            data=body, content_type="application/json",
        )

    def _day_notes(self, date=None):
        url = reverse("habits:day_notes")
        if date:
            url += f"?date={date}"
        return json.loads(self.client.get(url).content)

    # --- create ---
    def test_create_for_one_habit(self):
        resp = self._create(body="felt good", habits=[self.a.id])
        self.assertEqual(resp.status_code, 201)
        data = json.loads(resp.content)
        self.assertEqual(data["body"], "felt good")
        self.assertEqual(data["habits"], [self.a.id])
        self.assertFalse(data["shared"])
        self.assertEqual(Note.objects.count(), 1)

    def test_create_shared_across_habits(self):
        resp = self._create(body="rough day", habits=[self.a.id, self.b.id])
        data = json.loads(resp.content)
        self.assertEqual(data["habits"], sorted([self.a.id, self.b.id]))
        self.assertTrue(data["shared"])

    def test_create_trims_and_requires_body(self):
        self.assertEqual(self._create(body="   ", habits=[self.a.id]).status_code, 400)
        self.assertEqual(self._create(habits=[self.a.id]).status_code, 400)

    def test_create_requires_habits(self):
        self.assertEqual(self._create(body="x", habits=[]).status_code, 400)
        self.assertEqual(self._create(body="x").status_code, 400)

    def test_create_rejects_unknown_habit(self):
        self.assertEqual(self._create(body="x", habits=[999999]).status_code, 400)

    # --- read ---
    def test_day_notes_lists_for_the_day(self):
        self._create(body="today note", habits=[self.a.id])
        notes = self._day_notes()
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]["body"], "today note")

    def test_day_notes_honors_date(self):
        self._create(body="today", habits=[self.a.id])
        other = (self.today - timedelta(days=3)).isoformat()
        self.assertEqual(self._day_notes(date=other), [])

    # --- edit all ---
    def test_edit_all_updates_in_place(self):
        note = json.loads(self._create(body="v1", habits=[self.a.id, self.b.id]).content)
        resp = self._edit(note["id"], body="v2", scope="all")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(json.loads(resp.content)["body"], "v2")
        self.assertEqual(Note.objects.count(), 1)  # no fork
        self.assertEqual(Note.objects.get(id=note["id"]).body, "v2")

    # --- edit one ---
    def test_edit_one_on_shared_note_forks(self):
        note = json.loads(self._create(body="v1", habits=[self.a.id, self.b.id]).content)
        resp = self._edit(note["id"], body="just A", scope="one", habit=self.a.id)
        self.assertEqual(resp.status_code, 201)
        forked = json.loads(resp.content)
        # New note holds only A with the new text...
        self.assertEqual(forked["habits"], [self.a.id])
        self.assertEqual(forked["body"], "just A")
        self.assertNotEqual(forked["id"], note["id"])
        # ...original keeps B with the old text.
        original = Note.objects.get(id=note["id"])
        self.assertEqual(list(original.habits.values_list("id", flat=True)), [self.b.id])
        self.assertEqual(original.body, "v1")
        self.assertEqual(Note.objects.count(), 2)

    def test_edit_one_on_solo_note_edits_in_place(self):
        note = json.loads(self._create(body="v1", habits=[self.a.id]).content)
        resp = self._edit(note["id"], body="v2", scope="one", habit=self.a.id)
        self.assertEqual(resp.status_code, 200)  # plain edit, not a fork
        self.assertEqual(Note.objects.count(), 1)
        self.assertEqual(Note.objects.get(id=note["id"]).body, "v2")

    def test_edit_one_requires_linked_habit(self):
        note = json.loads(self._create(body="v1", habits=[self.a.id]).content)
        self.assertEqual(
            self._edit(note["id"], body="x", scope="one", habit=self.b.id).status_code, 400
        )

    # --- delete all ---
    def test_delete_all_removes_note(self):
        note = json.loads(self._create(body="bye", habits=[self.a.id, self.b.id]).content)
        resp = self._delete(note["id"], scope="all")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(json.loads(resp.content)["note_deleted"])
        self.assertEqual(Note.objects.count(), 0)

    # --- delete one ---
    def test_delete_one_unlinks_and_keeps_shared_note(self):
        note = json.loads(self._create(body="shared", habits=[self.a.id, self.b.id]).content)
        resp = self._delete(note["id"], scope="one", habit=self.a.id)
        data = json.loads(resp.content)
        self.assertFalse(data["note_deleted"])
        self.assertEqual(data["remaining_habits"], 1)
        original = Note.objects.get(id=note["id"])
        self.assertEqual(list(original.habits.values_list("id", flat=True)), [self.b.id])

    def test_delete_one_orphan_deletes_note(self):
        note = json.loads(self._create(body="solo", habits=[self.a.id]).content)
        resp = self._delete(note["id"], scope="one", habit=self.a.id)
        data = json.loads(resp.content)
        self.assertTrue(data["note_deleted"])  # last habit removed -> note gone
        self.assertEqual(Note.objects.count(), 0)


class RoutineApiTests(TestCase):
    """Create / list / rename / delete a routine, manage its membership, and
    confirm `/plan/` and reorder expose the routine tag."""

    def setUp(self):
        self.plan = Plan.objects.create()
        self.brush = Habit.objects.create(name="Brush teeth")
        self.wash = Habit.objects.create(name="Wash face")
        self.s_brush = Schedule.objects.create(habit=self.brush, plan=self.plan, order=1)
        self.s_wash = Schedule.objects.create(habit=self.wash, plan=self.plan, order=2)

    def _create(self, **body):
        return self.client.post(
            reverse("habits:create_routine"),
            data=body, content_type="application/json",
        )

    def test_create_empty_routine(self):
        resp = self._create(name="Morning routine")
        self.assertEqual(resp.status_code, 201)
        data = json.loads(resp.content)
        self.assertEqual(data["name"], "Morning routine")
        self.assertEqual(data["schedules"], [])
        self.assertEqual(Routine.objects.count(), 1)

    def test_create_with_initial_members(self):
        resp = self._create(name="Morning", schedules=[self.s_brush.id, self.s_wash.id])
        self.assertEqual(resp.status_code, 201)
        data = json.loads(resp.content)
        self.assertCountEqual(data["schedules"], [self.s_brush.id, self.s_wash.id])
        self.s_brush.refresh_from_db()
        self.assertEqual(self.s_brush.routine_id, data["id"])

    def test_create_requires_name(self):
        self.assertEqual(self._create(name="   ").status_code, 400)
        self.assertEqual(self._create(schedules=[self.s_brush.id]).status_code, 400)

    def test_create_rejects_long_name(self):
        self.assertEqual(self._create(name="x" * 101).status_code, 400)

    def test_create_rejects_unknown_schedule(self):
        resp = self._create(name="Morning", schedules=[999999])
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(Routine.objects.count(), 0)  # nothing created on failure

    def test_list_routines(self):
        Routine.objects.create(name="Night")
        Routine.objects.create(name="Gym")
        data = json.loads(self.client.get(reverse("habits:routines")).content)
        self.assertEqual([r["name"] for r in data], ["Gym", "Night"])  # name-sorted

    def test_edit_renames(self):
        r = Routine.objects.create(name="Mrning")
        resp = self.client.post(
            reverse("habits:edit_routine", args=[r.id]),
            data={"name": "Morning"}, content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        r.refresh_from_db()
        self.assertEqual(r.name, "Morning")

    def test_edit_rejects_blank(self):
        r = Routine.objects.create(name="Morning")
        resp = self.client.post(
            reverse("habits:edit_routine", args=[r.id]),
            data={"name": ""}, content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_delete_ungroups_members_but_keeps_habits(self):
        r = Routine.objects.create(name="Morning")
        Schedule.objects.filter(id=self.s_brush.id).update(routine=r)
        resp = self.client.post(reverse("habits:delete_routine", args=[r.id]))
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(json.loads(resp.content)["ungrouped"], 1)
        self.assertEqual(Routine.objects.count(), 0)
        self.s_brush.refresh_from_db()
        self.assertIsNone(self.s_brush.routine_id)        # ungrouped...
        self.assertTrue(Schedule.objects.filter(id=self.s_brush.id).exists())  # ...not deleted
        self.assertTrue(Habit.objects.filter(id=self.brush.id).exists())

    def test_members_add_and_remove(self):
        r = Routine.objects.create(name="Morning")
        url = reverse("habits:routine_members", args=[r.id])
        self.client.post(
            url, data={"add": [self.s_brush.id, self.s_wash.id]},
            content_type="application/json",
        )
        self.s_brush.refresh_from_db(); self.s_wash.refresh_from_db()
        self.assertEqual(self.s_brush.routine_id, r.id)
        self.assertEqual(self.s_wash.routine_id, r.id)

        self.client.post(
            url, data={"remove": [self.s_brush.id]}, content_type="application/json",
        )
        self.s_brush.refresh_from_db()
        self.assertIsNone(self.s_brush.routine_id)

    def test_members_remove_only_from_this_routine(self):
        # s_brush belongs to routine A; removing it via routine B must not touch it.
        a = Routine.objects.create(name="A")
        b = Routine.objects.create(name="B")
        Schedule.objects.filter(id=self.s_brush.id).update(routine=a)
        self.client.post(
            reverse("habits:routine_members", args=[b.id]),
            data={"remove": [self.s_brush.id]}, content_type="application/json",
        )
        self.s_brush.refresh_from_db()
        self.assertEqual(self.s_brush.routine_id, a.id)  # still in A

    def test_members_requires_something(self):
        r = Routine.objects.create(name="Morning")
        resp = self.client.post(
            reverse("habits:routine_members", args=[r.id]),
            data={}, content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_plan_exposes_routine_fields(self):
        r = Routine.objects.create(name="Morning routine")
        Schedule.objects.filter(id=self.s_brush.id).update(routine=r)
        groups = json.loads(self.client.get(reverse("habits:plan")).content)
        by_id = {h["id"]: h for g in groups for h in g["habits"]}
        self.assertEqual(by_id[self.brush.id]["routine"], r.id)
        self.assertEqual(by_id[self.brush.id]["routine_name"], "Morning routine")
        self.assertIsNone(by_id[self.wash.id]["routine"])        # ungrouped habit
        self.assertIsNone(by_id[self.wash.id]["routine_name"])

    def test_reorder_can_set_routine(self):
        r = Routine.objects.create(name="Morning")
        resp = self.client.post(
            reverse("habits:reorder_schedules"),
            data={"items": [{"id": self.s_brush.id, "order": 1, "routine": r.id}]},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(json.loads(resp.content)["updated"][0]["routine"], r.id)
        self.s_brush.refresh_from_db()
        self.assertEqual(self.s_brush.routine_id, r.id)

    def test_reorder_rejects_unknown_routine(self):
        resp = self.client.post(
            reverse("habits:reorder_schedules"),
            data={"items": [{"id": self.s_brush.id, "order": 1, "routine": 999999}]},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_reorder_can_move_to_another_plan(self):
        # Cross-block drag: send the moved row with its new `plan`.
        other = Plan.objects.create()
        resp = self.client.post(
            reverse("habits:reorder_schedules"),
            data={"items": [{"id": self.s_brush.id, "order": 1, "plan": other.id}]},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(json.loads(resp.content)["updated"][0]["plan"], other.id)
        self.s_brush.refresh_from_db()
        self.assertEqual(self.s_brush.plan_id, other.id)

    def test_reorder_rejects_unknown_plan(self):
        resp = self.client.post(
            reverse("habits:reorder_schedules"),
            data={"items": [{"id": self.s_brush.id, "order": 1, "plan": 999999}]},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)
        self.s_brush.refresh_from_db()
        self.assertEqual(self.s_brush.plan_id, self.plan.id)  # unchanged on failure

    def test_reorder_omitting_plan_keeps_block(self):
        resp = self.client.post(
            reverse("habits:reorder_schedules"),
            data={"items": [{"id": self.s_brush.id, "order": 5}]},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.s_brush.refresh_from_db()
        self.assertEqual(self.s_brush.plan_id, self.plan.id)  # block unchanged

    def test_plan_no_longer_exposes_chain(self):
        # The Chain model is gone (Phase B), so no /plan/ row carries a "chain"
        # key anymore — the frontend must stop reading it.
        groups = json.loads(self.client.get(reverse("habits:plan")).content)
        rows = [h for g in groups for h in g["habits"]]
        self.assertTrue(rows)                                  # we have habits to check
        self.assertTrue(all("chain" not in h for h in rows))

    def test_reorder_ignores_a_stray_chain_key(self):
        # An older client may still send "chain"; it's ignored (not 400'd) and the
        # rest of the reorder still applies.
        resp = self.client.post(
            reverse("habits:reorder_schedules"),
            data={"items": [{"id": self.s_brush.id, "order": 7, "chain": 999999}]},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        updated = json.loads(resp.content)["updated"][0]
        self.assertEqual(updated["order"], 7)
        self.assertNotIn("chain", updated)                    # not echoed back
        self.s_brush.refresh_from_db()
        self.assertEqual(self.s_brush.order, 7)               # reorder applied

    def test_create_schedule_places_unscheduled_habit(self):
        solo = Habit.objects.create(name="Journal")  # no schedule -> "Anytime"
        resp = self.client.post(
            reverse("habits:create_schedule"),
            data={"habit": solo.id, "plan": self.plan.id},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 201)
        data = json.loads(resp.content)
        self.assertEqual(data["plan"], self.plan.id)
        self.assertEqual(data["order"], 3)  # appends after s_brush(1), s_wash(2)
        self.assertTrue(
            Schedule.objects.filter(
                id=data["schedule_id"], habit=solo, plan=self.plan
            ).exists()
        )

    def test_create_schedule_rejects_unknown_habit(self):
        resp = self.client.post(
            reverse("habits:create_schedule"),
            data={"habit": 999999, "plan": self.plan.id},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_create_schedule_rejects_unknown_plan(self):
        solo = Habit.objects.create(name="Journal")
        resp = self.client.post(
            reverse("habits:create_schedule"),
            data={"habit": solo.id, "plan": 999999},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)


class RoutineLogTests(TestCase):
    """`routines/<id>/log/` fans one status out to every member habit — the
    block's complete / skip / undo action."""

    def setUp(self):
        self.today = timezone.localdate()
        self.yesterday = self.today - timedelta(days=1)
        self.plan = Plan.objects.create()
        self.routine = Routine.objects.create(name="Morning")
        self.brush = Habit.objects.create(name="Brush teeth")
        self.wash = Habit.objects.create(name="Wash face")
        Schedule.objects.create(habit=self.brush, plan=self.plan, order=1, routine=self.routine)
        Schedule.objects.create(habit=self.wash, plan=self.plan, order=2, routine=self.routine)
        self.url = reverse("habits:log_routine", args=[self.routine.id])

    def _log(self, **body):
        return self.client.post(self.url, data=body, content_type="application/json")

    def _status(self, habit, date=None):
        return HabitLog.objects.get(habit=habit, date=date or self.today).status

    def test_complete_block_marks_all_completed(self):
        resp = self._log(status="COMPLETED")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(json.loads(resp.content)["updated"], 2)
        self.assertEqual(self._status(self.brush), "COMPLETED")
        self.assertEqual(self._status(self.wash), "COMPLETED")

    def test_skip_block_marks_all_skipped(self):
        self._log(status="SKIPPED")
        self.assertEqual(self._status(self.brush), "SKIPPED")
        self.assertEqual(self._status(self.wash), "SKIPPED")

    def test_undo_block_resets_all_pending(self):
        self._log(status="COMPLETED")
        self._log(status="PENDING")
        self.assertEqual(self._status(self.brush), "PENDING")
        self.assertEqual(self._status(self.wash), "PENDING")

    def test_complete_overwrites_existing_member_log(self):
        HabitLog.objects.create(habit=self.brush, date=self.today, status="SKIPPED")
        self._log(status="COMPLETED")
        self.assertEqual(self._status(self.brush), "COMPLETED")

    def test_log_upserts_one_per_habit_per_day(self):
        self._log(status="COMPLETED")
        self._log(status="SKIPPED")
        self.assertEqual(HabitLog.objects.filter(date=self.today).count(), 2)

    def test_log_targets_the_given_day(self):
        self._log(status="COMPLETED", date=self.yesterday.isoformat())
        self.assertEqual(self._status(self.brush, self.yesterday), "COMPLETED")
        self.assertFalse(HabitLog.objects.filter(habit=self.brush, date=self.today).exists())

    def test_rejects_bad_status(self):
        self.assertEqual(self._log(status="NOPE").status_code, 400)
        self.assertEqual(self._log(status="bogus").status_code, 400)

    def test_empty_routine_is_a_noop(self):
        empty = Routine.objects.create(name="Empty")
        resp = self.client.post(
            reverse("habits:log_routine", args=[empty.id]),
            data={"status": "COMPLETED"}, content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(json.loads(resp.content)["updated"], 0)


class HabitsListTests(TestCase):
    """`/habits/` lists ALL habits with their tiers and today's status — the
    Habits overview page. One row per habit (never per Schedule slot)."""

    def setUp(self):
        self.today = timezone.localdate()
        # Two areas, deliberately out of alphabetical creation order so the
        # name-ordering assertion is meaningful.
        self.mind = Area.objects.create(name="Mind")
        self.body = Area.objects.create(name="Body")

        # A tiered habit (Meditate) in Mind: Roots -> Growth, with values. A main
        # habit (is_support defaults False), so it shows on the Habits page.
        self.meditate = Habit.objects.create(
            name="Meditate", area=self.mind
        )
        self._add_tier(self.meditate, level=1, value="2 min")
        self._add_tier(self.meditate, level=2, value="10 min")

        # An untiered habit (Run) in Body.
        self.run = Habit.objects.create(name="Run", area=self.body)

    def _add_tier(self, habit, *, level, value):
        """Mirror add_habit_tier: ensure the HabitTier exists and append a value
        dated today (the newest TierValue is the current value)."""
        tier, _ = Tier.objects.get_or_create(level=level)
        habit_tier, _ = HabitTier.objects.get_or_create(habit=habit, tier=tier)
        TierValue.objects.create(
            habit_tier=habit_tier, value=value, started=self.today
        )

    def _get(self):
        resp = self.client.get(reverse("habits:habits_list"))
        self.assertEqual(resp.status_code, 200)
        return json.loads(resp.content)

    def _by_id(self, data):
        return {h["id"]: h for h in data}

    def test_returns_all_habits_with_correct_shape(self):
        data = self._get()
        self.assertEqual(len(data), 2)
        row = self._by_id(data)[self.meditate.id]
        self.assertEqual(
            set(row.keys()),
            {"id", "name", "area", "area_name", "is_support",
             "tiers", "status"},
        )
        self.assertEqual(row["id"], self.meditate.id)
        self.assertEqual(row["name"], "Meditate")
        self.assertEqual(row["area"], self.mind.id)
        self.assertEqual(row["area_name"], "Mind")
        self.assertFalse(row["is_support"])  # a main habit, not a helper

    def test_untiered_habit_has_empty_tiers(self):
        row = self._by_id(self._get())[self.run.id]
        self.assertEqual(row["tiers"], [])

    def test_tiered_habit_lists_tiers_low_to_high_with_current_values(self):
        row = self._by_id(self._get())[self.meditate.id]
        self.assertEqual(
            row["tiers"],
            [
                {"level": 1, "name": "Roots", "value": "2 min",
                 "status": "PENDING", "done": False},
                {"level": 2, "name": "Growth", "value": "10 min",
                 "status": "PENDING", "done": False},
            ],
        )

    def test_tier_value_uses_the_newest_tiervalue(self):
        # Bump Roots to a new value; the newest started date wins.
        self._add_tier(self.meditate, level=1, value="5 min")
        roots = next(
            t for t in self._by_id(self._get())[self.meditate.id]["tiers"]
            if t["level"] == 1
        )
        self.assertEqual(roots["value"], "5 min")

    def test_completed_habit_reflects_today_status_and_tier(self):
        tier2 = Tier.objects.get(level=2)
        HabitLog.objects.create(
            habit=self.meditate, date=self.today,
            status=HabitLog.Status.COMPLETED, tier=tier2,
        )
        row = self._by_id(self._get())[self.meditate.id]
        # Whole-habit status reads done when any version is done.
        self.assertEqual(row["status"], "COMPLETED")
        # Completing Growth cascades down: Roots reads done too.
        by_level = {t["level"]: t for t in row["tiers"]}
        self.assertTrue(by_level[2]["done"])
        self.assertTrue(by_level[1]["done"])

    def test_no_log_today_is_pending_with_null_tier(self):
        row = self._by_id(self._get())[self.run.id]
        self.assertEqual(row["status"], "PENDING")
        self.assertEqual(row["tiers"], [])

    def test_habit_with_two_schedule_rows_appears_once(self):
        # Two tier-slots for the same habit at two times -> two Schedule rows.
        # The list must still show the habit exactly once (the duplicate guard).
        plan_a = Plan.objects.create(start_time=time(7, 0))
        plan_b = Plan.objects.create(start_time=time(11, 0))
        Schedule.objects.create(habit=self.meditate, plan=plan_a, order=1)
        Schedule.objects.create(habit=self.meditate, plan=plan_b, order=1)

        data = self._get()
        ids = [h["id"] for h in data]
        self.assertEqual(ids.count(self.meditate.id), 1)
        self.assertEqual(len(data), 2)

    def test_habit_with_no_area_has_null_area_fields(self):
        Habit.objects.create(name="Floating")
        row = next(h for h in self._get() if h["name"] == "Floating")
        self.assertIsNone(row["area"])
        self.assertIsNone(row["area_name"])

    def test_ordered_by_area_name_then_habit_name(self):
        # Add a second Body habit that sorts before "Run" by name.
        Habit.objects.create(name="Lift", area=self.body)
        names = [(h["area_name"], h["name"]) for h in self._get()]
        # Body (B) before Mind (M); within Body, Lift before Run.
        self.assertEqual(
            names, [("Body", "Lift"), ("Body", "Run"), ("Mind", "Meditate")]
        )


class ReorderHabitsTests(TestCase):
    """POST /habits/reorder/ persists a hand-picked order on Habit.order, which
    drives the Habits page list order: placed habits first (by order), unplaced
    (null) ones last by name."""

    def setUp(self):
        # Created out of alphabetical order; with no order set they fall back to
        # name ordering, so a custom order is observable against that baseline.
        self.a = Habit.objects.create(name="Apple")
        self.b = Habit.objects.create(name="Banana")
        self.c = Habit.objects.create(name="Cherry")

    def _reorder(self, items):
        return self.client.post(
            reverse("habits:reorder_habits"),
            data=json.dumps({"items": items}),
            content_type="application/json",
        )

    def _list_names(self):
        resp = self.client.get(reverse("habits:habits_list"))
        self.assertEqual(resp.status_code, 200)
        return [h["name"] for h in json.loads(resp.content)]

    def test_baseline_is_name_order_before_any_reorder(self):
        self.assertEqual(self._list_names(), ["Apple", "Banana", "Cherry"])

    def test_reorder_sets_order_and_list_reflects_it(self):
        resp = self._reorder([
            {"id": self.c.id, "order": 0},
            {"id": self.a.id, "order": 1},
            {"id": self.b.id, "order": 2},
        ])
        self.assertEqual(resp.status_code, 200)
        for h in (self.a, self.b, self.c):
            h.refresh_from_db()
        self.assertEqual((self.c.order, self.a.order, self.b.order), (0, 1, 2))
        self.assertEqual(self._list_names(), ["Cherry", "Apple", "Banana"])

    def test_unplaced_habits_sort_after_placed_ones(self):
        # Only place Cherry; Apple/Banana stay null and sort after it, by name.
        self._reorder([{"id": self.c.id, "order": 0}])
        self.assertEqual(self._list_names(), ["Cherry", "Apple", "Banana"])

    def test_items_must_be_a_non_empty_list(self):
        for bad in ({}, [], "x"):
            resp = self.client.post(
                reverse("habits:reorder_habits"),
                data=json.dumps({"items": bad}),
                content_type="application/json",
            )
            self.assertEqual(resp.status_code, 400)

    def test_item_needs_integer_id_and_order(self):
        self.assertEqual(self._reorder([{"id": self.a.id, "order": "1"}]).status_code, 400)
        # bool is a subclass of int, so it must be rejected explicitly.
        self.assertEqual(self._reorder([{"id": True, "order": 0}]).status_code, 400)

    def test_unknown_habit_id_is_400_and_changes_nothing(self):
        resp = self._reorder([
            {"id": self.a.id, "order": 0},
            {"id": 999999, "order": 1},
        ])
        self.assertEqual(resp.status_code, 400)
        self.a.refresh_from_db()
        self.assertIsNone(self.a.order)   # all-or-nothing: nothing applied


class CreatePlanTests(TestCase):
    """`plans/create/` adds a new time block (or reuses the one at that time)."""

    def _create(self, time_str):
        return self.client.post(
            reverse("habits:create_plan"),
            data={"time": time_str}, content_type="application/json",
        )

    def test_creates_block_at_time(self):
        resp = self._create("10:45")
        self.assertEqual(resp.status_code, 201)
        data = json.loads(resp.content)
        self.assertTrue(data["created"])
        self.assertTrue(Plan.objects.filter(id=data["id"], start_time=time(10, 45)).exists())

    def test_reuses_existing_time(self):
        first = json.loads(self._create("10:45").content)
        resp = self._create("10:45")
        self.assertEqual(resp.status_code, 200)
        second = json.loads(resp.content)
        self.assertFalse(second["created"])
        self.assertEqual(first["id"], second["id"])  # same block, not a duplicate
        self.assertEqual(Plan.objects.filter(start_time=time(10, 45)).count(), 1)

    def test_rejects_bad_time(self):
        self.assertEqual(self._create("25:00").status_code, 400)
        self.assertEqual(self._create("nope").status_code, 400)


class PerVersionStatusTests(TestCase):
    """Each tier/version carries its OWN status (docs/contracts/per-version-status.md):
    completing a LOWER version never closes a HIGHER one; completing a HIGHER one
    cascades down; MISSED is settable; a whole-habit row covers every version."""

    def setUp(self):
        self.today = timezone.localdate()
        self.yesterday = self.today - timedelta(days=1)
        # "Drink water": Roots = 30 oz, Growth = 90 oz. Backdated so it exists on
        # past days (the /plan/ "didn't exist yet" filter would hide it otherwise).
        self.water = Habit.objects.create(name="Drink water")
        Habit.objects.filter(id=self.water.id).update(
            date_added=timezone.now() - timedelta(days=30)
        )
        self.roots = self._tier(1)
        self.growth = self._tier(2)
        self._add_tier(1, "30 oz")
        self._add_tier(2, "90 oz")
        # Two slots at two times, each fixed to a tier (wake-up style).
        self.early = Plan.objects.create(start_time=time(9, 0))
        self.late = Plan.objects.create(start_time=time(15, 0))
        Schedule.objects.create(habit=self.water, plan=self.early, tier=self.growth, order=1)
        Schedule.objects.create(habit=self.water, plan=self.late, tier=self.roots, order=1)

    def _tier(self, level):
        t, _ = Tier.objects.get_or_create(level=level)
        return t

    def _add_tier(self, level, value):
        ht, _ = HabitTier.objects.get_or_create(habit=self.water, tier=self._tier(level))
        TierValue.objects.create(habit_tier=ht, value=value, started=self.today)

    def _log(self, status, tier=None, date=None):
        body = {"status": status}
        if tier is not None:
            body["tier"] = tier
        if date is not None:
            body["date"] = date
        return self.client.post(
            reverse("habits:log_habit", args=[self.water.id]),
            data=json.dumps(body), content_type="application/json",
        )

    def _versions(self, date=None):
        """{tier_level: status} across the water habit's slots on /plan/."""
        resp = self.client.get(reverse("habits:plan"), {"date": date} if date else {})
        return {
            h["tier"]: h["status"]
            for g in json.loads(resp.content) for h in g["habits"]
            if h["id"] == self.water.id
        }

    def test_completing_lower_does_not_touch_higher(self):
        # Drink 30 oz (Roots) now — 90 oz (Growth) stays open & reachable later.
        self.assertEqual(self._log("COMPLETED", tier=1).status_code, 200)
        versions = self._versions()
        self.assertEqual(versions[1], "COMPLETED")
        self.assertEqual(versions[2], "PENDING")

    def test_completing_higher_cascades_down(self):
        # Hit 90 oz (Growth) -> 30 oz (Roots) reads done too (you passed it).
        self.assertEqual(self._log("COMPLETED", tier=2).status_code, 200)
        versions = self._versions()
        self.assertEqual(versions[2], "COMPLETED")
        self.assertEqual(versions[1], "COMPLETED")

    def test_root_completed_growth_missed_coexist(self):
        # The exact thing the old single-log model couldn't express.
        self._log("COMPLETED", tier=1)
        self._log("MISSED", tier=2)
        versions = self._versions()
        self.assertEqual(versions[1], "COMPLETED")
        self.assertEqual(versions[2], "MISSED")
        self.assertEqual(
            HabitLog.objects.filter(habit=self.water, date=self.today).count(), 2
        )

    def test_missing_a_version_leaves_the_other_pending(self):
        self._log("MISSED", tier=2)
        versions = self._versions()
        self.assertEqual(versions[2], "MISSED")
        self.assertEqual(versions[1], "PENDING")

    def test_log_writes_one_row_per_version(self):
        self._log("COMPLETED", tier=1)
        self._log("COMPLETED", tier=2)
        rows = HabitLog.objects.filter(habit=self.water, date=self.today)
        self.assertEqual(sorted(r.tier.level for r in rows), [1, 2])

    def test_log_response_echoes_tier(self):
        data = json.loads(self._log("COMPLETED", tier=1).content)
        self.assertEqual((data["tier"], data["status"]), (1, "COMPLETED"))

    def test_missed_is_an_accepted_status(self):
        self.assertEqual(self._log("MISSED", tier=1).status_code, 200)

    def test_rejects_a_tier_the_habit_lacks(self):
        self.assertEqual(self._log("COMPLETED", tier=3).status_code, 400)  # no Flourish

    def test_whole_habit_skip_covers_every_version(self):
        self.client.post(
            reverse("habits:skip_day"),
            data=json.dumps({}), content_type="application/json",
        )
        versions = self._versions()
        self.assertEqual(versions[1], "SKIPPED")
        self.assertEqual(versions[2], "SKIPPED")

    def test_completing_a_version_overrides_a_blanket_skip(self):
        self.client.post(
            reverse("habits:skip_day"),
            data=json.dumps({}), content_type="application/json",
        )
        self._log("COMPLETED", tier=2)   # actually hit Growth after the blanket skip
        versions = self._versions()
        self.assertEqual(versions[2], "COMPLETED")
        self.assertEqual(versions[1], "COMPLETED")   # cascade still applies

    def test_past_pending_version_reads_missed(self):
        versions = self._versions(date=self.yesterday.isoformat())
        self.assertEqual(versions[1], "MISSED")
        self.assertEqual(versions[2], "MISSED")


class FreezeDayTests(TestCase):
    """A day gets a permanent "photo" (ScheduleDay rows) the first time it's
    viewed-as-past or edited, so later changes to the recurring plan can never
    rewrite it (docs/contracts/per-day-schedule.md). The arrangement source flips
    template -> frozen with no change to the /plan/ payload shape; /days/arrange/
    edits that photo, never the template."""

    def setUp(self):
        self.today = timezone.localdate()
        self.yesterday = self.today - timedelta(days=1)
        self.tomorrow = self.today + timedelta(days=1)

        # Two habits in one block. Backdated so they count as existing on past days
        # (the /plan/ "didn't exist yet" filter would hide them otherwise).
        self.plan = Plan.objects.create(start_time=time(9, 0))
        self.brush = Habit.objects.create(name="Brush teeth")
        self.wash = Habit.objects.create(name="Wash face")
        for h in (self.brush, self.wash):
            Habit.objects.filter(id=h.id).update(
                date_added=timezone.now() - timedelta(days=30)
            )
        self.s_brush = Schedule.objects.create(habit=self.brush, plan=self.plan, order=1)
        self.s_wash = Schedule.objects.create(habit=self.wash, plan=self.plan, order=2)

    def _arrange(self, **body):
        return self.client.post(
            reverse("habits:arrange_day"),
            data=json.dumps(body), content_type="application/json",
        )

    def _rows(self, response):
        """All habit payloads in a /plan/ response, keyed by row_id."""
        groups = json.loads(response.content)
        return {h["row_id"]: h for g in groups for h in g["habits"]}

    def _plan(self, date):
        return self.client.get(reverse("habits:plan"), {"date": date.isoformat()})

    # --- freeze helper -------------------------------------------------------

    def test_freeze_is_idempotent(self):
        first = freeze_day(self.yesterday)
        self.assertEqual(len(first), 2)                       # both slots snapshotted
        count = ScheduleDay.objects.filter(date=self.yesterday).count()
        self.assertEqual(count, 2)

        second = freeze_day(self.yesterday)
        self.assertEqual(second, {})                          # already frozen -> no-op
        # No duplicate rows from the second call.
        self.assertEqual(
            ScheduleDay.objects.filter(date=self.yesterday).count(), 2
        )

    def test_freeze_snapshots_name_plan_and_time(self):
        freeze_day(self.yesterday)
        sd = ScheduleDay.objects.get(date=self.yesterday, habit=self.brush)
        self.assertEqual(sd.habit_name, "Brush teeth")        # name snapshot
        self.assertEqual(sd.plan_id, self.plan.id)
        self.assertEqual(sd.order, 1)
        # The block's time is locked into PlanDay so time_by_plan serves it.
        pd = PlanDay.objects.get(date=self.yesterday, plan=self.plan)
        self.assertEqual(pd.start_time, time(9, 0))

    def test_freeze_copies_every_tier_slot(self):
        # A habit with two tier-slots (two times) must freeze BOTH rows.
        water = Habit.objects.create(name="Drink water")
        Habit.objects.filter(id=water.id).update(
            date_added=timezone.now() - timedelta(days=30)
        )
        roots, _ = Tier.objects.get_or_create(level=1)
        growth, _ = Tier.objects.get_or_create(level=2)
        late = Plan.objects.create(start_time=time(15, 0))
        Schedule.objects.create(habit=water, plan=self.plan, tier=growth, order=3)
        Schedule.objects.create(habit=water, plan=late, tier=roots, order=1)

        freeze_day(self.yesterday)
        slots = ScheduleDay.objects.filter(date=self.yesterday, habit=water)
        self.assertEqual(sorted(s.tier.level for s in slots), [1, 2])

    # --- /plan/ reads frozen days -------------------------------------------

    def test_viewing_a_past_day_freezes_it(self):
        self.assertFalse(ScheduleDay.objects.filter(date=self.yesterday).exists())
        resp = self._plan(self.yesterday)
        self.assertEqual(resp.status_code, 200)
        # The lazy "photo on first view" wrote the rows.
        self.assertEqual(
            ScheduleDay.objects.filter(date=self.yesterday).count(), 2
        )

    def test_today_and_future_are_not_frozen_on_view(self):
        self.client.get(reverse("habits:plan"))               # today
        self._plan(self.tomorrow)                              # future
        self.assertFalse(ScheduleDay.objects.filter(date=self.today).exists())
        self.assertFalse(ScheduleDay.objects.filter(date=self.tomorrow).exists())

    def test_frozen_day_payload_uses_scheduleday_row_id(self):
        self._plan(self.yesterday)                            # freeze it
        rows = self._rows(self._plan(self.yesterday))
        sd = ScheduleDay.objects.get(date=self.yesterday, habit=self.brush)
        self.assertIn(sd.id, rows)                            # keyed on ScheduleDay id
        self.assertEqual(rows[sd.id]["id"], self.brush.id)    # habit id unchanged
        self.assertIsNone(rows[sd.id]["schedule_id"])         # template id gone on a frozen row

    def test_template_day_payload_uses_schedule_row_id(self):
        # An unfrozen day (today) keys row_id on the Schedule id.
        rows = self._rows(self.client.get(reverse("habits:plan")))
        self.assertIn(self.s_brush.id, rows)
        self.assertEqual(rows[self.s_brush.id]["schedule_id"], self.s_brush.id)

    def test_editing_template_does_not_change_a_frozen_day(self):
        # THE CORE PROMISE. Freeze yesterday, then rip the habit off the template.
        self._plan(self.yesterday)
        before = self._rows(self._plan(self.yesterday))
        self.assertEqual(len(before), 2)

        # Edit the recurring plan: move brush to a new block, drop wash entirely.
        other = Plan.objects.create(start_time=time(18, 0))
        Schedule.objects.filter(id=self.s_brush.id).update(plan=other, order=9)
        self.s_wash.delete()

        after = self._rows(self._plan(self.yesterday))
        self.assertEqual(len(after), 2)                       # both still there
        self.assertCountEqual(
            [h["id"] for h in after.values()], [self.brush.id, self.wash.id]
        )
        # Brush still sits in its original block at its frozen order.
        brush_row = next(h for h in after.values() if h["id"] == self.brush.id)
        self.assertEqual(brush_row["order"], 1)

    # --- /days/arrange/ ------------------------------------------------------

    def test_arrange_reorders_a_frozen_day_without_touching_template(self):
        self._plan(self.yesterday)                            # freeze
        sd_brush = ScheduleDay.objects.get(date=self.yesterday, habit=self.brush)
        sd_wash = ScheduleDay.objects.get(date=self.yesterday, habit=self.wash)

        resp = self._arrange(
            date=self.yesterday.isoformat(),
            items=[{"id": sd_brush.id, "order": 2}, {"id": sd_wash.id, "order": 1}],
        )
        self.assertEqual(resp.status_code, 200)
        sd_brush.refresh_from_db(); sd_wash.refresh_from_db()
        self.assertEqual((sd_brush.order, sd_wash.order), (2, 1))
        # Template untouched.
        self.s_brush.refresh_from_db(); self.s_wash.refresh_from_db()
        self.assertEqual((self.s_brush.order, self.s_wash.order), (1, 2))

    def test_arrange_on_unfrozen_future_day_freezes_then_applies(self):
        # Tomorrow isn't frozen; arranging it with TEMPLATE ids freezes first,
        # translates the ids through the freeze map, then applies.
        self.assertFalse(ScheduleDay.objects.filter(date=self.tomorrow).exists())
        resp = self._arrange(
            date=self.tomorrow.isoformat(),
            items=[{"id": self.s_brush.id, "order": 5}],   # template id
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(
            ScheduleDay.objects.filter(date=self.tomorrow).count(), 2  # full freeze
        )
        sd_brush = ScheduleDay.objects.get(date=self.tomorrow, habit=self.brush)
        self.assertEqual(sd_brush.order, 5)
        self.s_brush.refresh_from_db()
        self.assertEqual(self.s_brush.order, 1)              # template untouched

    def test_arrange_moves_a_row_between_blocks_for_that_day(self):
        other = Plan.objects.create(start_time=time(18, 0))
        resp = self._arrange(
            date=self.tomorrow.isoformat(),
            items=[{"id": self.s_brush.id, "order": 1, "plan": other.id}],
        )
        self.assertEqual(resp.status_code, 200)
        sd_brush = ScheduleDay.objects.get(date=self.tomorrow, habit=self.brush)
        self.assertEqual(sd_brush.plan_id, other.id)
        self.s_brush.refresh_from_db()
        self.assertEqual(self.s_brush.plan_id, self.plan.id)  # template block unchanged

    def test_arrange_ignores_a_stray_chain_key(self):
        # The Chain model is gone (Phase B); a "chain" sent by an older client is
        # ignored rather than 400'd, and the reorder still applies for the day.
        resp = self._arrange(
            date=self.tomorrow.isoformat(),
            items=[{"id": self.s_brush.id, "order": 4, "chain": 999999}],
        )
        self.assertEqual(resp.status_code, 200)
        updated = json.loads(resp.content)["updated"][0]
        self.assertNotIn("chain", updated)                    # not echoed back
        sd_brush = ScheduleDay.objects.get(date=self.tomorrow, habit=self.brush)
        self.assertEqual(sd_brush.order, 4)                   # reorder applied

    def test_arrange_places_an_anytime_habit_for_that_day(self):
        # A habit with no Schedule row (sits in "Anytime") dragged into a block,
        # that day only -> a new ScheduleDay row, no Schedule row created.
        solo = Habit.objects.create(name="Journal")
        Habit.objects.filter(id=solo.id).update(
            date_added=timezone.now() - timedelta(days=30)
        )
        resp = self._arrange(
            date=self.tomorrow.isoformat(),
            items=[{"habit": solo.id, "plan": self.plan.id}],
        )
        self.assertEqual(resp.status_code, 200)
        sd = ScheduleDay.objects.get(date=self.tomorrow, habit=solo)
        self.assertEqual(sd.plan_id, self.plan.id)
        self.assertEqual(sd.habit_name, "Journal")           # name snapshot
        self.assertEqual(sd.order, 3)                         # appends after brush(1)+wash(2)
        # No Schedule (template) row was created — placement is per-day only.
        self.assertFalse(Schedule.objects.filter(habit=solo).exists())

    def test_arrange_requires_a_date(self):
        resp = self._arrange(items=[{"id": self.s_brush.id, "order": 1}])
        self.assertEqual(resp.status_code, 400)

    def test_arrange_rejects_unknown_row_id_on_frozen_day(self):
        self._plan(self.yesterday)                            # freeze
        resp = self._arrange(
            date=self.yesterday.isoformat(),
            items=[{"id": 999999, "order": 1}],
        )
        self.assertEqual(resp.status_code, 400)

    def test_arrange_rejects_bool_id(self):
        resp = self._arrange(
            date=self.tomorrow.isoformat(),
            items=[{"id": True, "order": 1}],
        )
        self.assertEqual(resp.status_code, 400)

    def test_arrange_persists_across_a_refetch(self):
        # End-to-end: arrange tomorrow, then /plan/ reflects the per-day edit.
        other = Plan.objects.create(start_time=time(18, 0))
        self._arrange(
            date=self.tomorrow.isoformat(),
            items=[{"id": self.s_brush.id, "order": 1, "plan": other.id}],
        )
        rows = self._rows(self._plan(self.tomorrow))
        sd_brush = ScheduleDay.objects.get(date=self.tomorrow, habit=self.brush)
        self.assertEqual(rows[sd_brush.id]["row_id"], sd_brush.id)


class PlanFreezeCatchupTests(TestCase):
    """Photograph-on-open: every /plan/ load freezes the last FREEZE_CATCHUP_DAYS
    past days that aren't frozen yet, so a day the user lived but never opened still
    gets its permanent photo (the no-cron alternative to the nightly sweep). Never
    today or a future day; a past day older than the window only freezes when viewed
    directly via the existing lazy "photo on first view" logic."""

    def setUp(self):
        self.today = timezone.localdate()
        self.tomorrow = self.today + timedelta(days=1)

        # One habit in a block, backdated far enough that it counts as existing on
        # every day in (and older than) the catch-up window.
        self.plan = Plan.objects.create(start_time=time(9, 0))
        self.habit = Habit.objects.create(name="Brush teeth")
        Habit.objects.filter(id=self.habit.id).update(
            date_added=timezone.now() - timedelta(days=60)
        )
        Schedule.objects.create(habit=self.habit, plan=self.plan, order=1)

    def _load_today(self):
        return self.client.get(reverse("habits:plan"))

    def test_loading_today_freezes_the_catchup_window(self):
        window = [self.today - timedelta(days=n)
                  for n in range(1, FREEZE_CATCHUP_DAYS + 1)]
        for d in window:
            self.assertFalse(ScheduleDay.objects.filter(date=d).exists())

        resp = self._load_today()
        self.assertEqual(resp.status_code, 200)
        # Each day in the window now has its photo.
        for d in window:
            self.assertTrue(
                ScheduleDay.objects.filter(date=d).exists(),
                f"{d} should be frozen by the catch-up sweep",
            )

    def test_catchup_is_idempotent(self):
        self._load_today()
        counts = {
            d: ScheduleDay.objects.filter(date=d).count()
            for d in (self.today - timedelta(days=n)
                      for n in range(1, FREEZE_CATCHUP_DAYS + 1))
        }
        # A second load must not duplicate any frozen rows.
        self._load_today()
        for d, before in counts.items():
            self.assertEqual(
                ScheduleDay.objects.filter(date=d).count(), before
            )

    def test_does_not_freeze_today_or_future(self):
        self._load_today()
        self.assertFalse(ScheduleDay.objects.filter(date=self.today).exists())
        self.assertFalse(ScheduleDay.objects.filter(date=self.tomorrow).exists())

    def test_does_not_freeze_a_day_older_than_the_window(self):
        old = self.today - timedelta(days=FREEZE_CATCHUP_DAYS + 1)   # just outside
        # Loading today sweeps only the window, so the older day stays unfrozen...
        self._load_today()
        self.assertFalse(ScheduleDay.objects.filter(date=old).exists())
        # ...but viewing it directly still freezes it (existing lazy-photo logic).
        self.client.get(reverse("habits:plan"), {"date": old.isoformat()})
        self.assertTrue(ScheduleDay.objects.filter(date=old).exists())


class FreezePastDaysCommandTests(TestCase):
    """The nightly catch-all: `freeze_past_days` freezes lived-but-unopened past
    days by calling the idempotent `freeze_day` helper. It walks a recent lookback
    window (last 7 days by default, `--days N` to widen) and never touches today
    or future days."""

    def setUp(self):
        self.today = timezone.localdate()
        self.yesterday = self.today - timedelta(days=1)
        self.tomorrow = self.today + timedelta(days=1)

        # One habit in a block, backdated so it counts as existing on past days
        # (otherwise the freeze's "didn't exist yet" filter snapshots nothing).
        self.plan = Plan.objects.create(start_time=time(9, 0))
        self.habit = Habit.objects.create(name="Brush teeth")
        Habit.objects.filter(id=self.habit.id).update(
            date_added=timezone.now() - timedelta(days=30)
        )
        Schedule.objects.create(habit=self.habit, plan=self.plan, order=1)

    def _run(self, *args):
        out = StringIO()
        call_command("freeze_past_days", *args, stdout=out)
        return out.getvalue()

    def test_freezes_an_unfrozen_past_day_in_the_window(self):
        self.assertFalse(ScheduleDay.objects.filter(date=self.yesterday).exists())
        out = self._run()
        self.assertTrue(ScheduleDay.objects.filter(date=self.yesterday).exists())
        self.assertIn(f"Froze {self.yesterday}", out)

    def test_is_a_noop_on_an_already_frozen_day(self):
        freeze_day(self.yesterday)
        before = ScheduleDay.objects.filter(date=self.yesterday).count()
        out = self._run()
        # No duplicate rows; reported as skipped, not frozen.
        self.assertEqual(
            ScheduleDay.objects.filter(date=self.yesterday).count(), before
        )
        self.assertIn(f"Already frozen, skipped {self.yesterday}", out)

    def test_does_not_freeze_today_or_future(self):
        self._run("--days", "7")
        self.assertFalse(ScheduleDay.objects.filter(date=self.today).exists())
        self.assertFalse(ScheduleDay.objects.filter(date=self.tomorrow).exists())

    def test_days_bounds_the_window(self):
        # An old day just outside a 2-day window isn't frozen; one inside is.
        old = self.today - timedelta(days=5)
        self._run("--days", "2")
        self.assertFalse(ScheduleDay.objects.filter(date=old).exists())   # outside
        self.assertTrue(
            ScheduleDay.objects.filter(date=self.yesterday).exists()      # inside
        )

    def test_date_freezes_one_specific_past_day(self):
        target = self.today - timedelta(days=10)   # outside the default window
        self._run("--date", target.isoformat())
        self.assertTrue(ScheduleDay.objects.filter(date=target).exists())
        # Only that day was frozen, not the rest of the window.
        self.assertFalse(ScheduleDay.objects.filter(date=self.yesterday).exists())

    def test_date_rejects_today_or_future(self):
        with self.assertRaises(CommandError):
            self._run("--date", self.today.isoformat())
