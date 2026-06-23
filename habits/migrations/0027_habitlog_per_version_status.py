import django.db.models.deletion
from django.db import migrations, models


def convert_achieved_tier_to_rows(apps, schema_editor):
    """Each existing completed tiered log carried its tier in `achieved_tier`
    (the high-water-mark). Move that onto the new per-version `tier` field so the
    row becomes that version's row. Only completed-with-a-tier logs are touched;
    everything else keeps tier=null (the untiered / whole-habit row)."""
    HabitLog = apps.get_model("habits", "HabitLog")
    HabitLog.objects.filter(achieved_tier__isnull=False).update(
        tier=models.F("achieved_tier")
    )


def noop(apps, schema_editor):
    # achieved_tier is dropped going forward; nothing to restore on reverse.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("habits", "0026_remove_habit_is_important_habit_is_support"),
    ]

    operations = [
        # 1. Add the version field (nullable, additive).
        migrations.AddField(
            model_name="habitlog",
            name="tier",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                to="habits.tier",
            ),
        ),
        # 2. Carry achieved_tier's info onto the new field BEFORE dropping it.
        migrations.RunPython(convert_achieved_tier_to_rows, noop),
        # 3. Swap the old (habit, date) unique for the two per-version ones.
        migrations.RemoveConstraint(
            model_name="habitlog",
            name="one_log_per_habit_per_day",
        ),
        migrations.AddConstraint(
            model_name="habitlog",
            constraint=models.UniqueConstraint(
                condition=models.Q(("tier__isnull", False)),
                fields=("habit", "date", "tier"),
                name="one_log_per_habit_date_tier",
            ),
        ),
        migrations.AddConstraint(
            model_name="habitlog",
            constraint=models.UniqueConstraint(
                condition=models.Q(("tier__isnull", True)),
                fields=("habit", "date"),
                name="one_untiered_log_per_habit_date",
            ),
        ),
        # 4. MISSED becomes a real, settable status.
        migrations.AlterField(
            model_name="habitlog",
            name="status",
            field=models.CharField(
                choices=[
                    ("PENDING", "Pending"),
                    ("COMPLETED", "Completed"),
                    ("SKIPPED", "Skipped"),
                    ("MISSED", "Missed"),
                ],
                default="PENDING",
                max_length=20,
            ),
        ),
        # 5. Drop the now-redundant high-water-mark (data already migrated).
        migrations.RemoveField(
            model_name="habitlog",
            name="achieved_tier",
        ),
    ]
