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
