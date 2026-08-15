from django.db import migrations, models


def minutes_to_text(apps, schema_editor):
    """Existing durations are bare minute counts ("10"). Say them the way the
    field now reads back on a row — "for 10 mins" — so nothing loses meaning."""
    Version = apps.get_model("habits", "Version")
    for version in Version.objects.exclude(duration=None).exclude(duration=""):
        raw = str(version.duration).strip()
        if not raw.isdigit():
            continue  # already prose (a re-run) — leave it alone
        minutes = int(raw)
        version.duration = f"{minutes} min" if minutes == 1 else f"{minutes} mins"
        version.save(update_fields=["duration"])


def text_to_minutes(apps, schema_editor):
    """Reverse: keep only a leading number, drop anything we can't count."""
    Version = apps.get_model("habits", "Version")
    for version in Version.objects.exclude(duration=None).exclude(duration=""):
        head = str(version.duration).strip().split(" ")[0]
        version.duration = head if head.isdigit() else ""
        version.save(update_fields=["duration"])


def blank_out_nulls(apps, schema_editor):
    """A CharField says "unset" with "", not NULL."""
    Version = apps.get_model("habits", "Version")
    Version.objects.filter(duration=None).update(duration="")


class Migration(migrations.Migration):

    dependencies = [
        ("habits", "0042_version_duration_version_target_time"),
    ]

    operations = [
        # Widen the column (Postgres casts the integers to text), then say them
        # in words. Dropping NULL comes in 0044: Postgres refuses to ALTER a
        # table later in the same transaction that has already written to it.
        migrations.AlterField(
            model_name="version",
            name="duration",
            field=models.CharField(max_length=50, null=True, blank=True),
        ),
        migrations.RunPython(minutes_to_text, text_to_minutes),
        migrations.RunPython(blank_out_nulls, migrations.RunPython.noop),
    ]
