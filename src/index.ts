import {
  DOMAIN_ID,
  ENDPOINTS,
  WINDOW_DAYS,
  buildStatusModel,
  renderHtml,
  type CurrentDatabaseRow,
  type DailyDatabaseRow,
  type RecentDatabaseRow,
} from "./status";

interface ProbeResult {
  id: string;
  label: string;
  url: string;
  up: boolean;
  code: number;
  ms: number;
}

const BASE_HEADERS = {
  "Cache-Control": "public, max-age=60, stale-while-revalidate=240",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

async function probe(
  endpoint: (typeof ENDPOINTS)[number],
): Promise<ProbeResult> {
  const started = performance.now();
  try {
    const response = await fetch(endpoint.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "matteob-health-monitor/1.0" },
    });
    const ms = Math.round(performance.now() - started);
    if (response.body !== null) await response.body.cancel();
    return {
      id: endpoint.id,
      label: endpoint.label,
      url: endpoint.url,
      up:
        (response.status >= 200 && response.status < 400) ||
        ("allowNotFound" in endpoint &&
          endpoint.allowNotFound === true &&
          response.status === 404),
      code: response.status,
      ms,
    };
  } catch {
    return {
      id: endpoint.id,
      label: endpoint.label,
      url: endpoint.url,
      up: false,
      code: 0,
      ms: 10_000,
    };
  }
}

async function probeWithRetry(
  endpoint: (typeof ENDPOINTS)[number],
): Promise<ProbeResult> {
  const first = await probe(endpoint);
  if (first.up) return first;
  await scheduler.wait(5_000);
  return probe(endpoint);
}

async function reconcileDay(db: D1Database, run: number): Promise<void> {
  const day = new Date(run * 1000).toISOString().slice(0, 10);
  await db.batch([
    db.prepare("DELETE FROM daily WHERE day = ?1").bind(day),
    db
      .prepare(
        `INSERT INTO daily (day, id, slots_up, checks_recorded)
         SELECT day, id, SUM(slot_up), COUNT(*)
         FROM (
           SELECT
             date(ts, 'unixepoch') AS day,
             id,
             CAST(ts / 300 AS INTEGER) AS slot,
             MAX(up) AS slot_up
           FROM checks
           WHERE date(ts, 'unixepoch') = ?1
           GROUP BY date(ts, 'unixepoch'), id, CAST(ts / 300 AS INTEGER)
         )
         GROUP BY day, id`,
      )
      .bind(day),
    db
      .prepare(
        `INSERT INTO daily (day, id, slots_up, checks_recorded)
         SELECT day, ?2, SUM(slot_up), COUNT(*)
         FROM (
           SELECT day, slot, MAX(run_up) AS slot_up
           FROM (
             SELECT
               date(run, 'unixepoch') AS day,
               CAST(run / 300 AS INTEGER) AS slot,
               run,
               MIN(up) AS run_up
             FROM checks
             WHERE date(run, 'unixepoch') = ?1
             GROUP BY date(run, 'unixepoch'), CAST(run / 300 AS INTEGER), run
           )
           GROUP BY day, slot
         )
         GROUP BY day`,
      )
      .bind(day, DOMAIN_ID),
  ]);
}

async function storeResults(
  db: D1Database,
  run: number,
  results: ProbeResult[],
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO metadata (key, value) VALUES ('monitoring_start', ?1)
         ON CONFLICT(key) DO NOTHING`,
      )
      .bind(String(run)),
  ];

  for (const result of results) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO checks (run, ts, id, label, url, up, code, ms)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
        .bind(
          run,
          run,
          result.id,
          result.label,
          result.url,
          result.up ? 1 : 0,
          result.code,
          result.ms,
        ),
      db
        .prepare(
          `INSERT INTO current_status (id, label, url, up, code, ms, ts, first_ts)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
           ON CONFLICT(id) DO UPDATE SET
             label = excluded.label,
             url = excluded.url,
             up = excluded.up,
             code = excluded.code,
             ms = excluded.ms,
             ts = excluded.ts,
             first_ts = MIN(current_status.first_ts, excluded.first_ts)
           WHERE excluded.ts >= current_status.ts`,
        )
        .bind(
          result.id,
          result.label,
          result.url,
          result.up ? 1 : 0,
          result.code,
          result.ms,
          run,
        ),
    );
  }

  await db.batch(statements);
  await reconcileDay(db, run);
  await db
    .prepare("DELETE FROM checks WHERE ts < ?1")
    .bind(run - (WINDOW_DAYS + 2) * 86_400)
    .run();
}

async function runChecks(db: D1Database, scheduledTime: number): Promise<void> {
  const run = Math.floor(scheduledTime / 1000);
  const results = await Promise.all(ENDPOINTS.map(probeWithRetry));
  await storeResults(db, run, results);
  console.log(
    JSON.stringify({
      message: "health checks complete",
      run,
      endpoints: results.map(({ id, up, code, ms }) => ({ id, up, code, ms })),
    }),
  );
}

async function loadStatus(db: D1Database): Promise<ReturnType<typeof buildStatusModel>> {
  const now = new Date();
  const firstDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      (WINDOW_DAYS - 1) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);

  const [daily, current, recent, start] = await db.batch([
    db
      .prepare(
        `SELECT day, id, slots_up, checks_recorded
         FROM daily
         WHERE day >= ?1
         ORDER BY day, id`,
      )
      .bind(firstDay),
    db.prepare(
      `SELECT id, label, url, up, code, ms, ts, first_ts
       FROM current_status
       ORDER BY id`,
    ),
    db
      .prepare(
        `SELECT run, ts, id, up, code, ms
         FROM checks
         WHERE ts >= ?1
         ORDER BY ts`,
      )
      .bind(Math.floor(now.getTime() / 1000) - 6 * 3600 - 300),
    db.prepare("SELECT value FROM metadata WHERE key = 'monitoring_start'"),
  ]);

  const dailyRows = (daily.results ?? []) as DailyDatabaseRow[];
  const currentRows = (current.results ?? []) as CurrentDatabaseRow[];
  const recentRows = (recent.results ?? []) as RecentDatabaseRow[];
  const startRow = start.results?.[0] as { value?: string } | undefined;
  const monitoringStart = Number(startRow?.value ?? now.getTime() / 1000);
  return buildStatusModel(dailyRows, currentRows, recentRows, monitoringStart, now);
}

function response(
  body: BodyInit | null,
  contentType: string,
  status = 200,
): Response {
  return new Response(body, {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": contentType },
  });
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...BASE_HEADERS, Allow: "GET, HEAD" },
    });
  }

  const url = new URL(request.url);
  if (url.pathname === "/robots.txt") {
    return response(request.method === "HEAD" ? null : "User-agent: *\nAllow: /\n", "text/plain; charset=utf-8");
  }
  if (url.pathname === "/cdn-cgi/handler/scheduled") {
    return response(request.method === "HEAD" ? null : "Not Found", "text/plain; charset=utf-8", 404);
  }
  if (url.pathname !== "/" && url.pathname !== "/index.html" && url.pathname !== "/status.json") {
    return response(request.method === "HEAD" ? null : "Not Found", "text/plain; charset=utf-8", 404);
  }

  const status = await loadStatus(env.DB);
  if (url.pathname === "/status.json") {
    const body = request.method === "HEAD" ? null : JSON.stringify(status, null, 2);
    return response(body, "application/json; charset=utf-8");
  }

  const body = request.method === "HEAD" ? null : renderHtml(status);
  return response(body, "text/html; charset=utf-8");
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handleFetch(request, env);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "status request failed",
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return response("Status data is temporarily unavailable", "text/plain; charset=utf-8", 503);
    }
  },

  async scheduled(controller, env): Promise<void> {
    try {
      await runChecks(env.DB, controller.scheduledTime);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "scheduled health checks failed",
          scheduledTime: controller.scheduledTime,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
