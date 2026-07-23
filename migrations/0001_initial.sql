CREATE TABLE checks (
  run INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  up INTEGER NOT NULL CHECK (up IN (0, 1)),
  code INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  PRIMARY KEY (run, id)
);

CREATE INDEX checks_ts_idx ON checks (ts);

CREATE TABLE daily (
  day TEXT NOT NULL,
  id TEXT NOT NULL,
  slots_up INTEGER NOT NULL,
  checks_recorded INTEGER NOT NULL,
  PRIMARY KEY (day, id)
);

CREATE TABLE current_status (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  up INTEGER NOT NULL CHECK (up IN (0, 1)),
  code INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  first_ts INTEGER NOT NULL
);

CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
