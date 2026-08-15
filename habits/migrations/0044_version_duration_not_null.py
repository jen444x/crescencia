from django.db import migrations, models


class Migration(migrations.Migration):
    """Close the duration column to non-null, now that 0043 has turned every
    NULL into "". Its own migration because Postgres won't ALTER a table in a
    transaction that has already written to it."""

    dependencies = [
        ("habits", "0043_version_duration_text"),
    ]

    operations = [
        migrations.AlterField(
            model_name="version",
            name="duration",
            field=models.CharField(blank=True, default="", max_length=50),
        ),
    ]
