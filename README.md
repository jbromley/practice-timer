# Practice Timer

A personal music-practice timer with reusable templates and SQLite history. It uses Python 3.10 or later and runs without third-party packages.

## Run at home

Start the server from this directory.

```sh
python3 app.py --host 0.0.0.0
```

Open `http://localhost:8000` on the host computer. On your phone, connect to the same network and open port 8000 at the host computer’s LAN IP address, for example `http://192.168.1.10:8000`. For access from the host computer only, run `python3 app.py`.

The app has no login and is intended for use on a trusted home network. Keep it off the public internet.

The running timer can keep the screen awake in browsers that support Screen Wake Lock. On a phone, access the app through trusted HTTPS, such as a local HTTPS reverse proxy. A plain HTTP address on your home network cannot use the browser's wake lock.

The default database is `practice.sqlite3` beside `app.py`. Use `--db PATH` to choose another database file or `--port PORT` to change the port.

## Query practice data

The [SQLite schema](schema.sql) defines reusable intervals in `intervals`. The ordered `template_intervals` and `session_intervals` tables link templates and practice sessions to those definitions. Each session interval records elapsed milliseconds. Session totals are calculated from those rows, and template edits preserve past sessions.

Startup imports older databases into the relational schema in a single transaction. Older records without an instrument retain a null instrument.

```sql
SELECT s.practiced_on, s.name, s.instrument, si.position + 1 AS interval_number,
       i.description, i.minutes AS planned_minutes, si.elapsed_ms / 1000.0 AS actual_seconds
FROM sessions AS s
JOIN session_intervals AS si ON si.session_id = s.id
JOIN intervals AS i ON i.id = si.interval_id
WHERE NOT EXISTS (SELECT 1 FROM active_session AS a WHERE a.session_id = s.id)
ORDER BY s.practiced_on DESC, s.id DESC, si.position;
```

## Use

Enter a session name and instrument. The Session name dropdown loads saved templates, and the Instrument dropdown lists instruments from previous saves or starts. Add intervals to update the planned duration, then save the definition as a template or start practicing. New templates record their creation date, and saving over an existing template preserves that date. When you reuse an older template, fill in its instrument before saving or starting if needed.

Each practice session starts with today's date. Edit that date on the timer screen to change the date recorded in History.

Use the sun or moon button to switch between the Modus Operandi and Modus Vivendi palettes. Your choice is saved in the browser.

Pause and resume without resetting the interval. Previous and Next automatically continue the selected interval from its stored time. The timer counts up after reaching the planned duration. Active time continues when the browser is closed or put in the background. During practice, add or remove intervals, drag them into a different order, or edit the current interval description. Confirm each change by saving it to a template. Time spent on a removed interval still counts toward the session total and is recorded in History. Use End session to stop timing and save the session to History.
