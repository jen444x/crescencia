# Crescencia

A habit tracker that learns from your behavior — not just what you complete, but why you skip, how you feel, and what you write about.

## The Idea

Most habit trackers just count streaks. This one digs deeper:

- **Habit completion + skip reasons** — understand _why_ habits fail, not just that they did
- **Mood tracking** — correlate emotional state with habit performance
- **Journaling** — free-form context the app can learn from
- **Smarter insights** — looking into alternatives to generic LLM advice (research in progress)

## Tech Stack

- **Backend:** Django + Django REST Framework
- **Frontend:** React
- **Database:** PostgreSQL (run in Docker)

## Getting Started

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- Python 3.13
- Git

### Setup

1. **Clone the repo**

   ```bash
   git clone https://github.com/jen444x/crescencia.git
   cd crescencia
   ```

2. **Create and activate a virtual environment**

   ```bash
   python -m venv venv
   source venv/bin/activate
   ```

3. **Install dependencies**

   ```bash
   pip install -r requirements.txt
   ```

4. **Configure environment variables** — copy the template and fill in your own values:

   ```bash
   cp .env.example .env
   ```

5. **Start the PostgreSQL database** (runs in Docker):

   ```bash
   docker compose up -d
   ```

6. **Apply database migrations**

   ```bash
   python manage.py migrate
   ```

7. **Create an admin user** (optional)

   ```bash
   python manage.py createsuperuser
   ```

8. **Run the development server**

   ```bash
   python manage.py runserver
   ```

   The app runs at http://127.0.0.1:8000.

## Status

🚧 Early development — rebuilding from Flask version with a better foundation.

## Previous Version

This is **v3** — a rebuild of my Flask + React [habit tracker (v2)](https://github.com/jen444x/Habit-Tracker). What's changed in v3:

- **Django + DRF** instead of Flask — built-in ORM, migrations, admin, and auth.
- **Redesigned database** — v2's flat schema is split into a normalized, multi-dimension model (area, difficulty tier, goal, chain) so habits can be expressed without overloading columns.
- **Dockerized Postgres** — one command to a clean, identical dev database.
