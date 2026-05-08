# Crescencia

A habit tracker that learns from your behavior — not just what you complete, but why you skip, how you feel, and what you write about.

## The Idea

Most habit trackers just count streaks. This one digs deeper:

- **Habit completion + skip reasons** — understand *why* habits fail, not just that they did
- **Mood tracking** — correlate emotional state with habit performance
- **Journaling** — free-form context the app can learn from
- **Smarter insights** — looking into alternatives to generic LLM advice (research in progress)

## Tech Stack

- **Backend:** Django + Django REST Framework
- **Frontend:** React (migrated from v1)
- **Database:** PostgreSQL

## Status

🚧 Early development — rebuilding from Flask version with a better foundation.

## Previous Version

This is a rebuild of my Flask + React habit tracker. Switching to Django for faster development and built-in features (admin panel, ORM, auth).
