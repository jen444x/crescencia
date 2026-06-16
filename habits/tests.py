import json
from datetime import time, timedelta

from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from .models import Habit, HabitLog, Plan, PlanDay, Schedule


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

    def test_rejects_bad_date(self):
        self.assertEqual(self._clear(date="nope").status_code, 400)
