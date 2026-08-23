import json
from datetime import time, timedelta
from io import StringIO

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from .models import (
    Area, Aspiration, BASE_VALID_FROM, Habit, HabitLog, HabitPause, HabitTier,
    Note, Chain, ChainDay, ChainTime, Routine, Schedule, ScheduleDay, Step,
    StepLog, Tier, VersionStep,
    TierValue, Version,
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
        self.chain = Chain.objects.create()
        Schedule.objects.create(habit=self.habit, chain=self.chain, order=1)

    def _statuses(self, response):
        """Map of habit id -> status across every group in a /plan/ payload."""
        groups = json.loads(response.content)
        return {
            h["id"]: h["status"]
            for group in groups
            for h in group["habits"]
        }

    def test_chains_defaults_to_today(self):
        response = self.client.get(reverse("habits:plan"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._statuses(response)[self.habit.id], "PENDING")

    def test_chains_reads_the_requested_day(self):
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

    def test_chains_rejects_a_bad_date(self):
        for bad in ("not-a-date", "2026-13-40"):
            response = self.client.get(reverse("habits:plan"), {"date": bad})
            self.assertEqual(response.status_code, 400, bad)

    def test_chains_hides_habits_created_after_the_viewed_day(self):
        # self.habit is 30 days old (see setUp). Add a second habit that only
        # exists as of today.
        new_habit = Habit.objects.create(name="Meditate")
        Schedule.objects.create(habit=new_habit, chain=self.chain, order=2)

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


class ShiftChainsTests(TestCase):
    """Waking up late pushes a cycle and everything after it to a new time —
    for that day only, never touching the recurring routine."""

    def setUp(self):
        self.today = timezone.localdate()
        self.tomorrow = self.today + timedelta(days=1)
        # Three time slots; we'll anchor shifts on the 9:00 one.
        self.early = Chain.objects.create(start_time=time(8, 0))
        self.mid = Chain.objects.create(start_time=time(9, 0))
        self.late = Chain.objects.create(start_time=time(10, 0))
        self.url = reverse("habits:shift_chains")

    def _shift(self, **body):
        return self.client.post(self.url, data=body, content_type="application/json")

    def _chain_times(self, response):
        """Map of plan id -> time string from a /plan/ payload (skips unscheduled)."""
        groups = json.loads(response.content)
        return {g["id"]: g["time"] for g in groups if g["id"] is not None}

    def _today_times(self):
        return self._chain_times(self.client.get(reverse("habits:plan")))

    def test_shifts_anchor_and_everything_after(self):
        response = self._shift(from_chain=self.mid.id, minutes=45)
        self.assertEqual(response.status_code, 200)

        times = self._today_times()
        self.assertEqual(times[self.early.id], "08:00:00")  # before anchor: unchanged
        self.assertEqual(times[self.mid.id], "09:45:00")    # anchor: moved
        self.assertEqual(times[self.late.id], "10:45:00")   # after anchor: cascaded

    def test_shift_is_today_only(self):
        self._shift(from_chain=self.mid.id, minutes=45)
        tomorrow = self._chain_times(
            self.client.get(reverse("habits:plan"), {"date": self.tomorrow.isoformat()})
        )
        self.assertEqual(tomorrow[self.mid.id], "09:00:00")  # recurring time intact

    def test_negative_minutes_pull_earlier(self):
        self._shift(from_chain=self.mid.id, minutes=-30)
        self.assertEqual(self._today_times()[self.mid.id], "08:30:00")

    def test_repeated_shifts_stack(self):
        self._shift(from_chain=self.mid.id, minutes=30)
        self._shift(from_chain=self.mid.id, minutes=15)
        self.assertEqual(self._today_times()[self.mid.id], "09:45:00")  # 9:00 +30 +15
        # ...and still just one override row for that plan/day.
        self.assertEqual(
            ChainDay.objects.filter(chain=self.mid, date=self.today).count(), 1
        )

    def test_rejects_bad_input(self):
        self.assertEqual(self._shift(from_chain=999999, minutes=10).status_code, 400)
        self.assertEqual(self._shift(from_chain=self.mid.id, minutes="lots").status_code, 400)
        self.assertEqual(self._shift(minutes=10).status_code, 400)  # missing from_chain


class RetimeChainTests(TestCase):
    """Drag one cycle's time header to an absolute time — today only, no cascade
    (the single-block companion to the 'running late' shift)."""

    def setUp(self):
        self.today = timezone.localdate()
        self.tomorrow = self.today + timedelta(days=1)
        self.early = Chain.objects.create(start_time=time(8, 0))
        self.mid = Chain.objects.create(start_time=time(9, 0))
        self.late = Chain.objects.create(start_time=time(10, 0))
        self.url = reverse("habits:retime_chain")

    def _retime(self, **body):
        return self.client.post(self.url, data=body, content_type="application/json")

    def _chain_times(self, response):
        """Map of plan id -> time string from a /plan/ payload (skips unscheduled)."""
        groups = json.loads(response.content)
        return {g["id"]: g["time"] for g in groups if g["id"] is not None}

    def _today_times(self):
        return self._chain_times(self.client.get(reverse("habits:plan")))

    def test_moves_only_the_one_cycle(self):
        response = self._retime(chain=self.mid.id, time="08:30")
        self.assertEqual(response.status_code, 200)

        times = self._today_times()
        self.assertEqual(times[self.early.id], "08:00:00")  # untouched
        self.assertEqual(times[self.mid.id], "08:30:00")    # moved to the absolute time
        self.assertEqual(times[self.late.id], "10:00:00")   # NOT cascaded (unlike shift)
        self.assertEqual(ChainDay.objects.filter(date=self.today).count(), 1)

    def test_is_today_only(self):
        self._retime(chain=self.mid.id, time="08:30")
        tomorrow = self._chain_times(
            self.client.get(reverse("habits:plan"), {"date": self.tomorrow.isoformat()})
        )
        self.assertEqual(tomorrow[self.mid.id], "09:00:00")  # recurring time intact

    def test_repeated_retime_replaces_not_stacks(self):
        self._retime(chain=self.mid.id, time="08:30")
        self._retime(chain=self.mid.id, time="11:15")
        # Absolute, so the second drop replaces the first (a shift would stack).
        self.assertEqual(self._today_times()[self.mid.id], "11:15:00")
        self.assertEqual(
            ChainDay.objects.filter(chain=self.mid, date=self.today).count(), 1
        )

    def test_back_to_recurring_clears_the_override(self):
        self._retime(chain=self.mid.id, time="08:30")   # create an override
        self._retime(chain=self.mid.id, time="09:00")   # exactly its recurring time
        self.assertFalse(
            ChainDay.objects.filter(chain=self.mid, date=self.today).exists()
        )
        self.assertEqual(self._today_times()[self.mid.id], "09:00:00")

    def test_rejects_bad_input(self):
        self.assertEqual(self._retime(chain=999999, time="08:30").status_code, 400)  # unknown plan
        self.assertEqual(self._retime(chain=self.mid.id, time="nope").status_code, 400)  # bad time
        self.assertEqual(self._retime(chain=self.mid.id, time="25:00").status_code, 400)  # impossible
        self.assertEqual(self._retime(time="08:30").status_code, 400)  # missing plan
        self.assertEqual(self._retime(chain=self.mid.id).status_code, 400)  # missing time


class NameChainTests(TestCase):
    """Name a time block (the "cycle"). Optional + cosmetic: an unnamed block
    reads as "" and looks unchanged; naming it persists and shows in /plan/."""

    def setUp(self):
        self.chain = Chain.objects.create(start_time=time(8, 0))
        self.url = reverse("habits:name_chain", args=[self.chain.id])

    def _name(self, chain_id=None, **body):
        url = reverse("habits:name_chain", args=[chain_id or self.chain.id])
        return self.client.post(url, data=body, content_type="application/json")

    def _block_name(self, chain_id):
        """The name of one block from the /plan/ payload."""
        groups = json.loads(self.client.get(reverse("habits:plan")).content)
        return next(g["name"] for g in groups if g["id"] == chain_id)

    def test_name_defaults_to_blank(self):
        # A brand-new block has no name, in the DB and in /plan/.
        self.assertEqual(self.chain.name, "")
        self.assertEqual(self._block_name(self.chain.id), "")

    def test_setting_a_name_persists_and_shows_in_plan(self):
        response = self._name(name="Morning routine")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.content),
                         {"id": self.chain.id, "name": "Morning routine"})
        self.chain.refresh_from_db()
        self.assertEqual(self.chain.name, "Morning routine")
        self.assertEqual(self._block_name(self.chain.id), "Morning routine")

    def test_empty_string_clears_the_name(self):
        self._name(name="Morning routine")
        response = self._name(name="")
        self.assertEqual(response.status_code, 200)
        self.chain.refresh_from_db()
        self.assertEqual(self.chain.name, "")
        self.assertEqual(self._block_name(self.chain.id), "")

    def test_name_is_trimmed(self):
        response = self._name(name="  Wind down  ")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.content)["name"], "Wind down")
        self.chain.refresh_from_db()
        self.assertEqual(self.chain.name, "Wind down")

    def test_whitespace_only_clears_the_name(self):
        self._name(name="Morning routine")
        self._name(name="   ")   # trims to "" -> clears
        self.chain.refresh_from_db()
        self.assertEqual(self.chain.name, "")

    def test_rejects_bad_input(self):
        self.assertEqual(self._name(name=123).status_code, 400)         # not a string
        self.assertEqual(self._name(name=None).status_code, 400)        # missing/null
        self.assertEqual(self._name().status_code, 400)                 # no 'name' key
        self.assertEqual(self._name(name="x" * 101).status_code, 400)   # too long
        # Exactly 100 chars is allowed.
        self.assertEqual(self._name(name="x" * 100).status_code, 200)

    def test_unknown_chain_id_errors(self):
        self.assertEqual(self._name(chain_id=999999, name="Nope").status_code, 400)

    def test_chains_shape_unchanged_plus_name(self):
        # Every group still has the original keys, and now a "name" too. An
        # unnamed block (and the trailing "Anytime" group) report "".
        groups = json.loads(self.client.get(reverse("habits:plan")).content)
        for g in groups:
            self.assertEqual(
                set(g.keys()), {"id", "time", "name", "habits"}
            )
        self.assertEqual(self._block_name(self.chain.id), "")  # unnamed -> ""
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
        self.chain = Chain.objects.create()
        Schedule.objects.create(habit=self.habit, chain=self.chain, order=1)
        self.log_url = reverse("habits:log_habit", args=[self.habit.id])

    def _chain_note(self):
        groups = json.loads(self.client.get(reverse("habits:plan")).content)
        for group in groups:
            for habit in group["habits"]:
                if habit["id"] == self.habit.id:
                    return habit["notes"]
        return None

    def _post(self, **body):
        return self.client.post(self.log_url, data=body, content_type="application/json")

    def test_chains_reports_the_note(self):
        self.assertEqual(self._chain_note(), "")  # no log yet
        HabitLog.objects.create(habit=self.habit, date=self.today, notes="before bed")
        self.assertEqual(self._chain_note(), "before bed")

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
        self.chain = Chain.objects.create(start_time=time(9, 0))

    def _clear(self, **body):
        return self.client.post(self.url, data=body, content_type="application/json")

    def test_drops_skips_and_shifts_keeps_completion(self):
        HabitLog.objects.create(habit=self.a, date=self.today, status=HabitLog.Status.COMPLETED)
        HabitLog.objects.create(habit=self.b, date=self.today, status=HabitLog.Status.SKIPPED)
        ChainDay.objects.create(chain=self.chain, date=self.today, start_time=time(9, 45))

        response = self._clear()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(HabitLog.objects.filter(habit=self.a, status="COMPLETED").exists())
        self.assertFalse(HabitLog.objects.filter(habit=self.b).exists())  # skip removed
        self.assertFalse(ChainDay.objects.filter(date=self.today).exists())  # shift removed

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
        Schedule.objects.create(habit=self.a, chain=self.chain, order=1)
        Schedule.objects.create(habit=self.b, chain=self.chain, order=2)
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
        self.chain = Chain.objects.create()
        self.brush = Habit.objects.create(name="Brush teeth")
        self.wash = Habit.objects.create(name="Wash face")
        self.s_brush = Schedule.objects.create(habit=self.brush, chain=self.chain, order=1)
        self.s_wash = Schedule.objects.create(habit=self.wash, chain=self.chain, order=2)

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

    def test_chains_exposes_routine_fields(self):
        r = Routine.objects.create(name="Morning routine")
        Schedule.objects.filter(id=self.s_brush.id).update(routine=r)
        groups = json.loads(self.client.get(reverse("habits:plan")).content)
        by_id = {h["id"]: h for g in groups for h in g["habits"]}
        self.assertEqual(by_id[self.brush.id]["routine"], r.id)
        self.assertEqual(by_id[self.brush.id]["routine_name"], "Morning routine")
        self.assertIsNone(by_id[self.wash.id]["routine"])        # ungrouped habit
        self.assertIsNone(by_id[self.wash.id]["routine_name"])

    def test_chains_no_longer_exposes_chain(self):
        # The Chain model is gone (Phase B), so no /plan/ row carries a "chain"
        # key anymore — the frontend must stop reading it.
        groups = json.loads(self.client.get(reverse("habits:plan")).content)
        rows = [h for g in groups for h in g["habits"]]
        self.assertTrue(rows)                                  # we have habits to check
        self.assertTrue(all("chain" not in h for h in rows))


class RoutineLogTests(TestCase):
    """`routines/<id>/log/` fans one status out to every member habit — the
    block's complete / skip / undo action."""

    def setUp(self):
        self.today = timezone.localdate()
        self.yesterday = self.today - timedelta(days=1)
        self.chain = Chain.objects.create()
        self.routine = Routine.objects.create(name="Morning")
        self.brush = Habit.objects.create(name="Brush teeth")
        self.wash = Habit.objects.create(name="Wash face")
        Schedule.objects.create(habit=self.brush, chain=self.chain, order=1, routine=self.routine)
        Schedule.objects.create(habit=self.wash, chain=self.chain, order=2, routine=self.routine)
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
        """Create/replace a rung (Version) at this level. label = the Roots/Growth
        tag for that level (1=Roots, 2=Growth), mirroring the old tier model so the
        ladder position and the tag line up in these fixtures."""
        tier, _ = Tier.objects.get_or_create(level=level)
        Version.objects.update_or_create(
            habit=habit, level=level,
            defaults={"value": value, "label": tier},
        )

    def _get(self):
        resp = self.client.get(reverse("habits:habits_list"))
        self.assertEqual(resp.status_code, 200)
        return json.loads(resp.content)

    def _by_id(self, data):
        return {h["id"]: h for h in data}

    def _complete(self, habit, day, *, version=None):
        HabitLog.objects.create(
            habit=habit, date=day,
            status=HabitLog.Status.COMPLETED, version=version,
        )

    def test_returns_all_habits_with_correct_shape(self):
        data = self._get()
        self.assertEqual(len(data), 2)
        row = self._by_id(data)[self.meditate.id]
        self.assertEqual(
            set(row.keys()),
            {"id", "name", "area", "area_name", "is_support", "kind",
             "ended_on", "tiers", "status", "aspirations", "streak"},
        )
        self.assertEqual(row["id"], self.meditate.id)
        self.assertEqual(row["name"], "Meditate")
        self.assertEqual(row["area"], self.mind.id)
        self.assertEqual(row["area_name"], "Mind")
        self.assertFalse(row["is_support"])  # a main habit, not a helper
        self.assertEqual(row["kind"], Habit.Kind.HABIT)  # default: a real habit

    def test_streak_zero_when_never_completed(self):
        self.assertEqual(self._by_id(self._get())[self.run.id]["streak"], 0)

    def test_streak_counts_consecutive_completed_days(self):
        for n in (0, 1, 2):
            self._complete(self.run, self.today - timedelta(days=n))
        self.assertEqual(self._by_id(self._get())[self.run.id]["streak"], 3)

    def test_streak_ignores_pending_today(self):
        # Completed the last two days; today untouched. Today's pending state
        # doesn't break the run — it still counts through yesterday.
        self._complete(self.run, self.today - timedelta(days=1))
        self._complete(self.run, self.today - timedelta(days=2))
        self.assertEqual(self._by_id(self._get())[self.run.id]["streak"], 2)

    def test_streak_breaks_on_a_skipped_day(self):
        self._complete(self.run, self.today)
        HabitLog.objects.create(
            habit=self.run, date=self.today - timedelta(days=1),
            status=HabitLog.Status.SKIPPED,
        )
        self._complete(self.run, self.today - timedelta(days=2))
        self.assertEqual(self._by_id(self._get())[self.run.id]["streak"], 1)

    def test_streak_counts_a_completed_version_for_the_whole_habit(self):
        # Completing the Growth rung (higher) marks the habit done that day via
        # the cascade, so the whole-habit streak counts it.
        growth = Version.objects.get(habit=self.meditate, level=2)
        self._complete(self.meditate, self.today, version=growth)
        self.assertEqual(self._by_id(self._get())[self.meditate.id]["streak"], 1)

    def test_untiered_habit_has_empty_tiers(self):
        row = self._by_id(self._get())[self.run.id]
        self.assertEqual(row["tiers"], [])

    def test_tiered_habit_lists_tiers_low_to_high_with_current_values(self):
        tiers = self._by_id(self._get())[self.meditate.id]["tiers"]
        # drop the dynamic version id for a stable field comparison
        got = [{k: v for k, v in t.items() if k != "version"} for t in tiers]
        self.assertEqual(
            got,
            [
                # `steps` is [] for a habit that isn't a recipe — the normal
                # case; target_time null and duration "" until a rung is
                # given typed meaning.
                {"level": 1, "name": "Roots", "label": 1, "value": "2 min",
                 "target_time": None, "duration": "",
                 "steps": [], "status": "PENDING", "done": False},
                {"level": 2, "name": "Growth", "label": 2, "value": "10 min",
                 "target_time": None, "duration": "",
                 "steps": [], "status": "PENDING", "done": False},
            ],
        )
        # every rung carries its version id (what a completion keys on)
        self.assertTrue(all(isinstance(t["version"], int) for t in tiers))

    def test_tier_value_uses_the_newest_tiervalue(self):
        # Bump Roots to a new value; the newest started date wins.
        self._add_tier(self.meditate, level=1, value="5 min")
        roots = next(
            t for t in self._by_id(self._get())[self.meditate.id]["tiers"]
            if t["level"] == 1
        )
        self.assertEqual(roots["value"], "5 min")

    def test_completed_habit_reflects_today_status_and_tier(self):
        v2 = Version.objects.get(habit=self.meditate, level=2)
        HabitLog.objects.create(
            habit=self.meditate, date=self.today,
            status=HabitLog.Status.COMPLETED, version=v2, tier=v2.label,
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
        chain_a = Chain.objects.create(start_time=time(7, 0))
        chain_b = Chain.objects.create(start_time=time(11, 0))
        Schedule.objects.create(habit=self.meditate, chain=chain_a, order=1)
        Schedule.objects.create(habit=self.meditate, chain=chain_b, order=1)

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


class CreateChainTests(TestCase):
    """`plans/create/` adds a new time block (or reuses the one at that time)."""

    def _create(self, time_str):
        return self.client.post(
            reverse("habits:create_chain"),
            data={"time": time_str}, content_type="application/json",
        )

    def test_creates_block_at_time(self):
        resp = self._create("10:45")
        self.assertEqual(resp.status_code, 201)
        data = json.loads(resp.content)
        self.assertTrue(data["created"])
        self.assertTrue(Chain.objects.filter(id=data["id"], start_time=time(10, 45)).exists())

    def test_reuses_existing_time(self):
        first = json.loads(self._create("10:45").content)
        resp = self._create("10:45")
        self.assertEqual(resp.status_code, 200)
        second = json.loads(resp.content)
        self.assertFalse(second["created"])
        self.assertEqual(first["id"], second["id"])  # same block, not a duplicate
        self.assertEqual(Chain.objects.filter(start_time=time(10, 45)).count(), 1)

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
        self.early = Chain.objects.create(start_time=time(9, 0))
        self.late = Chain.objects.create(start_time=time(15, 0))
        Schedule.objects.create(habit=self.water, chain=self.early, tier=self.growth, order=1)
        Schedule.objects.create(habit=self.water, chain=self.late, tier=self.roots, order=1)

    def _tier(self, level):
        t, _ = Tier.objects.get_or_create(level=level)
        return t

    def _add_tier(self, level, value):
        Version.objects.update_or_create(
            habit=self.water, level=level,
            defaults={"value": value, "label": self._tier(level)},
        )

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
        self.chain = Chain.objects.create(start_time=time(9, 0))
        self.brush = Habit.objects.create(name="Brush teeth")
        self.wash = Habit.objects.create(name="Wash face")
        for h in (self.brush, self.wash):
            Habit.objects.filter(id=h.id).update(
                date_added=timezone.now() - timedelta(days=30)
            )
        self.s_brush = Schedule.objects.create(habit=self.brush, chain=self.chain, order=1)
        self.s_wash = Schedule.objects.create(habit=self.wash, chain=self.chain, order=2)

    def _arrange(self, **body):
        return self.client.post(
            reverse("habits:arrange_day"),
            data=json.dumps(body), content_type="application/json",
        )

    def _rows(self, response):
        """All habit payloads in a /plan/ response, keyed by row_id."""
        groups = json.loads(response.content)
        return {h["row_id"]: h for g in groups for h in g["habits"]}

    def _chain(self, date):
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

    def test_freeze_snapshots_name_chain_and_time(self):
        freeze_day(self.yesterday)
        sd = ScheduleDay.objects.get(date=self.yesterday, habit=self.brush)
        self.assertEqual(sd.habit_name, "Brush teeth")        # name snapshot
        self.assertEqual(sd.chain_id, self.chain.id)
        self.assertEqual(sd.order, 1)
        # The block's time is locked into ChainDay so time_by_plan serves it.
        pd = ChainDay.objects.get(date=self.yesterday, chain=self.chain)
        self.assertEqual(pd.start_time, time(9, 0))

    def test_freeze_copies_every_tier_slot(self):
        # A habit with two tier-slots (two times) must freeze BOTH rows.
        water = Habit.objects.create(name="Drink water")
        Habit.objects.filter(id=water.id).update(
            date_added=timezone.now() - timedelta(days=30)
        )
        roots, _ = Tier.objects.get_or_create(level=1)
        growth, _ = Tier.objects.get_or_create(level=2)
        late = Chain.objects.create(start_time=time(15, 0))
        Schedule.objects.create(habit=water, chain=self.chain, tier=growth, order=3)
        Schedule.objects.create(habit=water, chain=late, tier=roots, order=1)

        freeze_day(self.yesterday)
        slots = ScheduleDay.objects.filter(date=self.yesterday, habit=water)
        self.assertEqual(sorted(s.tier.level for s in slots), [1, 2])

    # --- /plan/ reads frozen days -------------------------------------------

    def test_viewing_a_past_day_freezes_it(self):
        self.assertFalse(ScheduleDay.objects.filter(date=self.yesterday).exists())
        resp = self._chain(self.yesterday)
        self.assertEqual(resp.status_code, 200)
        # The lazy "photo on first view" wrote the rows.
        self.assertEqual(
            ScheduleDay.objects.filter(date=self.yesterday).count(), 2
        )

    def test_today_and_future_are_not_frozen_on_view(self):
        self.client.get(reverse("habits:plan"))               # today
        self._chain(self.tomorrow)                              # future
        self.assertFalse(ScheduleDay.objects.filter(date=self.today).exists())
        self.assertFalse(ScheduleDay.objects.filter(date=self.tomorrow).exists())

    def test_frozen_day_payload_uses_scheduleday_row_id(self):
        self._chain(self.yesterday)                            # freeze it
        rows = self._rows(self._chain(self.yesterday))
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
        self._chain(self.yesterday)
        before = self._rows(self._chain(self.yesterday))
        self.assertEqual(len(before), 2)

        # Edit the recurring plan: move brush to a new block, drop wash entirely.
        other = Chain.objects.create(start_time=time(18, 0))
        Schedule.objects.filter(id=self.s_brush.id).update(chain=other, order=9)
        self.s_wash.delete()

        after = self._rows(self._chain(self.yesterday))
        self.assertEqual(len(after), 2)                       # both still there
        self.assertCountEqual(
            [h["id"] for h in after.values()], [self.brush.id, self.wash.id]
        )
        # Brush still sits in its original block at its frozen order.
        brush_row = next(h for h in after.values() if h["id"] == self.brush.id)
        self.assertEqual(brush_row["order"], 1)

    # --- only PAST days lock: today/future follow the template ----------------

    def test_today_is_not_frozen_all_or_nothing_with_scheduleday_rows(self):
        # A leftover whole-day ScheduleDay snapshot on TODAY (e.g. from an old
        # freeze) must NOT make today read all-or-nothing from the photo. Today is
        # never "frozen" for reads, so a slot WITHOUT a per-day tweak still follows
        # the template/forward change; only the exact overridden slot keeps its
        # override (per-slot precedence, like ChainDay over ChainTime). This is why
        # STEP 3 clears a stale whole-day snapshot — but the read must already be
        # per-slot, not all-or-nothing.
        freeze_day(self.today)                       # leftover whole-day snapshot
        self.assertTrue(ScheduleDay.objects.filter(date=self.today).exists())

        # Forward change to WASH (which has an override -> override wins, snapshot
        # block) and a forward change is reflected for any slot that lacks one. Drop
        # the brush override so brush follows the template again, then move brush.
        ScheduleDay.objects.filter(date=self.today, habit=self.brush).delete()
        other = Chain.objects.create(start_time=time(18, 0))
        Schedule.objects.filter(id=self.s_brush.id).update(chain=other)

        groups = json.loads(self.client.get(reverse("habits:plan")).content)
        block_of = {h["id"]: g["id"] for g in groups for h in g["habits"]}
        # Brush has no override now -> follows the forward template change.
        self.assertEqual(block_of[self.brush.id], other.id)
        # Wash still has its snapshot override -> stays in the original block.
        self.assertEqual(block_of[self.wash.id], self.chain.id)

    def test_forward_change_shows_on_today_and_future_without_a_freeze(self):
        # No whole-day freeze anywhere. A forward placement change must show on
        # today AND a future day, following the template.
        self.assertFalse(ScheduleDay.objects.filter(date=self.today).exists())
        other = Chain.objects.create(start_time=time(18, 0))
        Schedule.objects.filter(id=self.s_brush.id).update(chain=other)

        for date in (self.today, self.tomorrow):
            resp = (self.client.get(reverse("habits:plan")) if date == self.today
                    else self._chain(date))
            groups = json.loads(resp.content)
            block_of_brush = next(
                g["id"] for g in groups
                for h in g["habits"] if h["id"] == self.brush.id
            )
            self.assertEqual(block_of_brush, other.id, f"forward change missing on {date}")
        # No day got frozen by merely reading today/future.
        self.assertFalse(ScheduleDay.objects.filter(date=self.today).exists())
        self.assertFalse(ScheduleDay.objects.filter(date=self.tomorrow).exists())

    def test_just_today_override_layers_over_template_per_habit(self):
        # A single-habit ScheduleDay override for TODAY layers on top: that habit
        # uses the override's block, every OTHER habit keeps following the template.
        other = Chain.objects.create(start_time=time(18, 0))
        ScheduleDay.objects.create(
            date=self.today, habit=self.brush, habit_name="Brush teeth",
            chain=other, order=1,
        )
        groups = json.loads(self.client.get(reverse("habits:plan")).content)
        block_of = {
            h["id"]: g["id"] for g in groups for h in g["habits"]
        }
        self.assertEqual(block_of[self.brush.id], other.id)   # override wins
        self.assertEqual(block_of[self.wash.id], self.chain.id)  # sibling unchanged
        # The overridden row is keyed on its ScheduleDay id, the sibling on Schedule.
        rows = self._rows(self.client.get(reverse("habits:plan")))
        sd = ScheduleDay.objects.get(date=self.today, habit=self.brush)
        self.assertIn(sd.id, rows)
        self.assertEqual(rows[sd.id]["schedule_id"], None)
        self.assertIn(self.s_wash.id, rows)

    def test_past_frozen_day_unchanged_by_overlay_change(self):
        # A PAST frozen day stays byte-identical (history preserved) even when a
        # forward template change lands.
        self._chain(self.yesterday)                   # freeze yesterday
        before = self._rows(self._chain(self.yesterday))
        other = Chain.objects.create(start_time=time(18, 0))
        Schedule.objects.filter(id=self.s_brush.id).update(chain=other)
        after = self._rows(self._chain(self.yesterday))
        self.assertEqual(
            {rid: (h["id"], h["order"]) for rid, h in before.items()},
            {rid: (h["id"], h["order"]) for rid, h in after.items()},
        )

    # --- /days/arrange/ ------------------------------------------------------

    def test_arrange_reorders_a_frozen_day_without_touching_template(self):
        self._chain(self.yesterday)                            # freeze
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

    def test_arrange_on_future_day_overrides_only_the_moved_habit(self):
        # Only PAST days lock. Arranging a FUTURE day with a TEMPLATE id does NOT
        # freeze the whole day: only the moved habit gets a per-day override, and
        # every other habit keeps following the template (no whole-day snapshot).
        self.assertFalse(ScheduleDay.objects.filter(date=self.tomorrow).exists())
        resp = self._arrange(
            date=self.tomorrow.isoformat(),
            items=[{"id": self.s_brush.id, "order": 5}],   # template id
        )
        self.assertEqual(resp.status_code, 200)
        # ONE override row (brush only) — wash is untouched, still template-driven.
        self.assertEqual(
            ScheduleDay.objects.filter(date=self.tomorrow).count(), 1
        )
        sd_brush = ScheduleDay.objects.get(date=self.tomorrow, habit=self.brush)
        self.assertEqual(sd_brush.order, 5)
        self.assertEqual(sd_brush.chain_id, self.chain.id)     # seeded from template block
        self.assertFalse(
            ScheduleDay.objects.filter(date=self.tomorrow, habit=self.wash).exists()
        )
        self.s_brush.refresh_from_db()
        self.assertEqual(self.s_brush.order, 1)              # template untouched

    def test_arrange_moves_a_row_between_blocks_for_that_day(self):
        other = Chain.objects.create(start_time=time(18, 0))
        resp = self._arrange(
            date=self.tomorrow.isoformat(),
            items=[{"id": self.s_brush.id, "order": 1, "chain": other.id}],
        )
        self.assertEqual(resp.status_code, 200)
        sd_brush = ScheduleDay.objects.get(date=self.tomorrow, habit=self.brush)
        self.assertEqual(sd_brush.chain_id, other.id)
        self.s_brush.refresh_from_db()
        self.assertEqual(self.s_brush.chain_id, self.chain.id)  # template block unchanged

    def test_arrange_ignores_a_stray_plan_key(self):
        # "plan" is the pre-rename name of the block FK (now "chain"); a "plan"
        # sent by an older client is ignored rather than 400'd, and the reorder
        # still applies for the day.
        resp = self._arrange(
            date=self.tomorrow.isoformat(),
            items=[{"id": self.s_brush.id, "order": 4, "plan": 999999}],
        )
        self.assertEqual(resp.status_code, 200)
        updated = json.loads(resp.content)["updated"][0]
        self.assertNotIn("plan", updated)                     # stray key not echoed back
        self.assertNotEqual(updated.get("chain"), 999999)     # stray value never applied
        sd_brush = ScheduleDay.objects.get(date=self.tomorrow, habit=self.brush)
        self.assertEqual(sd_brush.order, 4)                   # reorder applied
        self.assertNotEqual(sd_brush.chain_id, 999999)        # block unchanged by stray key

    def test_arrange_places_an_anytime_habit_for_that_day(self):
        # A habit with no Schedule row (sits in "Anytime") dragged into a block,
        # that day only -> a new ScheduleDay row, no Schedule row created.
        solo = Habit.objects.create(name="Journal")
        Habit.objects.filter(id=solo.id).update(
            date_added=timezone.now() - timedelta(days=30)
        )
        resp = self._arrange(
            date=self.tomorrow.isoformat(),
            items=[{"habit": solo.id, "chain": self.chain.id}],
        )
        self.assertEqual(resp.status_code, 200)
        sd = ScheduleDay.objects.get(date=self.tomorrow, habit=solo)
        self.assertEqual(sd.chain_id, self.chain.id)
        self.assertEqual(sd.habit_name, "Journal")           # name snapshot
        self.assertEqual(sd.order, 3)                         # appends after brush(1)+wash(2)
        # No Schedule (template) row was created — placement is per-day only.
        self.assertFalse(Schedule.objects.filter(habit=solo).exists())

    # --- only PAST days lock: a just-today edit doesn't lock the rest ----------

    def test_just_today_edit_on_today_does_not_lock_the_rest(self):
        # Moving ONE habit "just today" on TODAY creates an override for that habit
        # only — the day is NOT whole-day frozen, so every other habit keeps
        # following the template.
        rows = self._rows(self.client.get(reverse("habits:plan")))
        other = Chain.objects.create(start_time=time(18, 0))
        resp = self._arrange(
            date=self.today.isoformat(),
            items=[{"id": self.s_brush.id, "order": 1, "chain": other.id}],  # template id
        )
        self.assertEqual(resp.status_code, 200)
        # Exactly ONE override row (brush); wash has none -> still template-driven.
        self.assertEqual(ScheduleDay.objects.filter(date=self.today).count(), 1)
        self.assertTrue(
            ScheduleDay.objects.filter(date=self.today, habit=self.brush).exists()
        )
        self.assertFalse(
            ScheduleDay.objects.filter(date=self.today, habit=self.wash).exists()
        )
        # /plan/ reflects: brush moved, wash unchanged, both still shown.
        groups = json.loads(self.client.get(reverse("habits:plan")).content)
        block_of = {h["id"]: g["id"] for g in groups for h in g["habits"]}
        self.assertEqual(block_of[self.brush.id], other.id)
        self.assertEqual(block_of[self.wash.id], self.chain.id)
        # Template untouched.
        self.s_brush.refresh_from_db()
        self.assertEqual(self.s_brush.chain_id, self.chain.id)

    def test_just_today_edit_on_today_does_not_freeze_tomorrow(self):
        # A just-today edit on TODAY must leave TOMORROW following the template
        # (no whole-day snapshot leaks forward).
        other = Chain.objects.create(start_time=time(18, 0))
        self._arrange(
            date=self.today.isoformat(),
            items=[{"id": self.s_brush.id, "order": 1, "chain": other.id}],
        )
        self.assertFalse(ScheduleDay.objects.filter(date=self.tomorrow).exists())
        groups = json.loads(self._chain(self.tomorrow).content)
        block_of = {h["id"]: g["id"] for g in groups for h in g["habits"]}
        self.assertEqual(block_of[self.brush.id], self.chain.id)   # tomorrow unchanged

    def test_just_today_tweak_wins_over_a_forward_change_on_today(self):
        # Precedence (like ChainDay > ChainTime): a per-day "just today" tweak to a
        # habit on TODAY wins over a "going forward" change to that SAME habit for
        # today. First the forward change, then the just-today tweak.
        fwd = Chain.objects.create(start_time=time(12, 0))
        just = Chain.objects.create(start_time=time(18, 0))
        # Forward change: brush -> fwd block from today on (template generation).
        Schedule.objects.create(
            habit=self.brush, chain=fwd, order=1, valid_from=self.today
        )
        # Now a just-today tweak moves brush to the `just` block (its row_id is the
        # forward Schedule id /plan/ now emits for the slot).
        rows = self._rows(self.client.get(reverse("habits:plan")))
        brush_rid = next(rid for rid, h in rows.items() if h["id"] == self.brush.id)
        resp = self._arrange(
            date=self.today.isoformat(),
            items=[{"id": brush_rid, "order": 1, "chain": just.id}],
        )
        self.assertEqual(resp.status_code, 200)
        # TODAY: the just-today tweak wins -> brush sits in `just`, not `fwd`.
        groups = json.loads(self.client.get(reverse("habits:plan")).content)
        block_of = {h["id"]: g["id"] for g in groups for h in g["habits"]}
        self.assertEqual(block_of[self.brush.id], just.id)
        # TOMORROW: no just-today override there -> follows the forward change.
        groups_t = json.loads(self._chain(self.tomorrow).content)
        block_of_t = {h["id"]: g["id"] for g in groups_t for h in g["habits"]}
        self.assertEqual(block_of_t[self.brush.id], fwd.id)

    def _anytime_ids(self, response):
        """Habit ids in the trailing "Anytime" (id=None) group of a /plan/ payload."""
        groups = json.loads(response.content)
        anytime = next(g for g in groups if g["id"] is None)
        return [h["id"] for h in anytime["habits"]]

    def test_frozen_day_keeps_never_placed_anytime_habits(self):
        # THE BUG: a habit that was never placed (no Schedule row) lives in
        # Anytime. The moment a day freezes (e.g. the first drag) it gets
        # ScheduleDay rows — but a never-placed habit has none, so it used to
        # vanish from Anytime on a frozen day. It must still be listed, and a
        # page refresh (a fresh frozen GET) must keep showing it.
        solo = Habit.objects.create(name="Read")           # never placed -> Anytime
        Habit.objects.filter(id=solo.id).update(
            date_added=timezone.now() - timedelta(days=30)
        )
        # Freeze today by placing a DIFFERENT habit (brush) for the day. This is
        # exactly the user's reproduction: dragging one habit freezes the day.
        resp = self._arrange(
            date=self.today.isoformat(),
            items=[{"id": self.s_brush.id, "order": 1, "chain": self.chain.id}],
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(ScheduleDay.objects.filter(date=self.today).exists())  # frozen
        self.assertFalse(                                  # the never-placed habit got no row
            ScheduleDay.objects.filter(date=self.today, habit=solo).exists()
        )

        # A fresh GET of the now-frozen day (i.e. a refresh) still lists it in Anytime.
        anytime = self._anytime_ids(self.client.get(reverse("habits:plan")))
        self.assertIn(solo.id, anytime)
        # And it isn't double-listed, nor are the placed habits leaked into Anytime.
        self.assertEqual(anytime.count(solo.id), 1)
        self.assertNotIn(self.brush.id, anytime)
        self.assertNotIn(self.wash.id, anytime)

    def test_frozen_day_anytime_excludes_habits_added_later(self):
        # The "existed by then" rule still applies on a frozen day: a habit added
        # AFTER the viewed day must not appear in that frozen day's Anytime.
        self._chain(self.yesterday)                         # freeze yesterday
        future_habit = Habit.objects.create(name="Brand new")  # date_added = now (today)
        anytime = self._anytime_ids(self._chain(self.yesterday))
        self.assertNotIn(future_habit.id, anytime)

    def test_arrange_requires_a_date(self):
        resp = self._arrange(items=[{"id": self.s_brush.id, "order": 1}])
        self.assertEqual(resp.status_code, 400)

    def test_arrange_rejects_unknown_row_id_on_frozen_day(self):
        self._chain(self.yesterday)                            # freeze
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
        other = Chain.objects.create(start_time=time(18, 0))
        self._arrange(
            date=self.tomorrow.isoformat(),
            items=[{"id": self.s_brush.id, "order": 1, "chain": other.id}],
        )
        rows = self._rows(self._chain(self.tomorrow))
        sd_brush = ScheduleDay.objects.get(date=self.tomorrow, habit=self.brush)
        self.assertEqual(rows[sd_brush.id]["row_id"], sd_brush.id)


class ChainFreezeCatchupTests(TestCase):
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
        self.chain = Chain.objects.create(start_time=time(9, 0))
        self.habit = Habit.objects.create(name="Brush teeth")
        Habit.objects.filter(id=self.habit.id).update(
            date_added=timezone.now() - timedelta(days=60)
        )
        Schedule.objects.create(habit=self.habit, chain=self.chain, order=1)

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
        self.chain = Chain.objects.create(start_time=time(9, 0))
        self.habit = Habit.objects.create(name="Brush teeth")
        Habit.objects.filter(id=self.habit.id).update(
            date_added=timezone.now() - timedelta(days=30)
        )
        Schedule.objects.create(habit=self.habit, chain=self.chain, order=1)

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


class RetiredRecurringWritersTests(TestCase):
    """apply-to-future Phase 0: the dateless, permanent, all-days recurring
    writers `/schedules/create/` and `/schedules/reorder/` are uncalled but were
    still live and would reintroduce the old all-days bug if ever hit. Their URL
    routes are retired — both must now 404."""

    def test_create_schedule_route_is_retired(self):
        resp = self.client.post(
            "/schedules/create/",
            data={"habit": 1, "chain": 1}, content_type="application/json",
        )
        self.assertEqual(resp.status_code, 404)

    def test_reorder_schedules_route_is_retired(self):
        resp = self.client.post(
            "/schedules/reorder/",
            data={"items": []}, content_type="application/json",
        )
        self.assertEqual(resp.status_code, 404)


class ArrangeForwardTests(TestCase):
    """apply-to-future Phase 2: /schedules/arrange-forward/ writes a DATED
    `Schedule` generation so a placement change applies from a date forward
    (inclusive of today, D2) without ever rewriting the past. Reads are
    generation-aware: for date T each logical slot (habit, tier) shows the row
    with the greatest valid_from <= T, so a moved habit appears in its new cycle
    going forward, stays in the old cycle for past dates, and never shows twice."""

    def setUp(self):
        self.today = timezone.localdate()
        self.yesterday = self.today - timedelta(days=1)
        self.tomorrow = self.today + timedelta(days=1)

        # Two cycles, two habits. Habits backdated so they "existed" on past days.
        self.morning = Chain.objects.create(start_time=time(7, 0))
        self.evening = Chain.objects.create(start_time=time(20, 0))
        self.stretch = Habit.objects.create(name="Stretch")
        self.read = Habit.objects.create(name="Read")
        self.water = Habit.objects.create(name="Drink water")   # starts in Anytime
        for h in (self.stretch, self.read, self.water):
            Habit.objects.filter(id=h.id).update(
                date_added=timezone.now() - timedelta(days=30)
            )
        # Base generation (the sentinel): Stretch + Read both in Morning.
        self.s_stretch = Schedule.objects.create(
            habit=self.stretch, chain=self.morning, order=1
        )
        self.s_read = Schedule.objects.create(
            habit=self.read, chain=self.morning, order=2
        )

    def _forward(self, **body):
        return self.client.post(
            reverse("habits:arrange_forward"),
            data=json.dumps(body), content_type="application/json",
        )

    def _chain(self, date):
        return self.client.get(reverse("habits:plan"), {"date": date.isoformat()})

    def _placement(self, response):
        """{habit_id: chain_id} across a /plan/ response (None plan = Anytime)."""
        groups = json.loads(response.content)
        out = {}
        for g in groups:
            for h in g["habits"]:
                out.setdefault(h["id"], []).append(g["id"])
        return out

    # --- move forward --------------------------------------------------------

    def test_move_forward_new_cycle_tomorrow_old_yesterday_no_dup(self):
        # Move Stretch into Evening from today forward.
        resp = self._forward(items=[{"habit": self.stretch.id, "chain": self.evening.id, "order": 1}])
        self.assertEqual(resp.status_code, 200)

        # Tomorrow: Stretch is in Evening (the new generation), and ONLY there.
        future = self._placement(self._chain(self.tomorrow))
        self.assertEqual(future[self.stretch.id], [self.evening.id])

        # Yesterday: untouched — Stretch still in Morning (the base generation).
        past = self._placement(self._chain(self.yesterday))
        self.assertEqual(past[self.stretch.id], [self.morning.id])

        # The base row was never modified or deleted (it still covers the past).
        self.assertTrue(
            Schedule.objects.filter(
                id=self.s_stretch.id, chain=self.morning, valid_from=BASE_VALID_FROM
            ).exists()
        )

    def test_reorder_forward(self):
        # Reorder within Morning from today: Read first, Stretch second.
        resp = self._forward(items=[
            {"habit": self.read.id, "chain": self.morning.id, "order": 1},
            {"habit": self.stretch.id, "chain": self.morning.id, "order": 2},
        ])
        self.assertEqual(resp.status_code, 200)

        groups = json.loads(self._chain(self.tomorrow).content)
        morning = next(g for g in groups if g["id"] == self.morning.id)
        names = [h["name"] for h in morning["habits"]]
        self.assertEqual(names, ["Read", "Stretch"])

        # Past unchanged: original order (Stretch, Read).
        groups_past = json.loads(self._chain(self.yesterday).content)
        morning_past = next(g for g in groups_past if g["id"] == self.morning.id)
        self.assertEqual(
            [h["name"] for h in morning_past["habits"]], ["Stretch", "Read"]
        )

    def test_place_from_anytime_forward(self):
        # Drink water starts in Anytime (no Schedule row). Place it into Evening.
        resp = self._forward(items=[{"habit": self.water.id, "chain": self.evening.id, "order": 1}])
        self.assertEqual(resp.status_code, 200)

        future = self._placement(self._chain(self.tomorrow))
        self.assertEqual(future[self.water.id], [self.evening.id])

        # Past: the forward placement never reaches back. Yesterday water has no
        # effective Schedule row (its only generation is future), so it is NOT in
        # the Evening cycle there — it stays Anytime. (On a frozen past day an
        # Anytime habit leaves no row, matching existing freeze behavior, so we
        # assert it never appears in a cycle, not specifically in Anytime.)
        past = self._placement(self._chain(self.yesterday))
        self.assertNotIn(self.evening.id, past.get(self.water.id, []))

    # --- frozen days ---------------------------------------------------------

    def test_frozen_future_day_is_skipped(self):
        # Pre-edit (freeze) tomorrow with its own arrangement: Stretch stays put.
        self._chain(self.tomorrow)   # not auto-frozen (future); freeze explicitly:
        freeze_day(self.tomorrow)
        self.assertTrue(ScheduleDay.objects.filter(date=self.tomorrow).exists())

        # Forward-write moving Stretch to Evening from today.
        self._forward(items=[{"habit": self.stretch.id, "chain": self.evening.id, "order": 1}])

        # Tomorrow keeps its frozen arrangement (Stretch still in Morning).
        future = self._placement(self._chain(self.tomorrow))
        self.assertEqual(future[self.stretch.id], [self.morning.id])
        # The day-after (not frozen) DOES get the new placement.
        day_after = self._placement(self._chain(self.tomorrow + timedelta(days=1)))
        self.assertEqual(day_after[self.stretch.id], [self.evening.id])

    def test_frozen_today_is_reflected(self):
        # Freeze today, then forward-write from today: the change must show today.
        freeze_day(self.today)
        self.assertTrue(ScheduleDay.objects.filter(date=self.today).exists())

        self._forward(items=[{"habit": self.stretch.id, "chain": self.evening.id, "order": 1}])

        today = self._placement(self._chain(self.today))
        self.assertEqual(today[self.stretch.id], [self.evening.id])
        # Today reads ScheduleDay, so the mirror is what made it visible.
        sd = ScheduleDay.objects.get(
            date=self.today, habit=self.stretch, tier__isnull=True
        )
        self.assertEqual(sd.chain_id, self.evening.id)

    def test_frozen_future_scheduleday_not_mirrored(self):
        # A from_date in the future that is frozen must NOT be mirrored (D3): only
        # today gets the ScheduleDay reflect.
        freeze_day(self.tomorrow)
        before = {
            (sd.habit_id, sd.chain_id)
            for sd in ScheduleDay.objects.filter(date=self.tomorrow)
        }
        self._forward(
            from_date=self.tomorrow.isoformat(),
            items=[{"habit": self.stretch.id, "chain": self.evening.id, "order": 1}],
        )
        after = {
            (sd.habit_id, sd.chain_id)
            for sd in ScheduleDay.objects.filter(date=self.tomorrow)
        }
        self.assertEqual(before, after)   # frozen future day untouched

    # --- idempotency ---------------------------------------------------------

    def test_idempotent_repeat(self):
        items = [{"habit": self.stretch.id, "chain": self.evening.id, "order": 1}]
        self._forward(items=items)
        self._forward(items=items)   # same edit again
        # Exactly one from_date generation for the slot — not duplicated.
        gen = Schedule.objects.filter(
            habit=self.stretch, tier__isnull=True, valid_from=self.today
        )
        self.assertEqual(gen.count(), 1)
        self.assertEqual(gen.first().chain_id, self.evening.id)

    def test_repeat_with_new_order_updates_generation(self):
        self._forward(items=[{"habit": self.stretch.id, "chain": self.evening.id, "order": 1}])
        self._forward(items=[{"habit": self.stretch.id, "chain": self.evening.id, "order": 5}])
        gen = Schedule.objects.get(
            habit=self.stretch, tier__isnull=True, valid_from=self.today
        )
        self.assertEqual(gen.order, 5)   # updated, not a second row

    # --- defaults / validation ----------------------------------------------

    def test_from_date_defaults_to_today(self):
        resp = self._forward(items=[{"habit": self.stretch.id, "chain": self.evening.id, "order": 1}])
        self.assertEqual(json.loads(resp.content)["from_date"], self.today.isoformat())
        self.assertTrue(
            Schedule.objects.filter(habit=self.stretch, valid_from=self.today).exists()
        )

    def test_place_at_anytime_with_null_plan(self):
        # plan: null moves Stretch out of Morning into Anytime, going forward.
        self._forward(items=[{"habit": self.stretch.id, "chain": None, "order": 1}])
        future = self._placement(self._chain(self.tomorrow))
        self.assertEqual(future[self.stretch.id], [None])
        # Past still in Morning.
        past = self._placement(self._chain(self.yesterday))
        self.assertEqual(past[self.stretch.id], [self.morning.id])

    def test_rejects_bad_input(self):
        self.assertEqual(self._forward(items=[]).status_code, 400)          # empty
        self.assertEqual(
            self._forward(items=[{"habit": self.stretch.id, "order": 1}]).status_code,
            400,
        )   # missing plan
        self.assertEqual(
            self._forward(items=[{"habit": 99999, "chain": self.morning.id, "order": 1}]).status_code,
            400,
        )   # unknown habit
        self.assertEqual(
            self._forward(
                from_date="not-a-date",
                items=[{"habit": self.stretch.id, "chain": self.morning.id, "order": 1}],
            ).status_code,
            400,
        )

    def test_rejects_duplicate_slot_in_items(self):
        # The same (habit, tier) slot listed twice is incoherent (last would
        # silently win) — reject it up front before any DB write.
        before = Schedule.objects.count()
        resp = self._forward(items=[
            {"habit": self.stretch.id, "chain": self.morning.id, "order": 1},
            {"habit": self.stretch.id, "chain": self.evening.id, "order": 2},
        ])
        self.assertEqual(resp.status_code, 400)
        # Nothing written (validation runs before the DB pass).
        self.assertEqual(Schedule.objects.count(), before)

    def test_duplicate_slot_differing_by_tier_is_allowed(self):
        # Same habit but DIFFERENT tiers are distinct slots and may co-exist.
        resp = self._forward(items=[
            {"habit": self.stretch.id, "chain": self.morning.id, "tier": 1, "order": 1},
            {"habit": self.stretch.id, "chain": self.evening.id, "tier": 2, "order": 1},
        ])
        self.assertEqual(resp.status_code, 200)

    def test_preexisting_duplicate_rows_return_409_not_500(self):
        # Simulate legacy/edge data: two Schedule rows already share the exact
        # (habit, tier, valid_from) the writer upserts. update_or_create would
        # raise MultipleObjectsReturned; the view must catch it and 409.
        Schedule.objects.create(
            habit=self.water, chain=self.morning, tier=None,
            order=1, valid_from=self.today,
        )
        Schedule.objects.create(
            habit=self.water, chain=self.evening, tier=None,
            order=2, valid_from=self.today,
        )
        resp = self._forward(items=[
            {"habit": self.water.id, "chain": self.morning.id, "order": 1},
        ])
        self.assertEqual(resp.status_code, 409)
        # Rolled back: the two pre-existing rows are untouched, none added.
        self.assertEqual(
            Schedule.objects.filter(
                habit=self.water, tier__isnull=True, valid_from=self.today
            ).count(),
            2,
        )

    # --- per-day path stays untouched ---------------------------------------

    def test_per_day_arrange_path_unchanged(self):
        # The toggle-OFF writer (/days/arrange/) must still write ScheduleDay only,
        # never a Schedule generation, and only affect its one day.
        before = Schedule.objects.count()
        resp = self.client.post(
            reverse("habits:arrange_day"),
            data=json.dumps({
                "date": self.today.isoformat(),
                "items": [
                    {"habit": self.water.id, "chain": self.evening.id, "order": 1},
                ],
            }),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        # No new Schedule rows (no recurring write).
        self.assertEqual(Schedule.objects.count(), before)
        # Tomorrow (template) does NOT see the per-day placement.
        future = self._placement(self._chain(self.tomorrow))
        self.assertEqual(future.get(self.water.id), [None])   # still Anytime
        # Today (now frozen) DOES.
        today = self._placement(self._chain(self.today))
        self.assertEqual(today[self.water.id], [self.evening.id])

    # --- per-moved-habit scope (fix #3) -------------------------------------
    #
    # A forward move sends ONE item (the moved habit's slot). It must change that
    # habit forward but leave EVERY other habit's forward placement untouched —
    # the siblings in its cycle, and anything an earlier edit set on another slot.

    def test_forward_move_of_one_habit_leaves_sibling_unchanged(self):
        # Move ONLY Stretch into Evening. Read (the sibling) shares Morning and is
        # NOT in the payload — its forward placement must not change.
        resp = self._forward(
            items=[{"habit": self.stretch.id, "chain": self.evening.id, "order": 1}]
        )
        self.assertEqual(resp.status_code, 200)

        future = self._placement(self._chain(self.tomorrow))
        # The moved habit changed forward.
        self.assertEqual(future[self.stretch.id], [self.evening.id])
        # The sibling is UNCHANGED forward — still Morning, where it always was.
        self.assertEqual(future[self.read.id], [self.morning.id])

        # No forward generation was written for the sibling: its only Schedule row
        # is still the base one, untouched.
        read_gens = Schedule.objects.filter(habit=self.read)
        self.assertEqual(read_gens.count(), 1)
        self.assertEqual(read_gens.first().valid_from, BASE_VALID_FROM)

    def test_forward_move_does_not_disturb_an_earlier_forward_edit(self):
        # An EARLIER toggle-ON edit moved Read into Evening (its own generation).
        self._forward(items=[{"habit": self.read.id, "chain": self.evening.id, "order": 5}])
        read_gen_id = Schedule.objects.get(
            habit=self.read, tier__isnull=True, valid_from=self.today
        ).id

        # Now a SEPARATE forward move of Stretch into Morning's slot. It must not
        # touch Read's existing forward generation at all.
        self._forward(items=[{"habit": self.stretch.id, "chain": self.morning.id, "order": 1}])

        read_gen = Schedule.objects.get(id=read_gen_id)
        self.assertEqual(read_gen.chain_id, self.evening.id)   # untouched
        self.assertEqual(read_gen.order, 5)
        # And forward, Read still reflects its earlier edit.
        future = self._placement(self._chain(self.tomorrow))
        self.assertEqual(future[self.read.id], [self.evening.id])

    def test_frozen_today_mirror_touches_only_the_moved_habit(self):
        # Freeze today (so reads come from ScheduleDay). Move ONLY Stretch.
        freeze_day(self.today)
        read_sd_before = ScheduleDay.objects.get(
            date=self.today, habit=self.read, tier__isnull=True
        )

        self._forward(items=[{"habit": self.stretch.id, "chain": self.evening.id, "order": 1}])

        # The moved habit's ScheduleDay mirror moved to Evening.
        stretch_sd = ScheduleDay.objects.get(
            date=self.today, habit=self.stretch, tier__isnull=True
        )
        self.assertEqual(stretch_sd.chain_id, self.evening.id)
        # The sibling's ScheduleDay for today is byte-for-byte unchanged (same row,
        # same cycle, same order) — the mirror never rewrote it.
        read_sd_after = ScheduleDay.objects.get(
            date=self.today, habit=self.read, tier__isnull=True
        )
        self.assertEqual(read_sd_after.id, read_sd_before.id)
        self.assertEqual(read_sd_after.chain_id, read_sd_before.chain_id)
        self.assertEqual(read_sd_after.order, read_sd_before.order)


class RetimeForwardTests(TestCase):
    """apply-to-future Phase 3: /plans/retime-forward/ writes a dated `ChainTime`
    row so a CYCLE'S TIME change sticks every day from a date forward, read via
    the precedence frozen-ChainDay > ChainTime > Chain.start_time. Independent of
    placement: it never touches Schedule/ScheduleDay, only the one cycle's time."""

    def setUp(self):
        self.today = timezone.localdate()
        self.yesterday = self.today - timedelta(days=1)
        self.tomorrow = self.today + timedelta(days=1)

        # Three cycles. A couple of habits, backdated so they "existed" on past
        # days (so the existed-by-then read filter doesn't hide them).
        self.morning = Chain.objects.create(start_time=time(7, 0))
        self.midday = Chain.objects.create(start_time=time(12, 0))
        self.evening = Chain.objects.create(start_time=time(20, 0))
        self.stretch = Habit.objects.create(name="Stretch")
        self.read = Habit.objects.create(name="Read")
        for h in (self.stretch, self.read):
            Habit.objects.filter(id=h.id).update(
                date_added=timezone.now() - timedelta(days=30)
            )
        # Stretch lives in Morning, Read in Midday (so each cycle has a habit and
        # therefore renders / freezes a ChainDay).
        Schedule.objects.create(habit=self.stretch, chain=self.morning, order=1)
        Schedule.objects.create(habit=self.read, chain=self.midday, order=1)

    def _forward(self, **body):
        return self.client.post(
            reverse("habits:retime_forward"),
            data=json.dumps(body), content_type="application/json",
        )

    def _chain(self, date):
        return self.client.get(reverse("habits:plan"), {"date": date.isoformat()})

    def _time_of(self, response, chain_id):
        """The effective time string a /plan/ response shows for a cycle, or None."""
        for g in json.loads(response.content):
            if g["id"] == chain_id:
                return g["time"]
        return None

    def _placement(self, response):
        out = {}
        for g in json.loads(response.content):
            for h in g["habits"]:
                out.setdefault(h["id"], []).append(g["id"])
        return out

    # --- forward time shows on future days ----------------------------------

    def test_forward_time_shows_on_unfrozen_future_day(self):
        # Move Morning to 08:00 from today forward.
        resp = self._forward(chain=self.morning.id, time="08:00")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(json.loads(resp.content)["from_date"], self.today.isoformat())

        # Tomorrow (not frozen): reads the new time via ChainTime.
        self.assertEqual(self._time_of(self._chain(self.tomorrow), self.morning.id),
                         "08:00:00")
        # Exactly one ChainTime row, for this cycle, at today.
        rows = ChainTime.objects.filter(chain=self.morning)
        self.assertEqual(rows.count(), 1)
        self.assertEqual(rows.first().valid_from, self.today)
        self.assertEqual(rows.first().start_time, time(8, 0))

    def test_past_day_unchanged(self):
        self._forward(chain=self.morning.id, time="08:00")
        # Yesterday: still the recurring 07:00 (ChainTime.valid_from=today doesn't
        # reach back; a frozen past day keeps its own locked time).
        self.assertEqual(self._time_of(self._chain(self.yesterday), self.morning.id),
                         "07:00:00")

    # --- per-cycle only ------------------------------------------------------

    def test_only_the_named_cycle_moves(self):
        self._forward(chain=self.morning.id, time="08:00")
        groups = self._chain(self.tomorrow)
        # The other two cycles keep their recurring times.
        self.assertEqual(self._time_of(groups, self.midday.id), "12:00:00")
        self.assertEqual(self._time_of(groups, self.evening.id), "20:00:00")
        # And no ChainTime row was written for them.
        self.assertFalse(ChainTime.objects.filter(chain=self.midday).exists())
        self.assertFalse(ChainTime.objects.filter(chain=self.evening).exists())

    # --- placement untouched (independence) ---------------------------------

    def test_placement_untouched(self):
        sched_before = {
            (s.habit_id, s.chain_id, s.valid_from)
            for s in Schedule.objects.all()
        }
        sd_before = ScheduleDay.objects.count()
        self._forward(chain=self.morning.id, time="08:00")
        sched_after = {
            (s.habit_id, s.chain_id, s.valid_from)
            for s in Schedule.objects.all()
        }
        self.assertEqual(sched_before, sched_after)   # no Schedule generation
        self.assertEqual(ScheduleDay.objects.count(), sd_before)  # no ScheduleDay write
        # The habits still sit where they were on a forward day.
        future = self._placement(self._chain(self.tomorrow))
        self.assertEqual(future[self.stretch.id], [self.morning.id])
        self.assertEqual(future[self.read.id], [self.midday.id])

    # --- frozen today is reflected ------------------------------------------

    def test_frozen_today_is_mirrored(self):
        freeze_day(self.today)   # today now reads its ChainDay-locked times
        self.assertTrue(ScheduleDay.objects.filter(date=self.today).exists())

        self._forward(chain=self.morning.id, time="08:00")

        # Today shows the new time (via the ChainDay mirror, since a frozen day
        # ignores ChainTime).
        self.assertEqual(self._time_of(self._chain(self.today), self.morning.id),
                         "08:00:00")
        pd = ChainDay.objects.get(chain=self.morning, date=self.today)
        self.assertEqual(pd.start_time, time(8, 0))
        # Tomorrow (still not frozen) shows it via ChainTime.
        self.assertEqual(self._time_of(self._chain(self.tomorrow), self.morning.id),
                         "08:00:00")

    def test_frozen_today_mirror_touches_only_the_named_cycle(self):
        freeze_day(self.today)
        midday_pd_before = ChainDay.objects.get(chain=self.midday, date=self.today)

        self._forward(chain=self.morning.id, time="08:00")

        # The OTHER cycle's locked time for today is byte-for-byte unchanged.
        midday_pd_after = ChainDay.objects.get(chain=self.midday, date=self.today)
        self.assertEqual(midday_pd_after.id, midday_pd_before.id)
        self.assertEqual(midday_pd_after.start_time, midday_pd_before.start_time)
        self.assertEqual(self._time_of(self._chain(self.today), self.midday.id),
                         "12:00:00")

    def test_non_frozen_today_needs_no_mirror(self):
        # Today is NOT frozen, so it reads ChainTime directly — no ChainDay written.
        self._forward(chain=self.morning.id, time="08:00")
        self.assertFalse(
            ChainDay.objects.filter(chain=self.morning, date=self.today).exists()
        )
        self.assertEqual(self._time_of(self._chain(self.today), self.morning.id),
                         "08:00:00")

    def test_frozen_future_day_keeps_its_own_time(self):
        # A deliberately pre-edited (frozen) FUTURE day keeps its locked time (D3).
        freeze_day(self.tomorrow)   # locks Morning at its recurring 07:00 for tomorrow
        self._forward(chain=self.morning.id, time="08:00")
        # Tomorrow still 07:00 (frozen ChainDay wins over the ChainTime).
        self.assertEqual(self._time_of(self._chain(self.tomorrow), self.morning.id),
                         "07:00:00")
        # The day AFTER tomorrow (not frozen) does get the new time.
        day_after = self.tomorrow + timedelta(days=1)
        self.assertEqual(self._time_of(self._chain(day_after), self.morning.id),
                         "08:00:00")

    # --- precedence ----------------------------------------------------------

    def test_chainday_beats_chaintime_on_a_frozen_day(self):
        # ChainTime moves Morning to 08:00 forward...
        self._forward(chain=self.morning.id, time="08:00")
        # ...but tomorrow gets a per-day ChainDay shift to 09:30 (e.g. running late),
        # then is frozen with that time.
        ChainDay.objects.create(chain=self.morning, date=self.tomorrow,
                               start_time=time(9, 30))
        self.assertEqual(self._time_of(self._chain(self.tomorrow), self.morning.id),
                         "09:30:00")   # ChainDay wins for that date

    def test_latest_chaintime_wins(self):
        # Two forward retimes; the later valid_from should win going forward.
        ChainTime.objects.create(chain=self.morning, valid_from=self.yesterday,
                                start_time=time(6, 30))
        self._forward(chain=self.morning.id, time="08:00")  # valid_from=today
        # Yesterday reads the 06:30 generation; tomorrow the 08:00 one.
        self.assertEqual(self._time_of(self._chain(self.yesterday), self.morning.id),
                         "06:30:00")
        self.assertEqual(self._time_of(self._chain(self.tomorrow), self.morning.id),
                         "08:00:00")

    # --- idempotency ---------------------------------------------------------

    def test_idempotent_repeat_updates_not_duplicates(self):
        self._forward(chain=self.morning.id, time="08:00")
        self._forward(chain=self.morning.id, time="09:15")   # same slot again
        rows = ChainTime.objects.filter(chain=self.morning, valid_from=self.today)
        self.assertEqual(rows.count(), 1)                   # updated, not a 2nd row
        self.assertEqual(rows.first().start_time, time(9, 15))

    # --- defaults / validation ----------------------------------------------

    def test_from_date_defaults_to_today(self):
        self._forward(chain=self.morning.id, time="08:00")
        self.assertTrue(
            ChainTime.objects.filter(chain=self.morning, valid_from=self.today).exists()
        )

    def test_honors_explicit_from_date(self):
        future = self.today + timedelta(days=5)
        resp = self._forward(chain=self.morning.id, time="08:00",
                             from_date=future.isoformat())
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(
            ChainTime.objects.filter(chain=self.morning, valid_from=future).exists()
        )
        # Tomorrow (before the from_date) is still the recurring time.
        self.assertEqual(self._time_of(self._chain(self.tomorrow), self.morning.id),
                         "07:00:00")

    def test_rejects_bad_input(self):
        self.assertEqual(self._forward(chain=999999, time="08:00").status_code, 400)
        self.assertEqual(self._forward(chain=self.morning.id, time="nope").status_code, 400)
        self.assertEqual(self._forward(chain=self.morning.id, time="25:00").status_code, 400)
        self.assertEqual(self._forward(time="08:00").status_code, 400)  # missing plan
        self.assertEqual(self._forward(chain=self.morning.id).status_code, 400)  # missing time
        self.assertEqual(
            self._forward(chain=self.morning.id, time="08:00",
                          from_date="not-a-date").status_code,
            400,
        )

    # --- zero-ChainTime behavior unchanged -----------------------------------

    def test_zero_chaintime_reads_recurring_time(self):
        # With no ChainTime rows at all, every day reads the plain recurring time —
        # identical to pre-Phase-3 behavior.
        self.assertFalse(ChainTime.objects.exists())
        for d in (self.yesterday, self.today, self.tomorrow):
            self.assertEqual(self._time_of(self._chain(d), self.morning.id), "07:00:00")
            self.assertEqual(self._time_of(self._chain(d), self.midday.id), "12:00:00")

    # --- OFF path (per-day retime) still per-day ----------------------------

    def test_off_path_retime_is_today_only(self):
        # The toggle-OFF gesture hits /plans/retime/ and must stay per-day: write a
        # ChainDay, never a ChainTime, and never reach tomorrow.
        resp = self.client.post(
            reverse("habits:retime_chain"),
            data=json.dumps({"chain": self.morning.id, "time": "08:00"}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(ChainTime.objects.exists())   # no recurring write
        self.assertTrue(
            ChainDay.objects.filter(chain=self.morning, date=self.today).exists()
        )
        # Tomorrow is back to the recurring time (per-day only).
        self.assertEqual(self._time_of(self._chain(self.tomorrow), self.morning.id),
                         "07:00:00")


class DeleteHabitTests(TestCase):
    """`/habits/<id>/delete/` removes a habit two ways, mirroring Google
    Calendar's recurring delete: "stop" (this and following — retire from today,
    keep the past) and "forever" (all — wipe the habit and its whole history).
    `/habits/<id>/resume/` un-retires a stopped habit."""

    def setUp(self):
        self.today = timezone.localdate()
        self.yesterday = self.today - timedelta(days=1)
        self.tomorrow = self.today + timedelta(days=1)

        # A scheduled habit, backdated so it counts as existing on past days
        # (update() bypasses auto_now_add).
        self.habit = Habit.objects.create(name="Stretch")
        Habit.objects.filter(id=self.habit.id).update(
            date_added=timezone.now() - timedelta(days=30)
        )
        self.chain = Chain.objects.create()
        Schedule.objects.create(habit=self.habit, chain=self.chain, order=1)

    def _statuses(self, response):
        groups = json.loads(response.content)
        return {h["id"]: h["status"] for group in groups for h in group["habits"]}

    def _plan(self, day):
        return self._statuses(
            self.client.get(reverse("habits:plan"), {"date": day.isoformat()})
        )

    def _stop(self):
        return self.client.post(
            reverse("habits:delete_habit", args=[self.habit.id]),
            data=json.dumps({"mode": "stop"}),
            content_type="application/json",
        )

    # --- stop (retire from today, keep history) -----------------------------

    def test_stop_sets_ended_on_today_and_keeps_the_row(self):
        resp = self._stop()
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(json.loads(resp.content)["ended"])
        self.habit.refresh_from_db()
        self.assertEqual(self.habit.ended_on, self.today)  # row still exists

    def test_stopped_habit_leaves_today_and_future_but_keeps_past(self):
        # A real, untouched past day BEFORE the stop so it's frozen as history.
        HabitLog.objects.create(
            habit=self.habit, date=self.yesterday, status=HabitLog.Status.COMPLETED
        )
        self._stop()
        # Gone from today and tomorrow (so it can never read as MISSED again)...
        self.assertNotIn(self.habit.id, self._plan(self.today))
        self.assertNotIn(self.habit.id, self._plan(self.tomorrow))
        # ...but yesterday still shows it, with its real status intact.
        self.assertEqual(self._plan(self.yesterday)[self.habit.id], "COMPLETED")

    def test_stopped_habit_does_not_read_as_missed_going_forward(self):
        # The whole point: an untouched FUTURE day must not turn the retired habit
        # into a miss — it simply isn't there.
        self._stop()
        self.assertNotIn(self.habit.id, self._plan(self.tomorrow))

    def test_stopped_habit_hidden_from_habits_list_unless_included(self):
        self._stop()
        default = json.loads(
            self.client.get(reverse("habits:habits_list")).content
        )
        self.assertNotIn(self.habit.id, [h["id"] for h in default])
        # ?include_ended=1 brings it back, flagged with its ended_on.
        included = json.loads(
            self.client.get(reverse("habits:habits_list"),
                             {"include_ended": "1"}).content
        )
        row = {h["id"]: h for h in included}[self.habit.id]
        self.assertEqual(row["ended_on"], self.today.isoformat())

    def test_stop_then_resume_brings_it_back(self):
        self._stop()
        resp = self.client.post(reverse("habits:resume_habit", args=[self.habit.id]))
        self.assertEqual(resp.status_code, 200)
        self.assertIsNone(json.loads(resp.content)["ended_on"])
        self.habit.refresh_from_db()
        self.assertIsNone(self.habit.ended_on)
        self.assertIn(self.habit.id, self._plan(self.today))  # back on the plan

    def test_blanket_skip_ignores_a_stopped_habit_today(self):
        self._stop()
        self.client.post(reverse("habits:skip_day"), data=json.dumps({}),
                         content_type="application/json")
        # No SKIPPED log written for the retired habit today.
        self.assertFalse(
            HabitLog.objects.filter(habit=self.habit, date=self.today).exists()
        )

    # --- forever (wipe the habit and all its history) -----------------------

    def test_forever_deletes_habit_and_all_its_history(self):
        # Give the habit a version + a past log + a frozen day so we can prove
        # everything attached is gone.
        tier, _ = Tier.objects.get_or_create(level=2)
        version = Version.objects.create(habit=self.habit, level=2, value="5 min",
                                         label=tier)
        HabitLog.objects.create(habit=self.habit, date=self.yesterday,
                                status=HabitLog.Status.COMPLETED)
        ScheduleDay.objects.create(date=self.yesterday, habit=self.habit,
                                   habit_name=self.habit.name, chain=self.chain)

        resp = self.client.post(
            reverse("habits:delete_habit", args=[self.habit.id]),
            data=json.dumps({"mode": "forever"}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(json.loads(resp.content)["deleted"])

        self.assertFalse(Habit.objects.filter(id=self.habit.id).exists())
        self.assertFalse(Schedule.objects.filter(habit_id=self.habit.id).exists())
        self.assertFalse(Version.objects.filter(habit_id=self.habit.id).exists())
        self.assertFalse(Version.objects.filter(id=version.id).exists())
        # History rows are explicitly removed, not left as nameless habit=null rows.
        self.assertFalse(HabitLog.objects.filter(habit_id=self.habit.id).exists())
        self.assertEqual(HabitLog.objects.filter(habit__isnull=True).count(), 0)
        self.assertFalse(ScheduleDay.objects.filter(habit_id=self.habit.id).exists())

    def test_forever_drops_orphan_note_but_keeps_a_shared_one(self):
        other = Habit.objects.create(name="Walk")
        orphan = Note.objects.create(body="only mine", date=self.today)
        orphan.habits.add(self.habit)
        shared = Note.objects.create(body="ours", date=self.today)
        shared.habits.add(self.habit, other)

        self.client.post(
            reverse("habits:delete_habit", args=[self.habit.id]),
            data=json.dumps({"mode": "forever"}),
            content_type="application/json",
        )
        self.assertFalse(Note.objects.filter(id=orphan.id).exists())   # no habits left
        self.assertTrue(Note.objects.filter(id=shared.id).exists())    # still on Walk

    # --- validation ---------------------------------------------------------

    def test_unknown_mode_is_rejected_and_changes_nothing(self):
        resp = self.client.post(
            reverse("habits:delete_habit", args=[self.habit.id]),
            data=json.dumps({"mode": "oops"}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertTrue(Habit.objects.filter(id=self.habit.id).exists())
        self.habit.refresh_from_db()
        self.assertIsNone(self.habit.ended_on)


class PauseWindowTests(TestCase):
    """Pause windows (HabitPause) are what make resume safe: a CLOSED past window
    keeps the days it covered off the schedule forever, so resuming never
    resurrects them as 'missed'. This is the round-trip Jennifer flagged."""

    def setUp(self):
        self.today = timezone.localdate()
        self.habit = Habit.objects.create(name="Stretch")
        Habit.objects.filter(id=self.habit.id).update(
            date_added=timezone.now() - timedelta(days=60)
        )
        self.chain = Chain.objects.create()
        Schedule.objects.create(habit=self.habit, chain=self.chain, order=1)

    def _plan(self, day):
        resp = self.client.get(reverse("habits:plan"), {"date": day.isoformat()})
        return {h["id"]: h["status"]
                for g in json.loads(resp.content) for h in g["habits"]}

    def _stop(self):
        return self.client.post(
            reverse("habits:delete_habit", args=[self.habit.id]),
            data=json.dumps({"mode": "stop"}), content_type="application/json")

    def _resume(self):
        return self.client.post(reverse("habits:resume_habit", args=[self.habit.id]))

    def test_stop_opens_a_window_and_resume_closes_it(self):
        self._stop()
        win = HabitPause.objects.get(habit=self.habit)
        self.assertEqual(win.start_date, self.today)
        self.assertIsNone(win.end_date)          # open while paused
        self._resume()
        win.refresh_from_db()
        self.assertEqual(win.end_date, self.today)  # closed on resume
        self.habit.refresh_from_db()
        self.assertIsNone(self.habit.ended_on)

    def test_resume_does_not_resurrect_past_paused_days(self):
        # A CLOSED window: paused 5 days ago, resumed 2 days ago. ended_on is null
        # (not currently paused) — exactly the post-resume state that used to
        # resurrect the gap as MISSED.
        five_ago = self.today - timedelta(days=5)
        two_ago = self.today - timedelta(days=2)
        HabitPause.objects.create(
            habit=self.habit, start_date=five_ago, end_date=two_ago)

        # A day INSIDE the window stays off the schedule -> never missed.
        self.assertNotIn(self.habit.id, self._plan(self.today - timedelta(days=3)))
        # The day BEFORE the pause is unaffected (still scheduled -> missed, untouched).
        self.assertEqual(
            self._plan(self.today - timedelta(days=6))[self.habit.id], "MISSED")
        # A day AFTER resume is back on the schedule.
        self.assertIn(self.habit.id, self._plan(self.today - timedelta(days=1)))

    def test_endpoint_round_trip_keeps_the_gap_clean(self):
        # Simulate an elapsed open pause (stopped 5 days ago), then resume for real.
        five_ago = self.today - timedelta(days=5)
        Habit.objects.filter(id=self.habit.id).update(ended_on=five_ago)
        HabitPause.objects.create(habit=self.habit, start_date=five_ago)  # open
        self._resume()
        # The gap a day in the middle stays clean even after resuming.
        self.assertNotIn(self.habit.id, self._plan(self.today - timedelta(days=3)))


class HabitsListDateTests(TestCase):
    """/habits/ takes ?date= to browse other days like /plan/: statuses come from
    that day, a past untouched day derives MISSED, and the list is the habits that
    APPLIED then (existed by the date and not paused on it)."""

    def setUp(self):
        self.today = timezone.localdate()
        self.yesterday = self.today - timedelta(days=1)
        self.habit = Habit.objects.create(name="Stretch")
        Habit.objects.filter(id=self.habit.id).update(
            date_added=timezone.now() - timedelta(days=30))

    def _get(self, date=None):
        params = {"date": date.isoformat()} if date else {}
        resp = self.client.get(reverse("habits:habits_list"), params)
        self.assertEqual(resp.status_code, 200)
        return {h["id"]: h for h in json.loads(resp.content)}

    def test_status_is_for_the_requested_day(self):
        HabitLog.objects.create(habit=self.habit, date=self.yesterday,
                                status=HabitLog.Status.COMPLETED)
        self.assertEqual(self._get(self.yesterday)[self.habit.id]["status"], "COMPLETED")
        self.assertEqual(self._get()[self.habit.id]["status"], "PENDING")  # today

    def test_past_untouched_day_reads_missed(self):
        self.assertEqual(self._get(self.yesterday)[self.habit.id]["status"], "MISSED")

    def test_hides_habit_created_after_the_viewed_day(self):
        new = Habit.objects.create(name="Meditate")   # date_added = today
        three_ago = self.today - timedelta(days=3)
        self.assertNotIn(new.id, self._get(three_ago))
        self.assertIn(new.id, self._get())            # today

    def test_hides_habit_paused_on_the_viewed_day(self):
        HabitPause.objects.create(
            habit=self.habit, start_date=self.today - timedelta(days=5),
            end_date=self.today - timedelta(days=2))
        self.assertNotIn(self.habit.id, self._get(self.today - timedelta(days=3)))
        self.assertIn(self.habit.id, self._get(self.today - timedelta(days=6)))

    def test_bad_date_is_rejected(self):
        resp = self.client.get(reverse("habits:habits_list"), {"date": "nope"})
        self.assertEqual(resp.status_code, 400)


class AspirationListTests(TestCase):
    """The aspirations list must show each attached habit ONCE, even when that
    habit sits in several time-slots. Habit's default ordering is by Schedule
    fields, so a plain prefetch JOINs Schedule and lists the habit once per slot
    — the list view prefetches ordered by a Habit field to avoid that."""

    def test_habit_in_many_slots_appears_once(self):
        habit = Habit.objects.create(name="Wind down")
        # Three time-slots (three chains) for the one habit — this is what made
        # "Sleep better" show each habit 3×.
        for i in range(3):
            chain = Chain.objects.create()
            Schedule.objects.create(habit=habit, chain=chain, order=i)

        asp = Aspiration.objects.create(name="Sleep better")
        asp.habits.add(habit)

        resp = self.client.get(reverse("habits:aspirations"))
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.content)
        # The strip's dates ride along so the client can label columns without
        # guessing "today" from its own (possibly different) timezone.
        self.assertEqual(len(body["window"]), 7)
        self.assertEqual(body["window"][-1], timezone.localdate().isoformat())
        row = next(a for a in body["aspirations"] if a["id"] == asp.id)
        self.assertEqual([h["id"] for h in row["habits"]], [habit.id])


class AspirationColorTests(TestCase):
    """An aspiration can carry a chosen bloom color (index 0-5); null = the
    id-based default. It flows through create/edit and every read."""

    def _create(self, **body):
        return self.client.post(
            reverse("habits:create_aspiration"),
            data=json.dumps(body), content_type="application/json",
        )

    def _edit(self, asp_id, **body):
        return self.client.post(
            reverse("habits:edit_aspiration", args=[asp_id]),
            data=json.dumps(body), content_type="application/json",
        )

    def test_create_stores_color_and_detail_returns_it(self):
        resp = self._create(name="Move more", color=3)
        self.assertEqual(resp.status_code, 201)
        asp_id = json.loads(resp.content)["id"]
        self.assertEqual(Aspiration.objects.get(id=asp_id).color, 3)
        detail = json.loads(
            self.client.get(reverse("habits:aspiration", args=[asp_id])).content
        )
        self.assertEqual(detail["color"], 3)

    def test_create_without_color_defaults_null(self):
        resp = self._create(name="Sleep better")
        asp_id = json.loads(resp.content)["id"]
        self.assertIsNone(Aspiration.objects.get(id=asp_id).color)

    def test_edit_changes_color(self):
        asp = Aspiration.objects.create(name="Read more", color=1)
        resp = self._edit(asp.id, color=4)
        self.assertEqual(resp.status_code, 200)
        asp.refresh_from_db()
        self.assertEqual(asp.color, 4)

    def test_edit_can_clear_color_to_null(self):
        asp = Aspiration.objects.create(name="Read more", color=1)
        self._edit(asp.id, color=None)
        asp.refresh_from_db()
        self.assertIsNone(asp.color)

    def test_out_of_range_color_is_rejected(self):
        resp = self._create(name="Bad", color=9)
        self.assertEqual(resp.status_code, 400)
        self.assertFalse(Aspiration.objects.filter(name="Bad").exists())

    def test_non_integer_color_is_rejected(self):
        self.assertEqual(self._create(name="Bad", color="blue").status_code, 400)

    def test_habits_list_emits_aspiration_color_for_dots(self):
        habit = Habit.objects.create(name="Walk")
        asp = Aspiration.objects.create(name="Move more", color=2)
        asp.habits.add(habit)
        rows = json.loads(self.client.get(reverse("habits:habits_list")).content)
        row = next(r for r in rows if r["id"] == habit.id)
        self.assertEqual(row["aspirations"], [{"id": asp.id, "color": 2}])


class AspirationGoalTests(TestCase):
    """An aspiration can carry an optional target_date, turning it into a dated
    goal. When set, the detail endpoint emits a `goal` block: a countdown
    (days_left) plus a per-day completion heatmap over [created_at, target_date].
    null target_date = an open-ended aspiration and `goal` is null."""

    def _create(self, **body):
        return self.client.post(
            reverse("habits:create_aspiration"),
            data=json.dumps(body), content_type="application/json",
        )

    def _edit(self, asp_id, **body):
        return self.client.post(
            reverse("habits:edit_aspiration", args=[asp_id]),
            data=json.dumps(body), content_type="application/json",
        )

    def _detail(self, asp_id):
        return json.loads(
            self.client.get(reverse("habits:aspiration", args=[asp_id])).content
        )

    def test_create_with_target_date_stores_it_and_detail_returns_goal(self):
        target = timezone.localdate() + timedelta(days=10)
        resp = self._create(name="First home", target_date=target.isoformat())
        self.assertEqual(resp.status_code, 201)
        asp_id = json.loads(resp.content)["id"]
        self.assertEqual(Aspiration.objects.get(id=asp_id).target_date, target)
        detail = self._detail(asp_id)
        self.assertEqual(detail["target_date"], target.isoformat())
        self.assertIsNotNone(detail["goal"])
        self.assertEqual(detail["goal"]["target_date"], target.isoformat())

    def test_open_ended_aspiration_has_no_goal(self):
        asp_id = json.loads(self._create(name="Sleep better").content)["id"]
        detail = self._detail(asp_id)
        self.assertIsNone(detail["target_date"])
        self.assertIsNone(detail["goal"])

    def test_edit_sets_then_clears_target_date(self):
        asp = Aspiration.objects.create(name="First home")
        target = timezone.localdate() + timedelta(days=30)
        self.assertEqual(self._edit(asp.id, target_date=target.isoformat()).status_code, 200)
        asp.refresh_from_db()
        self.assertEqual(asp.target_date, target)
        self._edit(asp.id, target_date=None)      # clear it -> open-ended again
        asp.refresh_from_db()
        self.assertIsNone(asp.target_date)

    def test_invalid_target_date_is_rejected(self):
        self.assertEqual(self._create(name="Bad", target_date="not-a-date").status_code, 400)
        self.assertFalse(Aspiration.objects.filter(name="Bad").exists())

    def test_heatmap_counts_completion_and_days_left(self):
        today = timezone.localdate()
        start = today - timedelta(days=4)
        target = today + timedelta(days=5)
        backdated = timezone.now() - timedelta(days=4)

        habit = Habit.objects.create(name="Walk")
        # Backdate existence so the habit "applies" across the whole window
        # (date_added is auto_now_add = now in tests).
        Habit.objects.filter(id=habit.id).update(date_added=backdated)
        HabitLog.objects.create(habit=habit, date=start, status=HabitLog.Status.COMPLETED)
        HabitLog.objects.create(habit=habit, date=today, status=HabitLog.Status.COMPLETED)

        asp = Aspiration.objects.create(name="First home", target_date=target)
        Aspiration.objects.filter(id=asp.id).update(created_at=backdated)
        asp.habits.add(habit)

        goal = self._detail(asp.id)["goal"]
        self.assertEqual(goal["start_date"], start.isoformat())
        self.assertEqual(goal["target_date"], target.isoformat())
        self.assertEqual(goal["total_days"], 10)       # start..target inclusive
        self.assertEqual(len(goal["days"]), 10)
        self.assertEqual(goal["days_left"], 5)
        self.assertEqual(goal["elapsed_days"], 5)      # start..today inclusive
        self.assertEqual(goal["all_done_days"], 2)     # start + today fully done
        # First day (the start) was completed: 1 of 1.
        self.assertEqual(goal["days"][0], {"d": start.isoformat(), "done": 1, "total": 1})
        # The last day is in the future -> hollow (done is null), still counts total.
        self.assertEqual(goal["days"][-1]["d"], target.isoformat())
        self.assertIsNone(goal["days"][-1]["done"])
        self.assertEqual(goal["days"][-1]["total"], 1)


class CreateHabitTests(TestCase):
    """A new habit is born with ONE ladder rung, tagged Roots by default, so it
    shows on the Habits page (which lists habits by their rungs) right away."""

    def _create(self, **body):
        res = self.client.post(
            reverse("habits:create_habit"),
            data=json.dumps({"name": "Drink water", **body}),
            content_type="application/json",
        )
        return res, res.json()

    def test_defaults_to_a_roots_rung(self):
        res, data = self._create()
        self.assertEqual(res.status_code, 201)
        version = Version.objects.get(habit_id=data["id"])
        self.assertEqual(version.level, 1)
        self.assertEqual(version.value, "")          # no amount yet
        self.assertEqual(version.label.level, Tier.objects.get(level=1).level)

    def test_growth_can_be_picked(self):
        _, data = self._create(label=2)
        self.assertEqual(Version.objects.get(habit_id=data["id"]).label.level, 2)

    def test_null_label_leaves_the_habit_plain(self):
        _, data = self._create(label=None)
        self.assertFalse(Version.objects.filter(habit_id=data["id"]).exists())

    def test_bad_label_is_rejected_and_nothing_is_created(self):
        res, _ = self._create(label=9)
        self.assertEqual(res.status_code, 400)
        self.assertFalse(Habit.objects.exists())


class HabitHistoryTests(TestCase):
    """The per-habit month calendar. The states that matter are the DERIVED ones:
    a past untouched day is MISSED, but a day before the habit existed (or inside
    a pause window) is ABSENT — rendering those the same would lie about her
    record."""

    def setUp(self):
        self.today = timezone.localdate()
        self.first = self.today.replace(day=1)
        self.habit = Habit.objects.create(name="Walk")
        # Born on the 1st, so most of the month "applies".
        Habit.objects.filter(id=self.habit.id).update(
            date_added=timezone.make_aware(
                timezone.datetime.combine(self.first, time(6, 0))
            )
        )

    def _history(self, month=None):
        url = reverse("habits:habit_history", args=[self.habit.id])
        res = self.client.get(url if month is None else f"{url}?month={month}")
        self.assertEqual(res.status_code, 200)
        return {d["d"]: d for d in res.json()["days"]}

    def test_spans_the_whole_month(self):
        res = self.client.get(reverse("habits:habit_history", args=[self.habit.id]))
        days = res.json()["days"]
        import calendar as _cal
        self.assertEqual(len(days), _cal.monthrange(self.today.year, self.today.month)[1])
        self.assertEqual(days[0]["d"], self.first.isoformat())

    def test_days_before_the_habit_existed_are_absent_not_missed(self):
        # Run this against LAST month, where every day is in the past regardless
        # of what today's date is — so the ABSENT/MISSED split is always exercised
        # (asserting it only when today happens to fall late in the month would
        # let the most important case silently skip).
        prev_end = self.first - timedelta(days=1)
        prev_first = prev_end.replace(day=1)
        born = prev_first + timedelta(days=10)
        Habit.objects.filter(id=self.habit.id).update(
            date_added=timezone.make_aware(timezone.datetime.combine(born, time(6, 0)))
        )
        days = self._history(f"{prev_first.year:04d}-{prev_first.month:02d}")
        self.assertEqual(days[(born - timedelta(days=1)).isoformat()]["state"], "ABSENT")
        # ...while a past day AFTER it existed, untouched, is a real miss.
        self.assertEqual(days[born.isoformat()]["state"], "MISSED")

    def test_paused_days_are_absent(self):
        start = self.first + timedelta(days=1)
        if start >= self.today:
            self.skipTest("needs a month with room before today")
        HabitPause.objects.create(
            habit=self.habit, start_date=start, end_date=start + timedelta(days=2)
        )
        days = self._history()
        self.assertEqual(days[start.isoformat()]["state"], "ABSENT")
        # end_date is EXCLUSIVE — active again ON that day.
        self.assertEqual(days[(start + timedelta(days=2)).isoformat()]["state"], "MISSED")

    def test_completed_and_skipped_are_reported(self):
        HabitLog.objects.create(habit=self.habit, date=self.today,
                                status=HabitLog.Status.COMPLETED)
        days = self._history()
        self.assertEqual(days[self.today.isoformat()]["state"], "COMPLETED")

    def test_future_days_are_pending_not_missed(self):
        last_day = max(self._history())
        if last_day == self.today.isoformat():
            self.skipTest("today is the last day of the month")
        self.assertEqual(self._history()[last_day]["state"], "PENDING")

    def test_reached_reports_the_highest_completed_rung(self):
        roots = Version.objects.create(
            habit=self.habit, level=1, value="1000 steps",
            label=Tier.objects.get_or_create(level=1)[0])
        growth = Version.objects.create(
            habit=self.habit, level=2, value="6000 steps",
            label=Tier.objects.get_or_create(level=2)[0])
        HabitLog.objects.create(habit=self.habit, date=self.today, version=roots,
                                tier=roots.label, status=HabitLog.Status.COMPLETED)
        HabitLog.objects.create(habit=self.habit, date=self.today, version=growth,
                                tier=growth.label, status=HabitLog.Status.COMPLETED)
        day = self._history()[self.today.isoformat()]
        self.assertEqual(day["state"], "COMPLETED")
        self.assertEqual(day["reached"]["value"], "6000 steps")   # the higher rung

    def test_bad_month_is_rejected(self):
        url = reverse("habits:habit_history", args=[self.habit.id])
        self.assertEqual(self.client.get(f"{url}?month=2026-13").status_code, 400)
        self.assertEqual(self.client.get(f"{url}?month=nope").status_code, 400)


class StepTests(TestCase):
    """Steps inside a habit, and the two-way sync she asked for: tapping the
    habit completes its steps, and ticking the last step completes the habit."""

    def setUp(self):
        self.today = timezone.localdate()
        self.habit = Habit.objects.create(name="Yoga / stretch")
        roots = Tier.objects.get_or_create(level=1)[0]
        growth = Tier.objects.get_or_create(level=2)[0]
        self.v1 = Version.objects.create(habit=self.habit, level=1, value="1 min", label=roots)
        self.v3 = Version.objects.create(habit=self.habit, level=2, value="3 mins", label=growth)
        self.cat = Step.objects.create(habit=self.habit, name="Cat cow", order=1)
        self.toe = Step.objects.create(habit=self.habit, name="Toe touches", order=2)
        # v1 = cat cow only; v3 = cat cow (longer) + toe touches
        self.v1_cat = VersionStep.objects.create(version=self.v1, step=self.cat, amount="1 min")
        self.v3_cat = VersionStep.objects.create(version=self.v3, step=self.cat, amount="3 mins")
        self.v3_toe = VersionStep.objects.create(version=self.v3, step=self.toe, amount="1 min")

    def _tick(self, version_step, done=True):
        res = self.client.post(
            reverse("habits:log_step", args=[self.habit.id]),
            data=json.dumps({"version_step": version_step.id, "done": done}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def _log(self, version, status):
        res = self.client.post(
            reverse("habits:log_habit", args=[self.habit.id]),
            data=json.dumps({"status": status, "version": version.id}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    # --- rolling UP: steps -> habit -------------------------------------
    def test_ticking_every_step_completes_the_rung(self):
        out = self._tick(self.v3_cat)
        self.assertEqual(out["status"], "PENDING")      # 1 of 2, not done yet
        out = self._tick(self.v3_toe)
        self.assertEqual(out["status"], "COMPLETED")    # last one closes it
        self.assertTrue(
            HabitLog.objects.filter(habit=self.habit, date=self.today,
                                    version=self.v3, status="COMPLETED").exists()
        )

    def test_unticking_a_step_walks_the_completion_back(self):
        self._tick(self.v3_cat)
        self._tick(self.v3_toe)
        out = self._tick(self.v3_toe, done=False)
        self.assertEqual(out["status"], "PENDING")

    def test_rolling_up_does_not_overwrite_a_deliberate_skip(self):
        # She SKIPPED the rung on purpose; a half-tick must not silently undo it.
        self._log(self.v3, "SKIPPED")
        out = self._tick(self.v3_cat)
        self.assertEqual(out["status"], "SKIPPED")

    # --- fanning OUT: habit -> steps ------------------------------------
    def test_completing_the_habit_ticks_that_rungs_steps(self):
        self._log(self.v3, "COMPLETED")
        done = set(StepLog.objects.filter(date=self.today, done=True)
                   .values_list("version_step_id", flat=True))
        self.assertEqual(done, {self.v3_cat.id, self.v3_toe.id})
        # ...and NOT the other rung's cell, which is a different amount.
        self.assertNotIn(self.v1_cat.id, done)

    def test_undoing_the_habit_clears_its_steps(self):
        self._log(self.v3, "COMPLETED")
        self._log(self.v3, "PENDING")
        self.assertFalse(StepLog.objects.filter(date=self.today).exists())

    def test_notes_alone_do_not_tick_steps(self):
        self.client.post(
            reverse("habits:log_habit", args=[self.habit.id]),
            data=json.dumps({"notes": "felt tight", "version": self.v3.id}),
            content_type="application/json",
        )
        self.assertFalse(StepLog.objects.filter(date=self.today).exists())

    # --- reads -----------------------------------------------------------
    def test_habits_list_reports_steps_and_their_done_state(self):
        self._tick(self.v3_cat)
        rows = self.client.get(reverse("habits:habits_list")).json()
        row = next(r for r in rows if r["id"] == self.habit.id)
        v3 = next(t for t in row["tiers"] if t["version"] == self.v3.id)
        self.assertEqual([s["name"] for s in v3["steps"]], ["Cat cow", "Toe touches"])
        self.assertEqual([s["done"] for s in v3["steps"]], [True, False])
        self.assertEqual([s["amount"] for s in v3["steps"]], ["3 mins", "1 min"])

    def test_a_completed_rung_reads_its_steps_done(self):
        # Completed via the habit, never step-by-step: the card must not show
        # the rung done with its steps unticked.
        self._log(self.v1, "COMPLETED")
        rows = self.client.get(reverse("habits:habits_list")).json()
        row = next(r for r in rows if r["id"] == self.habit.id)
        v1 = next(t for t in row["tiers"] if t["version"] == self.v1.id)
        self.assertTrue(all(s["done"] for s in v1["steps"]))

    # --- the editor ------------------------------------------------------
    def test_save_steps_rebuilds_the_grid(self):
        res = self.client.post(
            reverse("habits:save_habit_steps", args=[self.habit.id]),
            data=json.dumps({
                "steps": [{"id": self.cat.id, "name": "Cat-cow"},
                          {"name": "Hamstring"}],
                "amounts": [
                    {"version": self.v1.id, "step": self.cat.id, "amount": "1 min"},
                    {"version": self.v3.id, "step": self.cat.id, "amount": "5 mins"},
                    {"version": self.v3.id, "step": {"new": 1}, "amount": "30 sec"},
                ],
            }),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.cat.refresh_from_db()
        self.assertEqual(self.cat.name, "Cat-cow")            # renamed in place
        self.assertFalse(Step.objects.filter(id=self.toe.id).exists())  # dropped
        v3 = next(t for t in res.json()["tiers"] if t["version"] == self.v3.id)
        self.assertEqual([(s["name"], s["amount"]) for s in v3["steps"]],
                         [("Cat-cow", "5 mins"), ("Hamstring", "30 sec")])

    def test_save_steps_rejects_a_version_from_another_habit(self):
        other = Version.objects.create(
            habit=Habit.objects.create(name="Other"), level=1, value="x")
        res = self.client.post(
            reverse("habits:save_habit_steps", args=[self.habit.id]),
            data=json.dumps({
                "steps": [{"name": "A"}],
                "amounts": [{"version": other.id, "step": {"new": 0}, "amount": ""}],
            }),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 400)

    def test_log_step_rejects_a_step_from_another_habit(self):
        other_habit = Habit.objects.create(name="Other")
        ov = Version.objects.create(habit=other_habit, level=1, value="x")
        ostep = Step.objects.create(habit=other_habit, name="Nope", order=1)
        ovs = VersionStep.objects.create(version=ov, step=ostep, amount="")
        res = self.client.post(
            reverse("habits:log_step", args=[self.habit.id]),
            data=json.dumps({"version_step": ovs.id}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 400)


class SlotCompletionTests(TestCase):
    """Time on the ladder: rungs carry deadlines, and completing from a slot
    picks the version for her — the slot IS the record of when it happened."""

    def setUp(self):
        self.today = timezone.localdate()
        self.habit = Habit.objects.create(name="Wake up")
        roots = Tier.objects.get_or_create(level=1)[0]
        growth = Tier.objects.get_or_create(level=2)[0]
        # Easiest -> hardest: by 8am (Roots), by 7am (Growth).
        self.by8 = Version.objects.create(
            habit=self.habit, level=1, value="8am", label=roots, target_time=time(8, 0))
        self.by7 = Version.objects.create(
            habit=self.habit, level=2, value="7am", label=growth, target_time=time(7, 0))

    def _log(self, **body):
        res = self.client.post(
            reverse("habits:log_habit", args=[self.habit.id]),
            data=json.dumps(body), content_type="application/json")
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def _statuses(self):
        rows = self.client.get(reverse("habits:habits_list")).json()
        row = next(r for r in rows if r["id"] == self.habit.id)
        return {t["version"]: t["status"] for t in row["tiers"]}

    def test_early_slot_completes_everything(self):
        out = self._log(status="COMPLETED", slot="06:30")
        self.assertEqual(out["version"], self.by7.id)      # hardest met
        st = self._statuses()
        self.assertEqual(st[self.by7.id], "COMPLETED")
        self.assertEqual(st[self.by8.id], "COMPLETED")     # cascade down

    def test_late_slot_credits_the_met_rung_and_misses_the_blown_one(self):
        out = self._log(status="COMPLETED", slot="07:30")
        self.assertEqual(out["version"], self.by8.id)
        self.assertEqual(out["missed"], [self.by7.id])
        st = self._statuses()
        self.assertEqual(st[self.by8.id], "COMPLETED")
        self.assertEqual(st[self.by7.id], "MISSED")        # closed immediately

    def test_slot_time_is_stored_as_the_completion_time(self):
        # The log's time = the SLOT, never the wall-clock tap moment.
        self._log(status="COMPLETED", slot="07:30")
        log = HabitLog.objects.get(habit=self.habit, date=self.today, version=self.by8)
        self.assertEqual(log.time, time(7, 30))

    def test_slot_past_every_deadline_lands_on_the_base(self):
        out = self._log(status="COMPLETED", slot="15:00")
        self.assertIsNone(out["version"])
        base = HabitLog.objects.get(habit=self.habit, date=self.today,
                                    version__isnull=True)
        self.assertEqual(base.status, "COMPLETED")         # "I woke up"
        st = self._statuses()
        self.assertEqual(st[self.by7.id], "MISSED")        # no rung claims it
        self.assertEqual(st[self.by8.id], "MISSED")
        # ...but the whole-habit view still counts the day.
        rows = self.client.get(reverse("habits:habits_list")).json()
        row = next(r for r in rows if r["id"] == self.habit.id)
        self.assertEqual(row["status"], "COMPLETED")

    def test_undo_walks_the_whole_write_back(self):
        self._log(status="COMPLETED", slot="07:30")
        self._log(status="PENDING", slot="07:30")
        st = self._statuses()
        self.assertEqual(st[self.by7.id], "PENDING")
        self.assertEqual(st[self.by8.id], "PENDING")

    def test_slot_never_downgrades_a_real_completion(self):
        # She really did complete "by 7am" earlier; a later slot-complete of the
        # easier rung must not stamp MISSED over it.
        self._log(status="COMPLETED", version=self.by7.id)
        self._log(status="COMPLETED", slot="07:30")
        self.assertEqual(self._statuses()[self.by7.id], "COMPLETED")

    def test_slot_is_ignored_for_untimed_habits(self):
        plain = Habit.objects.create(name="Wash face")
        v = Version.objects.create(habit=plain, level=1, value="Cleanse")
        res = self.client.post(
            reverse("habits:log_habit", args=[plain.id]),
            data=json.dumps({"status": "COMPLETED", "slot": "07:30",
                             "version": v.id}),
            content_type="application/json")
        self.assertEqual(res.status_code, 200)
        # Normal single-rung write, no fan-out of missed rows.
        self.assertEqual(HabitLog.objects.filter(habit=plain).count(), 1)


class ScopedBaseCompletionTests(TestCase):
    """'The base should not light up every rung' — a whole-habit completion
    counts for the habit, never for its versions."""

    def setUp(self):
        self.habit = Habit.objects.create(name="Work out")
        self.v3 = Version.objects.create(habit=self.habit, level=1, value="3 mins")
        self.v5 = Version.objects.create(habit=self.habit, level=2, value="5 mins")

    def _row(self):
        rows = self.client.get(reverse("habits:habits_list")).json()
        return next(r for r in rows if r["id"] == self.habit.id)

    def test_base_completion_counts_for_the_habit_not_the_rungs(self):
        HabitLog.objects.create(habit=self.habit, date=timezone.localdate(),
                                status=HabitLog.Status.COMPLETED)
        row = self._row()
        self.assertEqual(row["status"], "COMPLETED")
        self.assertEqual([t["status"] for t in row["tiers"]],
                         ["PENDING", "PENDING"])

    def test_blanket_skip_still_covers_every_rung(self):
        HabitLog.objects.create(habit=self.habit, date=timezone.localdate(),
                                status=HabitLog.Status.SKIPPED)
        row = self._row()
        self.assertEqual([t["status"] for t in row["tiers"]],
                         ["SKIPPED", "SKIPPED"])


class RetagHistoryTests(TestCase):
    """'Your past completions — which rung were they?'"""

    def setUp(self):
        self.today = timezone.localdate()
        self.habit = Habit.objects.create(name="Work out")
        # Backdate existence so browsing past days still lists the habit.
        Habit.objects.filter(id=self.habit.id).update(
            date_added=timezone.now() - timedelta(days=30))
        # 3 old base completions from before the ladder existed.
        for d in range(3):
            HabitLog.objects.create(habit=self.habit,
                                    date=self.today - timedelta(days=d + 1),
                                    status=HabitLog.Status.COMPLETED)
        self.v3 = Version.objects.create(habit=self.habit, level=1, value="3 mins")
        self.v5 = Version.objects.create(habit=self.habit, level=2, value="5 mins")
        self.v10 = Version.objects.create(habit=self.habit, level=3, value="10 mins")

    def _retag(self, version):
        res = self.client.post(
            reverse("habits:retag_history", args=[self.habit.id]),
            data=json.dumps({"version": version}),
            content_type="application/json")
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def test_retag_turns_base_rows_into_rung_completions(self):
        out = self._retag(self.v5.id)
        self.assertEqual(out["retagged"], 3)
        self.assertEqual(
            HabitLog.objects.filter(habit=self.habit, version=self.v5).count(), 3)
        # A retagged day now reads 3 ✓ 5 ✓ 10 ✗ (derived missed, day is past).
        day = self.today - timedelta(days=1)
        url = reverse("habits:habits_list")
        rows = self.client.get(f"{url}?date={day.isoformat()}").json()
        row = next(r for r in rows if r["id"] == self.habit.id)
        by_id = {t["version"]: t["status"] for t in row["tiers"]}
        self.assertEqual(by_id[self.v3.id], "COMPLETED")
        self.assertEqual(by_id[self.v5.id], "COMPLETED")
        self.assertEqual(by_id[self.v10.id], "MISSED")

    def test_null_keeps_them_as_base(self):
        out = self._retag(None)
        self.assertEqual(out["retagged"], 0)
        self.assertEqual(
            HabitLog.objects.filter(habit=self.habit, version__isnull=True).count(), 3)

    def test_a_day_the_rung_already_has_is_skipped_not_collided(self):
        clash = self.today - timedelta(days=1)
        HabitLog.objects.create(habit=self.habit, date=clash, version=self.v5,
                                status=HabitLog.Status.MISSED)
        out = self._retag(self.v5.id)
        self.assertEqual(out["retagged"], 2)   # the clashing day left alone
        self.assertEqual(HabitLog.objects.filter(
            habit=self.habit, date=clash, version=self.v5).get().status, "MISSED")


class RoutineLowestRungTests(TestCase):
    """Block-complete credits a tiered member's lowest rung, not the base."""

    def setUp(self):
        self.routine = Routine.objects.create(name="Morning")
        self.habit = Habit.objects.create(name="Meditate")
        self.v1 = Version.objects.create(habit=self.habit, level=1, value="1 min")
        self.v5 = Version.objects.create(habit=self.habit, level=2, value="5 mins")
        chain = Chain.objects.create(start_time=time(7, 0))
        Schedule.objects.create(habit=self.habit, chain=chain, order=1,
                                routine=self.routine)

    def test_block_complete_credits_the_lowest_rung(self):
        res = self.client.post(
            reverse("habits:log_routine", args=[self.routine.id]),
            data=json.dumps({"status": "COMPLETED"}),
            content_type="application/json")
        self.assertEqual(res.status_code, 200, res.content)
        log = HabitLog.objects.get(habit=self.habit, date=timezone.localdate())
        self.assertEqual(log.version_id, self.v1.id)
        # Display: 1 min done, 5 mins honestly still open.
        rows = self.client.get(reverse("habits:habits_list")).json()
        row = next(r for r in rows if r["id"] == self.habit.id)
        by_id = {t["version"]: t["status"] for t in row["tiers"]}
        self.assertEqual(by_id[self.v1.id], "COMPLETED")
        self.assertEqual(by_id[self.v5.id], "PENDING")


class TypedRungFieldTests(TestCase):
    """target_time / duration round-trip through the ladder editor and create."""

    def test_save_versions_stores_and_returns_them(self):
        habit = Habit.objects.create(name="Wake up")
        res = self.client.post(
            reverse("habits:save_habit_versions", args=[habit.id]),
            data=json.dumps({"rungs": [
                {"value": "8am", "label": 1, "target_time": "08:00"},
                {"value": "7am", "label": 2, "target_time": "07:00",
                 "duration": "5 mins"},
            ]}),
            content_type="application/json")
        self.assertEqual(res.status_code, 200, res.content)
        tiers = res.json()["tiers"]
        self.assertEqual([t["target_time"] for t in tiers], ["08:00", "07:00"])
        self.assertEqual([t["duration"] for t in tiers], ["", "5 mins"])

    def test_create_habit_fills_the_starter_rung(self):
        res = self.client.post(
            reverse("habits:create_habit"),
            data=json.dumps({"name": "Wake up", "target_time": "07:00",
                             "duration": "10 mins"}),
            content_type="application/json")
        self.assertEqual(res.status_code, 201, res.content)
        v = Version.objects.get(habit_id=res.json()["id"])
        self.assertEqual(v.target_time, time(7, 0))
        self.assertEqual(v.duration, "10 mins")

    def test_bad_values_rejected(self):
        habit = Habit.objects.create(name="X")
        # duration is free text now, so only NON-text (and over-long) is bad.
        for rung in ({"value": "a", "target_time": "not a time"},
                     {"value": "a", "duration": 5},
                     {"value": "a", "duration": "x" * 51}):
            res = self.client.post(
                reverse("habits:save_habit_versions", args=[habit.id]),
                data=json.dumps({"rungs": [rung]}),
                content_type="application/json")
            self.assertEqual(res.status_code, 400, rung)


class TaskKindTests(TestCase):
    """`kind=TASK` marks FURNITURE — a fixed commitment ("Standup") that's on the
    plan only so the day's shape is visible and habits can be arranged around it.

    The rule that matters: a task is never completed, so it never logs — and the
    app derives MISSED from exactly that absence. Every check here exists to stop
    a task quietly reading as missed, or as anything else it isn't.
    """

    def setUp(self):
        self.today = timezone.localdate()
        self.chain = Chain.objects.create(start_time=time(9, 0), name="Work")
        self.habit = Habit.objects.create(name="Drink water")
        self.task = Habit.objects.create(name="Standup", kind=Habit.Kind.TASK)
        for h in (self.habit, self.task):
            Schedule.objects.create(habit=h, chain=self.chain)
        # date_added is auto_now_add, so both rows would be "didn't exist yet" on
        # the past days these tests look at. Back-date them so the past-day rules
        # (MISSED for the habit, nothing for the task) actually apply.
        Habit.objects.update(date_added=timezone.now() - timedelta(days=10))

    def _create(self, **body):
        res = self.client.post(
            reverse("habits:create_habit"),
            data=json.dumps({"name": "Log hours", **body}),
            content_type="application/json",
        )
        return res, res.json()

    # --- the model default ------------------------------------------------
    def test_habits_default_to_kind_habit(self):
        self.assertEqual(self.habit.kind, Habit.Kind.HABIT)

    # --- creating ---------------------------------------------------------
    def test_task_can_be_created_and_gets_no_rung(self):
        res, data = self._create(kind="TASK")
        self.assertEqual(res.status_code, 201)
        self.assertEqual(data["kind"], "TASK")
        # No ladder: a task has no "how much" to grow.
        self.assertFalse(Version.objects.filter(habit_id=data["id"]).exists())

    def test_task_gets_no_rung_even_when_a_label_is_sent(self):
        _, data = self._create(kind="TASK", label=2)
        self.assertFalse(Version.objects.filter(habit_id=data["id"]).exists())

    def test_bad_kind_is_rejected(self):
        res, _ = self._create(kind="CHORE")
        self.assertEqual(res.status_code, 400)
        self.assertFalse(Habit.objects.filter(name="Log hours").exists())

    # --- editing ----------------------------------------------------------
    def test_kind_can_be_changed_on_edit(self):
        res = self.client.post(
            reverse("habits:edit_habit", args=[self.habit.id]),
            data=json.dumps({"kind": "TASK"}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200)
        self.habit.refresh_from_db()
        self.assertEqual(self.habit.kind, Habit.Kind.TASK)

    def test_bad_kind_on_edit_is_rejected(self):
        res = self.client.post(
            reverse("habits:edit_habit", args=[self.habit.id]),
            data=json.dumps({"kind": "nope"}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 400)
        self.habit.refresh_from_db()
        self.assertEqual(self.habit.kind, Habit.Kind.HABIT)

    # --- THE ONE THAT MATTERS: a task never derives MISSED ----------------
    def _plan_rows(self, date):
        res = self.client.get(reverse("habits:plan"), {"date": date.isoformat()})
        self.assertEqual(res.status_code, 200)
        rows = {}
        for group in res.json():
            for row in group["habits"]:
                rows[row["name"]] = row
        return rows

    def test_task_is_not_missed_on_a_past_day(self):
        past = self.today - timedelta(days=3)
        rows = self._plan_rows(past)
        # The real habit went untouched, so it derives MISSED — the behaviour a
        # task must NOT inherit.
        self.assertEqual(rows["Drink water"]["status"], "MISSED")
        self.assertEqual(rows["Standup"]["status"], "PENDING")
        self.assertFalse(rows["Standup"]["done_today"])

    def test_task_is_not_missed_on_the_habits_page(self):
        past = self.today - timedelta(days=3)
        res = self.client.get(reverse("habits:habits_list"), {"date": past.isoformat()})
        by_name = {row["name"]: row for row in res.json()}
        self.assertEqual(by_name["Drink water"]["status"], "MISSED")
        self.assertEqual(by_name["Standup"]["status"], "PENDING")

    def test_task_month_history_never_reads_missed(self):
        res = self.client.get(
            reverse("habits:habit_history", args=[self.task.id]),
            {"month": self.today.strftime("%Y-%m")},
        )
        self.assertEqual(res.status_code, 200)
        states = {d["state"] for d in res.json()["days"]}
        self.assertNotIn("MISSED", states)

    # --- a task can't be logged -------------------------------------------
    def test_completing_a_task_is_rejected(self):
        res = self.client.post(
            reverse("habits:log_habit", args=[self.task.id]),
            data=json.dumps({"status": "COMPLETED"}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 400)
        self.assertFalse(HabitLog.objects.filter(habit=self.task).exists())

    def test_a_note_on_a_task_is_still_allowed(self):
        res = self.client.post(
            reverse("habits:log_habit", args=[self.task.id]),
            data=json.dumps({"notes": "moved to 9:30"}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200)

    # --- a task never streaks ---------------------------------------------
    def test_task_streak_is_always_zero(self):
        res = self.client.get(reverse("habits:habits_list"))
        by_name = {row["name"]: row for row in res.json()}
        self.assertEqual(by_name["Standup"]["streak"], 0)
