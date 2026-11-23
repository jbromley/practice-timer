import argparse
from contextlib import closing
from datetime import date
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
import time
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent
ASSETS = {
    "/": ("index.html", "text/html"),
    "/app.js": ("app.js", "text/javascript"),
    "/style.css": ("style.css", "text/css"),
}
SCHEMA = ROOT / "schema.sql"


class RequestError(Exception):
    def __init__(self, message, status=HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = status


def clean_text(value, limit, required=False):
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise RequestError(f"Enter valid text of up to {limit} characters.")
    return value.strip()


def clean_interval(interval):
    if not isinstance(interval, dict):
        raise RequestError("Enter a valid interval.")
    minutes = interval.get("minutes")
    if type(minutes) is not int or not 1 <= minutes <= 1440:
        raise RequestError("Enter a duration between 1 and 1440 whole minutes.")
    return {"minutes": minutes, "description": clean_text(interval.get("description", ""), 500)}


def definition(value):
    if not isinstance(value, dict):
        raise RequestError("Enter a session definition.")
    intervals = value.get("intervals")
    if not isinstance(intervals, list) or len(intervals) > 200:
        raise RequestError("A session can have up to 200 intervals.")
    return {
        "name": clean_text(value.get("name"), 120, required=True),
        "instrument": clean_text(value.get("instrument", ""), 120, required=True),
        "description": clean_text(value.get("description", ""), 2000),
        "intervals": [clean_interval(interval) for interval in intervals],
    }


def now_ms():
    return time.time_ns() // 1_000_000


def connect(path):
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def interval_id(db, interval):
    fields = (interval["minutes"], interval["description"])
    db.execute("INSERT OR IGNORE INTO intervals (minutes, description) VALUES (?, ?)", fields)
    return db.execute(
        "SELECT id FROM intervals WHERE minutes = ? AND description = ?", fields
    ).fetchone()[0]


def remember_instrument(db, data):
    instrument = data.get("instrument") or None
    if instrument is not None:
        db.execute("INSERT OR IGNORE INTO instruments VALUES (?)", (instrument,))
    return instrument


def save_template(db, name, data, *, imported=False):
    db.execute(
        """INSERT INTO templates (name, session_name, instrument, description, created_on) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (name) DO UPDATE SET session_name = excluded.session_name,
               instrument = excluded.instrument, description = excluded.description""",
        (name, data["name"], remember_instrument(db, data), data["description"],
         None if imported else date.today().isoformat()),
    )
    db.execute("DELETE FROM template_intervals WHERE template_name = ?", (name,))
    db.executemany(
        "INSERT INTO template_intervals (template_name, position, interval_id) VALUES (?, ?, ?)",
        ((name, index, interval_id(db, interval)) for index, interval in enumerate(data["intervals"])),
    )


def insert_session(db, data, practiced_on, session_id=None):
    return db.execute(
        "INSERT INTO sessions (id, practiced_on, name, instrument, description) VALUES (?, ?, ?, ?, ?)",
        (session_id, practiced_on, data["name"], remember_instrument(db, data), data["description"]),
    ).lastrowid


def session_intervals(db, session_id):
    return [
        dict(row) for row in db.execute(
            """SELECT i.minutes, i.description, si.elapsed_ms
               FROM session_intervals AS si JOIN intervals AS i ON i.id = si.interval_id
               WHERE si.session_id = ? ORDER BY si.position""",
            (session_id,),
        )
    ]


def session_definition(row, intervals):
    return {
        "name": row["name"],
        "instrument": row["instrument"],
        "description": row["description"],
        "intervals": intervals,
    }


def template_definition(db, row):
    intervals = [
        dict(interval) for interval in db.execute(
            """SELECT i.minutes, i.description
               FROM template_intervals AS ti JOIN intervals AS i ON i.id = ti.interval_id
               WHERE ti.template_name = ? ORDER BY ti.position""",
            (row["template_name"],),
        )
    ]
    return session_definition(row, intervals)


TEMPLATE_FIELDS = "SELECT name AS template_name, session_name AS name, instrument, description, created_on FROM templates"


def active_row(db):
    return db.execute("SELECT * FROM active_session WHERE id = 1").fetchone()


def read_active(db):
    row = db.execute(
        """SELECT a.session_id, a.position, a.template_name, a.running_since, a.version,
                  s.name, s.instrument, s.description, s.practiced_on
           FROM active_session AS a JOIN sessions AS s ON s.id = a.session_id"""
    ).fetchone()
    if row is None:
        return None
    intervals = session_intervals(db, row["session_id"])
    elapsed = [interval.pop("elapsed_ms") for interval in intervals]
    return {
        "definition": session_definition(row, intervals),
        "date": row["practiced_on"],
        "template_name": row["template_name"],
        "index": row["position"],
        "elapsed_ms": elapsed,
        "removed_elapsed_ms": db.execute(
            "SELECT COALESCE(SUM(elapsed_ms), 0) FROM removed_session_intervals WHERE session_id = ?",
            (row["session_id"],),
        ).fetchone()[0],
        "running_since": row["running_since"],
        "version": row["version"],
    }


def accrue(db, active, now):
    if active["running_since"] is not None:
        db.execute(
            """UPDATE session_intervals SET elapsed_ms = elapsed_ms + ?
               WHERE session_id = ? AND position = ?""",
            (max(0, now - active["running_since"]), active["session_id"], active["position"]),
        )


def read_api(db, path):
    if path == "/api/instruments":
        rows = db.execute("SELECT name FROM instruments ORDER BY name COLLATE NOCASE, name")
        return [row[0] for row in rows]
    if path == "/api/templates":
        rows = db.execute(TEMPLATE_FIELDS + " ORDER BY template_name COLLATE NOCASE, template_name")
        return [
            {"name": row["template_name"], "created_on": row["created_on"], "definition": template_definition(db, row)}
            for row in rows
        ]
    if path == "/api/active":
        return {"run": read_active(db), "now": now_ms()}
    if path == "/api/history":
        rows = db.execute(
            """SELECT s.id, s.practiced_on, s.name,
                      COALESCE((SELECT SUM(elapsed_ms) FROM session_intervals WHERE session_id = s.id), 0)
                    + COALESCE((SELECT SUM(elapsed_ms) FROM removed_session_intervals WHERE session_id = s.id), 0)
                      AS total_ms
               FROM sessions AS s
               WHERE NOT EXISTS (SELECT 1 FROM active_session AS a WHERE a.session_id = s.id)
               ORDER BY s.practiced_on DESC, s.id DESC"""
        )
        return [dict(row) for row in rows]
    if path.startswith("/api/history/"):
        try:
            session_id = int(path.rsplit("/", 1)[-1])
            if not 1 <= session_id <= 2**63 - 1:
                raise ValueError
        except ValueError:
            raise RequestError("Session not found.", HTTPStatus.NOT_FOUND)
        row = db.execute(
            """SELECT name, practiced_on, instrument, description FROM sessions
               WHERE id = ? AND NOT EXISTS (SELECT 1 FROM active_session WHERE session_id = ?)""",
            (session_id, session_id),
        ).fetchone()
        if row:
            intervals = session_intervals(db, session_id)
            intervals.extend(dict(item) for item in db.execute(
                """SELECT i.minutes, i.description, r.elapsed_ms, 1 AS removed
                   FROM removed_session_intervals AS r JOIN intervals AS i ON i.id = r.interval_id
                   WHERE r.session_id = ? ORDER BY r.id""",
                (session_id,),
            ))
            return {
                **session_definition(row, intervals),
                "date": row["practiced_on"],
                "total_ms": sum(interval["elapsed_ms"] for interval in intervals),
            }
    raise RequestError("Page not found.", HTTPStatus.NOT_FOUND)


def practice_date(value):
    try:
        return date.fromisoformat(value).isoformat()
    except (ValueError, TypeError):
        raise RequestError("Enter a valid practice date.")


def start_session(db, body, now):
    data = definition(body.get("definition"))
    name = clean_text(body.get("template_name"), 120, required=True)
    if not data["intervals"]:
        raise RequestError("Add at least one interval before starting.")
    practiced_on = practice_date(body.get("date", date.today().isoformat()))
    if body.get("save_template"):
        save_template(db, name, data)
    else:
        saved = db.execute(TEMPLATE_FIELDS + " WHERE templates.name = ?", (name,)).fetchone()
        expected = {**data, "name": saved["name"]} if saved and data["name"] == name else data
        if not saved or template_definition(db, saved) != expected:
            raise RequestError(
                "The template changed. Save the current definition under a template name.",
                HTTPStatus.CONFLICT,
            )
    session_id = insert_session(db, data, practiced_on)
    db.execute(
        """INSERT INTO session_intervals (session_id, position, interval_id)
           SELECT ?, position, interval_id FROM template_intervals WHERE template_name = ?""",
        (session_id, name),
    )
    db.execute(
        """INSERT INTO active_session (id, session_id, position, template_name, running_since, version)
           VALUES (1, ?, 0, ?, ?, ?)""",
        (session_id, name, now, now * 1000),
    )


def edit_intervals(db, active, body, now):
    session_id = active["session_id"]
    template_name = clean_text(body.get("template_name"), 120, required=True)
    accrue(db, active, now)
    rows = list(db.execute(
        """SELECT si.interval_id, si.elapsed_ms, i.minutes, i.description
           FROM session_intervals AS si JOIN intervals AS i ON i.id = si.interval_id
           WHERE si.session_id = ? ORDER BY si.position""",
        (session_id,),
    ))
    current = rows[active["position"]]
    action = body["action"]
    if action == "add_interval":
        if len(rows) >= 200:
            raise RequestError("A session can have up to 200 intervals.")
        interval = clean_interval(body.get("interval"))
        rows.append({**interval, "interval_id": interval_id(db, interval), "elapsed_ms": 0})
    else:
        index = body.get("index")
        if type(index) is not int or not 0 <= index < len(rows):
            raise RequestError("Choose a valid interval.")
        if action == "move_interval":
            target = body.get("target")
            if type(target) is not int or not 0 <= target < len(rows):
                raise RequestError("Choose a valid interval position.")
            rows.insert(target, rows.pop(index))
        else:
            if len(rows) == 1:
                raise RequestError("Keep at least one interval in the active session.")
            removed = rows.pop(index)
            if removed["elapsed_ms"]:
                db.execute(
                    """INSERT INTO removed_session_intervals (session_id, interval_id, elapsed_ms)
                       VALUES (?, ?, ?)""",
                    (session_id, removed["interval_id"], removed["elapsed_ms"]),
                )
            if removed is current:
                current = rows[min(index, len(rows) - 1)]

    data = session_definition(
        db.execute("SELECT name, instrument, description FROM sessions WHERE id = ?", (session_id,)).fetchone(),
        [{"minutes": row["minutes"], "description": row["description"]} for row in rows],
    )
    save_template(db, template_name, data)
    db.executemany(
        """INSERT INTO session_intervals (session_id, position, interval_id, elapsed_ms) VALUES (?, ?, ?, ?)
           ON CONFLICT (session_id, position) DO UPDATE SET
               interval_id = excluded.interval_id, elapsed_ms = excluded.elapsed_ms""",
        ((session_id, index, row["interval_id"], row["elapsed_ms"]) for index, row in enumerate(rows)),
    )
    position = next(index for index, row in enumerate(rows) if row is current)
    running_since = now if active["running_since"] is not None else None
    db.execute(
        """UPDATE active_session SET position = ?, template_name = ?, running_since = ?, version = version + 1
           WHERE id = 1""",
        (position, template_name, running_since),
    )
    db.execute("DELETE FROM session_intervals WHERE session_id = ? AND position >= ?", (session_id, len(rows)))


def update_active(db, active, body, now):
    action = body.get("action")
    session_id = active["session_id"]
    position = active["position"]
    running_since = active["running_since"]
    template_name = active["template_name"]
    if action == "toggle":
        accrue(db, active, now)
        running_since = now if running_since is None else None
    elif action in ("previous", "next"):
        position += -1 if action == "previous" else 1
        exists = db.execute(
            "SELECT 1 FROM session_intervals WHERE session_id = ? AND position = ?",
            (session_id, position),
        ).fetchone()
        if not exists:
            raise RequestError("There is no interval in that direction.")
        accrue(db, active, now)
        running_since = now
    elif action == "set_date":
        db.execute("UPDATE sessions SET practiced_on = ? WHERE id = ?", (practice_date(body.get("date")), session_id))
    elif action == "describe":
        description = clean_text(body.get("description"), 500)
        data = read_active(db)["definition"]
        interval = data["intervals"][position]
        if description != interval["description"]:
            template_name = clean_text(body.get("template_name"), 120, required=True)
            interval["description"] = description
            db.execute(
                "UPDATE session_intervals SET interval_id = ? WHERE session_id = ? AND position = ?",
                (interval_id(db, interval), session_id, position),
            )
            save_template(db, template_name, data)
    elif action in ("add_interval", "remove_interval", "move_interval"):
        edit_intervals(db, active, body, now)
        return
    elif action == "end":
        accrue(db, active, now)
        db.execute("DELETE FROM active_session WHERE id = 1")
        return
    else:
        raise RequestError("Unknown timer action.")
    db.execute(
        """UPDATE active_session SET position = ?, template_name = ?, running_since = ?, version = version + 1
           WHERE id = 1""",
        (position, template_name, running_since),
    )


def write_api(db, path, body):
    if path in ("/api/templates", "/api/templates/delete"):
        name = clean_text(body.get("template_name"), 120, required=True)
        if path == "/api/templates/delete":
            if db.execute("SELECT 1 FROM active_session WHERE template_name = ?", (name,)).fetchone():
                raise RequestError("End the active session before deleting its template.", HTTPStatus.CONFLICT)
            db.execute("DELETE FROM templates WHERE name = ?", (name,))
        else:
            save_template(db, name, definition(body.get("definition")))
            row = db.execute("SELECT created_on FROM templates WHERE name = ?", (name,)).fetchone()
            return {"name": name, "created_on": row["created_on"]}
        return {"name": name}
    if path not in ("/api/start", "/api/action"):
        raise RequestError("Page not found.", HTTPStatus.NOT_FOUND)
    active = active_row(db)
    now = now_ms()
    if path == "/api/start":
        if active:
            raise RequestError("A session is already active.", HTTPStatus.CONFLICT)
        start_session(db, body, now)
    else:
        if not active or body.get("version") != active["version"]:
            raise RequestError("The active session changed. Try again.", HTTPStatus.CONFLICT)
        update_active(db, active, body, now)
    return {"run": read_active(db), "now": now}


def import_session(db, data, practiced_on, elapsed, session_id=None):
    session_id = insert_session(db, data, practiced_on, session_id)
    db.executemany(
        """INSERT INTO session_intervals (session_id, position, interval_id, elapsed_ms)
           VALUES (?, ?, ?, ?)""",
        (
            (session_id, index, interval_id(db, interval), elapsed_ms)
            for index, (interval, elapsed_ms) in enumerate(zip(data["intervals"], elapsed, strict=True))
        ),
    )
    return session_id


def initialize_database(path):
    with closing(connect(path)) as db, db:
        db.execute("PRAGMA secure_delete = ON")
        db.execute("BEGIN IMMEDIATE")
        template_columns = {row["name"] for row in db.execute("PRAGMA table_info(templates)")}
        legacy = "definition" in template_columns
        legacy_instruments = legacy and db.execute("PRAGMA table_info(instruments)").fetchone() is not None
        if legacy:
            db.execute("ALTER TABLE templates RENAME TO legacy_templates")
            db.execute("ALTER TABLE sessions RENAME TO legacy_sessions")
            db.execute("ALTER TABLE active_session RENAME TO legacy_active_session")
        elif template_columns and "created_on" not in template_columns:
            db.execute("ALTER TABLE templates ADD COLUMN created_on TEXT")
        if legacy_instruments:
            db.execute("ALTER TABLE instruments RENAME TO legacy_instruments")
        for statement in SCHEMA.read_text().split(";"):
            if statement.strip():
                db.execute(statement)
        if legacy:
            if legacy_instruments:
                db.execute("INSERT INTO instruments SELECT name FROM legacy_instruments")
                db.execute("DROP TABLE legacy_instruments")
            for row in db.execute("SELECT name, definition FROM legacy_templates"):
                save_template(db, row["name"], json.loads(row["definition"]), imported=True)
            for row in db.execute("SELECT id, practiced_on, record FROM legacy_sessions"):
                data = json.loads(row["record"])
                elapsed = [interval["elapsed_ms"] for interval in data["intervals"]]
                import_session(db, data, row["practiced_on"], elapsed, row["id"])
            row = db.execute("SELECT run FROM legacy_active_session").fetchone()
            if row:
                run = json.loads(row["run"])
                session_id = import_session(db, run["definition"], run["date"], run["elapsed_ms"])
                db.execute(
                    """INSERT INTO active_session (id, session_id, position, template_name, running_since, version)
                       VALUES (1, ?, ?, ?, ?, ?)""",
                    (session_id, run["index"], run["template_name"], run["running_since"], run["version"]),
                )
            db.execute("DROP TABLE legacy_active_session")
            db.execute("DROP TABLE legacy_sessions")
            db.execute("DROP TABLE legacy_templates")


class Handler(BaseHTTPRequestHandler):
    def send_data(self, status, payload, content_type):
        self.send_response(status)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(payload)

    def send_json(self, status, data):
        self.send_data(status, json.dumps(data).encode(), "application/json")

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ASSETS:
            filename, content_type = ASSETS[path]
            self.send_data(HTTPStatus.OK, (ROOT / "static" / filename).read_bytes(), content_type)
        else:
            self.handle_api(path)

    def do_POST(self):
        self.handle_api(urlsplit(self.path).path)

    def handle_api(self, path):
        try:
            with closing(connect(self.server.database)) as db, db:
                if self.command == "GET":
                    db.execute("BEGIN")
                    result = read_api(db, path)
                else:
                    if self.headers.get_content_type() != "application/json":
                        raise RequestError("Send a JSON request.", HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
                    try:
                        length = int(self.headers.get("Content-Length", "0"))
                        if not 0 < length <= 1_000_000:
                            raise ValueError
                        body = json.loads(self.rfile.read(length))
                        if not isinstance(body, dict):
                            raise ValueError
                    except (ValueError, RecursionError):
                        raise RequestError("Invalid request body.")
                    db.execute("BEGIN IMMEDIATE")
                    result = write_api(db, path, body)
            self.send_json(HTTPStatus.OK, result)
        except RequestError as error:
            self.send_json(error.status, {"error": str(error)})
        except sqlite3.Error as error:
            self.log_error("%s", error)
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "The database could not complete the request."})


def main():
    parser = argparse.ArgumentParser(description="Run Practice Timer.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--db", type=Path, default=ROOT / "practice.sqlite3")
    args = parser.parse_args()
    initialize_database(args.db)
    with ThreadingHTTPServer((args.host, args.port), Handler) as server:
        server.database = args.db
        print(f"Practice Timer is listening on http://{args.host}:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
