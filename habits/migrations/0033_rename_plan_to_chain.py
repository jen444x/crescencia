# Rename the Plan model concept to Chain (the user-facing "cycle"/"chain").
#
# Data-safe, pure DDL: ONLY RenameModel + RenameField — no DeleteModel /
# CreateModel / AddField / RemoveField — so the live prod tables are renamed in
# place and no rows are dropped.
#
# NOTE on dependency: the spec said to depend on 0030, but PlanTime is created by
# 0031_schedule_valid_from_plantime and Aspiration by 0032_aspiration. Renaming
# PlanTime requires it to exist in the migration state, so this depends on the
# real leaf (0032), which transitively includes 0030. Depending on 0030 alone
# would fork the graph AND make RenameModel('PlanTime', ...) invalid.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('habits', '0032_aspiration'),
    ]

    operations = [
        # 1) Rename the model classes (tables) first.
        migrations.RenameModel(
            old_name='Plan',
            new_name='Chain',
        ),
        migrations.RenameModel(
            old_name='PlanDay',
            new_name='ChainDay',
        ),
        migrations.RenameModel(
            old_name='PlanTime',
            new_name='ChainTime',
        ),
        # 2) Then rename each `plan` FK field to `chain` (DB column -> chain_id).
        migrations.RenameField(
            model_name='schedule',
            old_name='plan',
            new_name='chain',
        ),
        migrations.RenameField(
            model_name='scheduleday',
            old_name='plan',
            new_name='chain',
        ),
        migrations.RenameField(
            model_name='chainday',
            old_name='plan',
            new_name='chain',
        ),
        migrations.RenameField(
            model_name='chaintime',
            old_name='plan',
            new_name='chain',
        ),
        # 3) Bring the migration STATE in line with the renamed field references so
        # `makemigrations` stays clean (these are state/no-op DB-wise alongside the
        # renames above, not new schema):
        #   - Habit's ordering lookup now traverses the renamed FK.
        migrations.AlterModelOptions(
            name='habit',
            options={'ordering': ['schedule__chain__start_time', 'schedule__order']},
        ),
        #   - ChainDay's unique constraint now references the renamed `chain` field.
        #     The constraint NAME is deliberately kept as-is (internal identifier).
        migrations.RemoveConstraint(
            model_name='chainday',
            name='one_time_override_per_plan_per_day',
        ),
        migrations.AddConstraint(
            model_name='chainday',
            constraint=models.UniqueConstraint(
                fields=('chain', 'date'),
                name='one_time_override_per_plan_per_day',
            ),
        ),
    ]
