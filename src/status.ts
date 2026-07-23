export const WINDOW_DAYS = 30;
export const CHECK_INTERVAL = 300;
export const RECENT_HOURS = 4;
export const DOMAIN_ID = "__domain";

export const ENDPOINTS = [
  { id: "home", label: "Portfolio", url: "https://matteob.dev" },
  {
    id: "apps",
    label: "Apps",
    url: "https://apps.matteob.dev",
    allowNotFound: true,
  },
  {
    id: "webtunes",
    label: "WebTunes",
    url: "https://apps.matteob.dev/projects/webtunes",
  },
  {
    id: "ssh",
    label: "ssh",
    url: "https://ssh.matteob.dev",
    probe: "ssh",
  },
] as const;

export type EndpointId = (typeof ENDPOINTS)[number]["id"];

export interface DailyDatabaseRow {
  day: string;
  id: string;
  slots_up: number;
  checks_recorded: number;
}

export interface CurrentDatabaseRow {
  id: string;
  label: string;
  url: string;
  up: number;
  code: number;
  ms: number;
  ts: number;
  first_ts: number;
}

export interface RecentDatabaseRow {
  run: number;
  ts: number;
  id: string;
  up: number;
  code: number;
  ms: number;
}

interface DayModel {
  date: string;
  uptime_pct: number | null;
  slots_expected: number;
  slots_up: number;
}

interface RecentSlotModel {
  checked_at: string;
  up: boolean | null;
  http_code: string | null;
  latency_ms: number | null;
}

interface CurrentModel {
  up: boolean;
  http_code: string;
  latency_ms: number;
  checked_at: string;
}

interface EndpointModel {
  id: EndpointId;
  label: string;
  url: string;
  uptime_30d_pct: number | null;
  checks_30d: number;
  current: CurrentModel | null;
  days: DayModel[];
  recent_4h: RecentSlotModel[];
}

export interface StatusModel {
  generated_at: string;
  window_days: number;
  domain: {
    label: string;
    up_now: boolean | null;
    uptime_30d_pct: number | null;
    runs_30d: number;
    days: DayModel[];
    recent_4h: RecentSlotModel[];
  };
  endpoints: EndpointModel[];
}

function dayStartUnix(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / 1000;
}

function dayStrings(now: Date): string[] {
  const result: string[] = [];
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  for (let offset = WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
    result.push(new Date(today.getTime() - offset * 86_400_000).toISOString().slice(0, 10));
  }
  return result;
}

function expectedSlots(day: string, monitoringStart: number, nowTs: number): number {
  const start = dayStartUnix(day);
  const effectiveStart = Math.max(start, monitoringStart);
  const effectiveEnd = Math.min(start + 86_400, nowTs);
  if (effectiveEnd <= effectiveStart) return 0;

  const first = Math.floor(effectiveStart / CHECK_INTERVAL);
  const last = Math.floor((effectiveEnd - 1) / CHECK_INTERVAL);
  return last - first + 1;
}

function roundPct(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

function buildDays(
  days: string[],
  rows: Map<string, DailyDatabaseRow>,
  monitoringStart: number,
  nowTs: number,
): { days: DayModel[]; totalPct: number | null; checks: number } {
  let totalUp = 0;
  let totalExpected = 0;
  let checks = 0;

  const models = days.map((day) => {
    const row = rows.get(day);
    const expected = expectedSlots(day, monitoringStart, nowTs);
    const up = Math.min(row?.slots_up ?? 0, expected);
    const pct = expected === 0 ? null : (100 * up) / expected;
    totalUp += up;
    totalExpected += expected;
    checks += row?.checks_recorded ?? 0;
    return {
      date: day,
      uptime_pct: roundPct(pct),
      slots_expected: expected,
      slots_up: up,
    };
  });

  return {
    days: models,
    totalPct: totalExpected === 0 ? null : (100 * totalUp) / totalExpected,
    checks,
  };
}

function buildRecent(
  recentRows: RecentDatabaseRow[],
  endpointStarts: Map<string, number>,
  nowTs: number,
): Map<string, RecentSlotModel[]> {
  const lastSlot = Math.floor(nowTs / CHECK_INTERVAL);
  const firstSlot = lastSlot - RECENT_HOURS * (3600 / CHECK_INTERVAL) + 1;
  const byEndpoint = new Map<string, Map<number, RecentDatabaseRow>>();

  for (const row of recentRows) {
    if (!ENDPOINTS.some((endpoint) => endpoint.id === row.id)) continue;
    const slot = Math.floor(row.ts / CHECK_INTERVAL);
    const rows = byEndpoint.get(row.id) ?? new Map<number, RecentDatabaseRow>();
    const existing = rows.get(slot);
    if (
      existing === undefined ||
      (row.up === 1 && existing.up !== 1) ||
      (row.up === existing.up && row.ts > existing.ts)
    ) {
      rows.set(slot, row);
    }
    byEndpoint.set(row.id, rows);
  }

  const result = new Map<string, RecentSlotModel[]>();
  for (const endpoint of ENDPOINTS) {
    const rows = byEndpoint.get(endpoint.id) ?? new Map();
    const start = endpointStarts.get(endpoint.id) ?? Number.POSITIVE_INFINITY;
    const slots: RecentSlotModel[] = [];
    for (let slot = firstSlot; slot <= lastSlot; slot += 1) {
      const row = rows.get(slot);
      const slotTs = slot * CHECK_INTERVAL;
      slots.push({
        checked_at: new Date(slotTs * 1000).toISOString(),
        up: slotTs < start ? null : row?.up === 1,
        http_code: row ? String(row.code).padStart(3, "0") : null,
        latency_ms: row?.ms ?? null,
      });
    }
    result.set(endpoint.id, slots);
  }

  const domainStart = Math.max(
    ...ENDPOINTS.map(
      (endpoint) => endpointStarts.get(endpoint.id) ?? Number.POSITIVE_INFINITY,
    ),
  );
  const domainSlots: RecentSlotModel[] = [];
  for (let slot = firstSlot; slot <= lastSlot; slot += 1) {
    const slotTs = slot * CHECK_INTERVAL;
    const endpointRows = ENDPOINTS.map((endpoint) => byEndpoint.get(endpoint.id)?.get(slot));
    const hasAll = endpointRows.every((row) => row !== undefined);
    domainSlots.push({
      checked_at: new Date(slotTs * 1000).toISOString(),
      up:
        slotTs < domainStart
          ? null
          : hasAll && endpointRows.every((row) => row?.up === 1),
      http_code: null,
      latency_ms: null,
    });
  }
  result.set(DOMAIN_ID, domainSlots);
  return result;
}

export function buildStatusModel(
  dailyRows: DailyDatabaseRow[],
  currentRows: CurrentDatabaseRow[],
  recentRows: RecentDatabaseRow[],
  monitoringStart: number,
  now: Date,
): StatusModel {
  const days = dayStrings(now);
  const nowTs = now.getTime() / 1000;
  const current = new Map(currentRows.map((row) => [row.id, row]));
  const endpointStarts = new Map(currentRows.map((row) => [row.id, row.first_ts]));
  const recent = buildRecent(recentRows, endpointStarts, nowTs);
  const bySeries = new Map<string, Map<string, DailyDatabaseRow>>();

  for (const row of dailyRows) {
    const series = bySeries.get(row.id) ?? new Map<string, DailyDatabaseRow>();
    series.set(row.day, row);
    bySeries.set(row.id, series);
  }

  const domainStats = buildDays(
    days,
    bySeries.get(DOMAIN_ID) ?? new Map(),
    monitoringStart,
    nowTs,
  );
  const currentValues = ENDPOINTS.map((endpoint) => current.get(endpoint.id));
  const domainCurrent =
    currentValues.some((value) => value === undefined)
      ? null
      : currentValues.every((value) => value?.up === 1);

  const endpoints = ENDPOINTS.map((endpoint): EndpointModel => {
    const stats = buildDays(
      days,
      bySeries.get(endpoint.id) ?? new Map(),
      current.get(endpoint.id)?.first_ts ?? nowTs,
      nowTs,
    );
    const latest = current.get(endpoint.id);
    return {
      id: endpoint.id,
      label: endpoint.label,
      url: endpoint.url,
      uptime_30d_pct: roundPct(stats.totalPct),
      checks_30d: stats.checks,
      current: latest
        ? {
            up: latest.up === 1,
            http_code: String(latest.code).padStart(3, "0"),
            latency_ms: latest.ms,
            checked_at: new Date(latest.ts * 1000).toISOString().replace(".000Z", "+00:00"),
          }
        : null,
      days: stats.days,
      recent_4h: recent.get(endpoint.id) ?? [],
    };
  });

  return {
    generated_at: now.toISOString().replace(".000Z", "+00:00"),
    window_days: WINDOW_DAYS,
    domain: {
      label: "matteob.dev (all endpoints)",
      up_now: domainCurrent,
      uptime_30d_pct: roundPct(domainStats.totalPct),
      runs_30d: domainStats.checks,
      days: domainStats.days,
      recent_4h: recent.get(DOMAIN_ID) ?? [],
    },
    endpoints,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

function formatPct(pct: number | null): string {
  if (pct === null) return "-";
  if (pct >= 99.995) return "100%";
  return `${pct.toFixed(2)}%`;
}

function dayStatus(pct: number | null): "up" | "partial" | "down" | "nodata" {
  if (pct === null) return "nodata";
  if (pct >= 99.95) return "up";
  if (pct >= 95) return "partial";
  return "down";
}

const STATUS_WORD = {
  up: "Operational",
  partial: "Degraded",
  down: "Down",
  nodata: "Not monitored",
} as const;

function barStrip(days: DayModel[], label: string): string {
  const cells = days
    .map((day) => {
      const state = dayStatus(day.uptime_pct);
      const pretty = new Date(`${day.date}T00:00:00Z`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
      const title = day.slots_expected
        ? `${pretty}: ${formatPct(day.uptime_pct)} (${day.slots_up} of ${day.slots_expected} slots up)`
        : `${pretty}: not monitored`;
      return `<div class="cell ${state}" title="${escapeHtml(title)}"></div>`;
    })
    .join("");
  return `<div class="bars" role="img" aria-label="${escapeHtml(
    `Daily uptime for ${label}, oldest to newest`,
  )}">${cells}</div>`;
}

function recentStrip(slots: RecentSlotModel[], label: string): string {
  const dots = slots
    .map((slot) => {
      const state = slot.up === null ? "nodata" : slot.up ? "up" : "down";
      const timestamp = new Date(slot.checked_at).toISOString().slice(0, 16).replace("T", " ");
      const detail =
        slot.up === null
          ? "not monitored"
          : slot.http_code === null
            ? slot.up
              ? "operational"
              : "down or missing"
            : `${slot.up ? "up" : "down"}, HTTP ${slot.http_code}, ${slot.latency_ms} ms`;
      return `<span class="recent-dot ${state}" title="${escapeHtml(`${timestamp} UTC: ${detail}`)}"></span>`;
    })
    .join("");

  return `<div class="recent-dots" role="img" aria-label="${escapeHtml(
    `Five-minute availability for ${label} over the last ${RECENT_HOURS} hours, oldest to newest`,
  )}">${dots}</div>
  <div class="axis"><span>${RECENT_HOURS} hours ago</span><span>Now</span></div>`;
}

function endpointCard(
  label: string,
  url: string | null,
  pct: number | null,
  days: DayModel[],
  current: boolean | null,
  recent: RecentSlotModel[],
  sub?: string,
): string {
  const state = current === null ? "nodata" : current ? "up" : "down";
  const link = url
    ? ` <a class="ep-url" href="${escapeHtml(url)}">${escapeHtml(
        url.replace("https://", ""),
      )}</a>`
    : "";
  const subline = sub ? `<div class="ep-sub">${escapeHtml(sub)}</div>` : "";
  return `<section class="card">
  <div class="ep-head">
    <div><span class="ep-name">${escapeHtml(label)}</span>${link}${subline}</div>
    <div class="ep-stat">
      <span class="dot ${state}"></span><span class="ep-status">${STATUS_WORD[state]}</span>
      <span class="ep-pct">${formatPct(pct)}</span>
    </div>
  </div>
  ${barStrip(days, label)}
  <div class="axis"><span>${WINDOW_DAYS} days ago</span><span>Today</span></div>
  ${recentStrip(recent, label)}
</section>`;
}

const CSS = `
:root {
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e;
  --muted: #898781; --hairline: #e1e0d9; --ring: rgba(11,11,11,0.10);
  --up: #0ca30c; --partial: #ec835a; --down: #d03b3b; --nodata: #e1e0d9;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #0d0d0d; --surface: #1a1a19; --ink: #fff; --ink-2: #c3c2b7;
    --muted: #898781; --hairline: #2c2c2a; --ring: rgba(255,255,255,0.10);
    --nodata: #2c2c2a;
  }
}
* { box-sizing: border-box; margin: 0; }
body {
  background: var(--page); color: var(--ink);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  padding: 32px 16px 48px;
}
main { max-width: 720px; margin: 0 auto; display: grid; gap: 12px; }
h1 { font-size: 20px; font-weight: 650; }
.overall { display: flex; align-items: center; gap: 10px; margin: 4px 0 12px; flex-wrap: wrap; }
.overall .word { font-weight: 600; }
.overall .when { color: var(--muted); font-size: 13px; }
.card {
  background: var(--surface); border: 1px solid var(--ring);
  border-radius: 10px; padding: 16px;
}
.ep-head {
  display: flex; justify-content: space-between; align-items: baseline;
  gap: 12px; margin-bottom: 10px; flex-wrap: wrap;
}
.ep-name { font-weight: 600; }
.ep-url { color: var(--muted); font-size: 13px; text-decoration: none; margin-left: 6px; }
.ep-url:hover { text-decoration: underline; }
.ep-sub { color: var(--muted); font-size: 13px; }
.ep-stat { display: flex; align-items: baseline; gap: 8px; white-space: nowrap; }
.ep-status { color: var(--ink-2); font-size: 13px; }
.ep-pct { font-weight: 650; font-variant-numeric: tabular-nums; }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; align-self: center; }
.dot.up, .cell.up, .recent-dot.up { background: var(--up); }
.dot.partial, .cell.partial { background: var(--partial); }
.dot.down, .cell.down, .recent-dot.down { background: var(--down); }
.dot.nodata { background: var(--nodata); }
.cell.nodata { background: transparent; box-shadow: inset 0 0 0 1px var(--hairline); }
.bars { display: flex; gap: 2px; height: 26px; }
.cell { flex: 1; border-radius: 2px; min-width: 0; }
.recent-dots {
  display: flex; align-items: center; justify-content: space-between;
  width: 100%; height: 10px; margin-top: 14px;
}
.recent-dot {
  display: block; flex: 0 0 8px; width: 8px; height: 8px; border-radius: 50%;
}
.recent-dot.nodata {
  background: transparent; box-shadow: inset 0 0 0 1px var(--hairline);
}
@media (max-width: 420px) {
  .recent-dot { flex-basis: 5px; width: 5px; height: 5px; }
}
.axis { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; margin-top: 6px; }
.legend { display: flex; gap: 16px; flex-wrap: wrap; color: var(--ink-2); font-size: 13px; padding: 2px 4px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.chip { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.chip.up { background: var(--up); } .chip.partial { background: var(--partial); }
.chip.down { background: var(--down); }
.chip.nodata { background: transparent; box-shadow: inset 0 0 0 1px var(--muted); }
details { color: var(--ink-2); font-size: 13px; padding: 0 4px; overflow-x: auto; }
details summary { cursor: pointer; color: var(--muted); }
table { border-collapse: collapse; margin-top: 10px; width: 100%; }
th, td {
  text-align: right; padding: 3px 8px; font-variant-numeric: tabular-nums;
  border-bottom: 1px solid var(--hairline);
}
th:first-child, td:first-child { text-align: left; }
th { color: var(--muted); font-weight: 500; }
footer { color: var(--muted); font-size: 13px; padding: 4px; }
footer a { color: inherit; }
`;

export function renderHtml(status: StatusModel): string {
  const currentValues = status.endpoints.map((endpoint) => endpoint.current?.up ?? null);
  let headerState: "up" | "partial" | "down" | "nodata";
  let headerWord: string;
  if (currentValues.some((value) => value === null)) {
    headerState = "nodata";
    headerWord = "No complete check recorded yet";
  } else {
    const down = currentValues.filter((value) => value === false).length;
    headerState = down === 0 ? "up" : down === currentValues.length ? "down" : "partial";
    headerWord = down === 0 ? "All systems operational" : `${down} of ${currentValues.length} endpoints down`;
  }

  const latestTs = status.endpoints
    .map((endpoint) => endpoint.current?.checked_at)
    .filter((value): value is string => value !== undefined)
    .sort()
    .at(-1);
  const lastChecked = latestTs
    ? new Date(latestTs).toISOString().slice(0, 16).replace("T", " ") + " UTC"
    : "never";

  const cards = status.endpoints
    .map((endpoint) =>
      endpointCard(
        endpoint.label,
        endpoint.url,
        endpoint.uptime_30d_pct,
        endpoint.days,
        endpoint.current?.up ?? null,
        endpoint.recent_4h,
      ),
    )
    .join("");

  const headings = status.endpoints
    .map((endpoint) => `<th>${escapeHtml(endpoint.label)}</th>`)
    .join("");
  const rows = [...status.domain.days]
    .reverse()
    .map((day, reverseIndex) => {
      const index = status.domain.days.length - 1 - reverseIndex;
      const values = status.endpoints
        .map((endpoint) => `<td>${formatPct(endpoint.days[index]?.uptime_pct ?? null)}</td>`)
        .join("");
      return `<tr><td>${day.date}</td>${values}</tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>matteob.dev status</title>
<style>${CSS}</style>
<body>
<main>
  <h1>matteob.dev status</h1>
  <div class="overall">
    <span class="dot ${headerState}"></span>
    <span class="word">${escapeHtml(headerWord)}</span>
    <span class="when">Last checked ${escapeHtml(lastChecked)}</span>
  </div>
  ${cards}
  <div class="legend">
    <span><span class="chip up"></span>Operational (100%)</span>
    <span><span class="chip partial"></span>Degraded (&ge;95%)</span>
    <span><span class="chip down"></span>Down (&lt;95%)</span>
    <span><span class="chip nodata"></span>Not monitored</span>
  </div>
  <details><summary>Daily uptime table</summary>
    <table><tr><th>Day (UTC)</th>${headings}</tr>${rows}</table>
  </details>
  <footer>Checked every 5 minutes from Cloudflare. Uptime covers the past ${WINDOW_DAYS}
    days (UTC), and a missed check counts as downtime. Raw numbers:
    <a href="/status.json">status.json</a></footer>
</main>
</body>
</html>`;
}
