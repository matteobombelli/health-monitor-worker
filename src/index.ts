import {
  DOMAIN_ID,
  ENDPOINTS,
  RECENT_HOURS,
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

const PROBE_TIMEOUT_MS = 10_000;
const SSH_IDENTIFICATION =
  /(?:^|\r?\n)SSH-(?:1\.99|2\.0)-[^\r\n]+\r?\n/;

const BASE_HEADERS = {
  "Cache-Control": "public, max-age=60, stale-while-revalidate=240",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

export function hasSshIdentification(value: string): boolean {
  return SSH_IDENTIFICATION.test(value);
}

function elapsedSince(started: number): number {
  return Math.round(performance.now() - started);
}

async function waitForSshIdentification(
  webSocket: WebSocket,
  timeoutMs: number,
): Promise<boolean> {
  webSocket.binaryType = "arraybuffer";
  webSocket.accept();

  return new Promise((resolve) => {
    const decoder = new TextDecoder();
    let received = "";
    let settled = false;

    const finish = (up: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      webSocket.removeEventListener("message", onMessage);
      webSocket.removeEventListener("close", onClose);
      webSocket.removeEventListener("error", onError);
      if (webSocket.readyState === WebSocket.OPEN) {
        webSocket.close(1000, "health check complete");
      }
      resolve(up);
    };

    const onMessage = (event: MessageEvent): void => {
      const data: unknown = event.data;
      if (typeof data === "string") {
        received += data;
      } else if (data instanceof ArrayBuffer) {
        received += decoder.decode(data, { stream: true });
      } else if (ArrayBuffer.isView(data)) {
        received += decoder.decode(data, { stream: true });
      } else {
        finish(false);
        return;
      }

      if (hasSshIdentification(received)) {
        finish(true);
      } else if (received.length > 8192) {
        finish(false);
      }
    };

    const onClose = (): void => finish(false);
    const onError = (): void => finish(false);
    const timeout = setTimeout(() => finish(false), timeoutMs);

    webSocket.addEventListener("message", onMessage);
    webSocket.addEventListener("close", onClose);
    webSocket.addEventListener("error", onError);
  });
}

async function probeHttp(
  endpoint: (typeof ENDPOINTS)[number],
): Promise<ProbeResult> {
  const started = performance.now();
  try {
    const response = await fetch(endpoint.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { "User-Agent": "matteob-health-monitor/1.0" },
    });
    const ms = elapsedSince(started);
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
      ms: Math.min(PROBE_TIMEOUT_MS, elapsedSince(started)),
    };
  }
}

async function probeSsh(
  endpoint: Extract<(typeof ENDPOINTS)[number], { probe: "ssh" }>,
  env: Env,
): Promise<ProbeResult> {
  const started = performance.now();
  try {
    const response = await fetch(endpoint.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: {
        Upgrade: "websocket",
        "CF-Access-Client-Id": env.SSH_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": env.SSH_ACCESS_CLIENT_SECRET,
        "User-Agent": "matteob-health-monitor/1.0",
      },
    });
    const webSocket = response.webSocket;
    if (webSocket === null) {
      if (response.body !== null) await response.body.cancel();
      return {
        id: endpoint.id,
        label: endpoint.label,
        url: endpoint.url,
        up: false,
        code: response.status,
        ms: elapsedSince(started),
      };
    }

    const remainingMs = Math.max(
      1,
      PROBE_TIMEOUT_MS - elapsedSince(started),
    );
    const up = await waitForSshIdentification(webSocket, remainingMs);
    return {
      id: endpoint.id,
      label: endpoint.label,
      url: endpoint.url,
      up,
      code: response.status,
      ms: Math.min(PROBE_TIMEOUT_MS, elapsedSince(started)),
    };
  } catch {
    return {
      id: endpoint.id,
      label: endpoint.label,
      url: endpoint.url,
      up: false,
      code: 0,
      ms: Math.min(PROBE_TIMEOUT_MS, elapsedSince(started)),
    };
  }
}

async function probe(
  endpoint: (typeof ENDPOINTS)[number],
  env: Env,
): Promise<ProbeResult> {
  return "probe" in endpoint && endpoint.probe === "ssh"
    ? probeSsh(endpoint, env)
    : probeHttp(endpoint);
}

async function probeWithRetry(
  endpoint: (typeof ENDPOINTS)[number],
  env: Env,
): Promise<ProbeResult> {
  const first = await probe(endpoint, env);
  if (first.up) return first;
  await scheduler.wait(5_000);
  return probe(endpoint, env);
}

export async function storeResults(
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

  const written = await db.batch(statements);
  // The checks inserts sit at odd indexes; a duplicate delivery of the same
  // scheduledTime is ignored there, and must not be counted in daily again.
  const newRun = results.some(
    (_, index) => (written[1 + 2 * index].meta.changes ?? 0) > 0,
  );

  const followUp: D1PreparedStatement[] = [
    db
      .prepare("DELETE FROM checks WHERE ts < ?1")
      .bind(run - (WINDOW_DAYS + 2) * 86_400),
  ];
  if (newRun) {
    // Cron runs are aligned to five minutes and stored with ts = run, so each
    // run is exactly one slot and daily can be kept incrementally. Imported
    // history with denser samples must be rebuilt with scripts/rebuild.sql.
    const day = new Date(run * 1000).toISOString().slice(0, 10);
    const dailyUpsert = db.prepare(
      `INSERT INTO daily (day, id, slots_up, checks_recorded)
       VALUES (?1, ?2, ?3, 1)
       ON CONFLICT(day, id) DO UPDATE SET
         slots_up = slots_up + excluded.slots_up,
         checks_recorded = checks_recorded + 1`,
    );
    for (const result of results) {
      followUp.push(dailyUpsert.bind(day, result.id, result.up ? 1 : 0));
    }
    followUp.push(
      dailyUpsert.bind(day, DOMAIN_ID, results.every((result) => result.up) ? 1 : 0),
    );
  }
  await db.batch(followUp);
}

async function runChecks(
  env: Env,
  scheduledTime: number,
): Promise<void> {
  const run = Math.floor(scheduledTime / 1000);
  const results = await Promise.all(
    ENDPOINTS.map((endpoint) => probeWithRetry(endpoint, env)),
  );
  await storeResults(env.DB, run, results);
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
      .bind(Math.floor(now.getTime() / 1000) - RECENT_HOURS * 3600 - 300),
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
      await runChecks(env, controller.scheduledTime);
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
