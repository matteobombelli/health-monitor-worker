import { describe, expect, it } from "vitest";
import {
  DOMAIN_ID,
  ENDPOINTS,
  buildStatusModel,
  renderHtml,
  type CurrentDatabaseRow,
  type DailyDatabaseRow,
} from "../src/status";

const now = new Date("2026-07-23T00:10:00Z");
const start = Date.parse("2026-07-23T00:00:00Z") / 1000;

function currentRows(): CurrentDatabaseRow[] {
  return ENDPOINTS.map((endpoint) => ({
    ...endpoint,
    up: 1,
    code: 200,
    ms: 42,
    ts: start + 300,
    first_ts: start,
  }));
}

describe("status model", () => {
  it("counts missing five-minute slots as downtime", () => {
    const rows: DailyDatabaseRow[] = [
      { day: "2026-07-23", id: DOMAIN_ID, slots_up: 1, checks_recorded: 1 },
      ...ENDPOINTS.map((endpoint) => ({
        day: "2026-07-23",
        id: endpoint.id,
        slots_up: 1,
        checks_recorded: 1,
      })),
    ];

    const status = buildStatusModel(rows, currentRows(), [], start, now);

    expect(status.domain.uptime_30d_pct).toBe(50);
    expect(status.domain.days.at(-1)).toMatchObject({
      slots_expected: 2,
      slots_up: 1,
      uptime_pct: 50,
    });
    expect(status.endpoints[0]?.uptime_30d_pct).toBe(50);
    expect(status.domain.up_now).toBe(true);
  });

  it("does not claim the domain is up until every endpoint has a current result", () => {
    const status = buildStatusModel([], currentRows().slice(1), [], start, now);
    expect(status.domain.up_now).toBeNull();
  });

  it("renders the human page and machine-data link", () => {
    const status = buildStatusModel([], currentRows(), [], start, now);
    const html = renderHtml(status);
    expect(status.endpoints.map((endpoint) => endpoint.url)).toEqual([
      "https://matteob.dev",
      "https://apps.matteob.dev",
      "https://apps.matteob.dev/projects/webtunes",
      "https://ssh.matteob.dev",
    ]);
    expect(status.endpoints.map((endpoint) => endpoint.label)).toEqual([
      "Portfolio",
      "Apps",
      "WebTunes",
      "ssh",
    ]);
    expect(status.endpoints.every((endpoint) => endpoint.recent_4h.length === 48)).toBe(
      true,
    );
    expect(html).toContain("All systems operational");
    expect(html).toContain('href="/status.json"');
    expect(html).toContain("Checked every 5 minutes from Cloudflare");
    expect(html).not.toContain("Last 6 hours");
    expect(html).not.toContain("matteob.dev (all endpoints)");
    expect(html.match(/class="recent-dots"/g)).toHaveLength(4);
    expect(html.match(/class="recent-dot (?:up|down|nodata)"/g)).toHaveLength(192);
    expect(html).not.toContain('class="recent-bars"');
    expect(html).not.toContain('class="recent-chart"');
    expect(html).not.toContain('class="recent-rail"');
  });
});
