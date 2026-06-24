from datetime import timedelta

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from django.utils.dateparse import parse_date

from habits.models import ScheduleDay
from habits.views import freeze_day


class Command(BaseCommand):
    """Freeze past days so their arrangement becomes immutable history.

    The nightly catch-all from the per-day-schedule contract: `/plan/` already
    freezes a past day the first time you *view* it, but a day you lived and
    never opened stays unfrozen and would re-draw from the current template. This
    command freezes those days ahead of time.

    It just calls the existing `freeze_day` helper, which is idempotent (a no-op
    if the day already has `ScheduleDay` rows), so re-running is always safe.

    Default: freeze every past day in a recent lookback window (the last 7 days,
    `--days N` to widen) that isn't already frozen. A nightly run thus freezes
    yesterday AND recovers any nights the job missed. `--date YYYY-MM-DD` instead
    freezes one specific past day.

    Never freezes today or a future day — those aren't history yet (matching
    `/plan/`, which only auto-freezes past days).
    """

    help = "Freeze past days (snapshot their arrangement) so history stays true."

    def add_arguments(self, parser):
        parser.add_argument(
            "--days",
            type=int,
            default=7,
            help="How many past days back to consider (default: 7). Ignored with --date.",
        )
        parser.add_argument(
            "--date",
            type=str,
            default=None,
            help="Freeze one specific past day (YYYY-MM-DD) instead of the window.",
        )

    def handle(self, *args, **options):
        today = timezone.localdate()

        if options["date"] is not None:
            target_date = parse_date(options["date"])
            if target_date is None:
                raise CommandError("--date must be a valid 'YYYY-MM-DD' date.")
            if target_date >= today:
                raise CommandError(
                    "--date must be a past day; today and future days aren't frozen."
                )
            dates = [target_date]
        else:
            days = options["days"]
            if days < 1:
                raise CommandError("--days must be a positive integer.")
            # The window is the last `days` past days: yesterday back through
            # `today - days`. Today and future are excluded — they aren't history.
            dates = [today - timedelta(days=n) for n in range(1, days + 1)]

        froze = []
        skipped = []
        for d in dates:
            # freeze_day is idempotent, but check first so we can report which
            # days were already frozen vs. freshly captured.
            if ScheduleDay.objects.filter(date=d).exists():
                skipped.append(d)
                continue
            freeze_day(d)
            froze.append(d)

        for d in sorted(froze):
            self.stdout.write(self.style.SUCCESS(f"Froze {d}"))
        for d in sorted(skipped):
            self.stdout.write(f"Already frozen, skipped {d}")

        self.stdout.write(
            self.style.SUCCESS(
                f"Done: froze {len(froze)}, already frozen {len(skipped)} "
                f"(considered {len(dates)} past day(s))."
            )
        )
