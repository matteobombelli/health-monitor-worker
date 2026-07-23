DELETE FROM daily;

INSERT INTO daily (day, id, slots_up, checks_recorded)
SELECT day, id, SUM(slot_up), COUNT(*)
FROM (
  SELECT
    date(ts, 'unixepoch') AS day,
    id,
    CAST(ts / 300 AS INTEGER) AS slot,
    MAX(up) AS slot_up
  FROM checks
  GROUP BY date(ts, 'unixepoch'), id, CAST(ts / 300 AS INTEGER)
)
GROUP BY day, id;

INSERT INTO daily (day, id, slots_up, checks_recorded)
SELECT day, '__domain', SUM(slot_up), COUNT(*)
FROM (
  SELECT day, slot, MAX(run_up) AS slot_up
  FROM (
    SELECT
      date(run, 'unixepoch') AS day,
      CAST(run / 300 AS INTEGER) AS slot,
      run,
      MIN(up) AS run_up
    FROM checks
    GROUP BY date(run, 'unixepoch'), CAST(run / 300 AS INTEGER), run
  )
  GROUP BY day, slot
)
GROUP BY day;

DELETE FROM current_status;

INSERT INTO current_status (id, label, url, up, code, ms, ts, first_ts)
SELECT c.id, c.label, c.url, c.up, c.code, c.ms, c.ts, first_seen.first_ts
FROM checks c
JOIN (
  SELECT id, MAX(ts) AS max_ts
  FROM checks
  GROUP BY id
) latest ON latest.id = c.id AND latest.max_ts = c.ts
JOIN (
  SELECT id, MIN(ts) AS first_ts
  FROM checks
  GROUP BY id
) first_seen ON first_seen.id = c.id;

INSERT INTO metadata (key, value)
SELECT 'monitoring_start', CAST(MIN(ts) AS TEXT)
FROM checks
WHERE EXISTS (SELECT 1 FROM checks)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
