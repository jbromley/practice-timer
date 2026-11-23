CREATE TABLE IF NOT EXISTS instruments (
    name TEXT PRIMARY KEY NOT NULL
);

CREATE TABLE IF NOT EXISTS intervals (
    id INTEGER PRIMARY KEY,
    minutes INTEGER NOT NULL CHECK (minutes BETWEEN 1 AND 1440),
    description TEXT NOT NULL,
    UNIQUE (minutes, description)
);

CREATE TABLE IF NOT EXISTS templates (
    name TEXT PRIMARY KEY NOT NULL,
    session_name TEXT NOT NULL,
    instrument TEXT REFERENCES instruments(name),
    description TEXT NOT NULL,
    created_on TEXT
);

CREATE TABLE IF NOT EXISTS template_intervals (
    template_name TEXT NOT NULL REFERENCES templates(name) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    interval_id INTEGER NOT NULL REFERENCES intervals(id),
    PRIMARY KEY (template_name, position)
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    practiced_on TEXT NOT NULL,
    name TEXT NOT NULL,
    instrument TEXT REFERENCES instruments(name),
    description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_intervals (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    interval_id INTEGER NOT NULL REFERENCES intervals(id),
    elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK (elapsed_ms >= 0),
    PRIMARY KEY (session_id, position)
);

CREATE TABLE IF NOT EXISTS active_session (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    session_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    template_name TEXT NOT NULL REFERENCES templates(name),
    running_since INTEGER,
    version INTEGER NOT NULL,
    FOREIGN KEY (session_id, position) REFERENCES session_intervals(session_id, position)
);

CREATE TABLE IF NOT EXISTS removed_session_intervals (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    interval_id INTEGER NOT NULL REFERENCES intervals(id),
    elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms > 0)
);

CREATE INDEX IF NOT EXISTS session_intervals_by_interval ON session_intervals(interval_id);
CREATE INDEX IF NOT EXISTS removed_session_intervals_by_session ON removed_session_intervals(session_id);
CREATE INDEX IF NOT EXISTS template_intervals_by_interval ON template_intervals(interval_id);
CREATE INDEX IF NOT EXISTS sessions_by_date ON sessions(practiced_on, id);
