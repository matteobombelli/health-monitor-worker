import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { storeResults } from "../src/index";
import { DOMAIN_ID, ENDPOINTS } from "../src/status";

const DAY_START = Date.parse("2026-09-01T00:00:00Z") / 1000;

describe("storeResults", () => {
  it("reconciles only the run's UTC day", async () => {
    const previous = DAY_START - 300;
    await env.DB.batch(
      ENDPOINTS.map((endpoint) =>
        env.DB.prepare(
          `INSERT INTO checks (run, ts, id, label, url, up, code, ms)
           VALUES (?1, ?1, ?2, ?3, ?4, 1, 200, 10)`,
        ).bind(previous, endpoint.id, endpoint.label, endpoint.url),
      ),
    );
    await storeResults(env.DB, previous, []);

    await storeResults(
      env.DB,
      DAY_START,
      ENDPOINTS.map((endpoint) => ({
        id: endpoint.id,
        label: endpoint.label,
        url: endpoint.url,
        up: endpoint.id !== "ssh",
        code: 200,
        ms: 10,
      })),
    );

    const { results } = await env.DB.prepare(
      "SELECT day, id, slots_up, checks_recorded FROM daily ORDER BY day, id",
    ).all<{ day: string; id: string; slots_up: number; checks_recorded: number }>();

    const today = results.filter((row) => row.day === "2026-09-01");
    const yesterday = results.filter((row) => row.day === "2026-08-31");
    expect(results).toHaveLength(today.length + yesterday.length);

    expect(yesterday).toEqual(
      expect.arrayContaining([
        { day: "2026-08-31", id: DOMAIN_ID, slots_up: 1, checks_recorded: 1 },
        ...ENDPOINTS.map((endpoint) => ({
          day: "2026-08-31",
          id: endpoint.id,
          slots_up: 1,
          checks_recorded: 1,
        })),
      ]),
    );
    expect(yesterday).toHaveLength(ENDPOINTS.length + 1);

    expect(today).toEqual(
      expect.arrayContaining([
        { day: "2026-09-01", id: DOMAIN_ID, slots_up: 0, checks_recorded: 1 },
        ...ENDPOINTS.map((endpoint) => ({
          day: "2026-09-01",
          id: endpoint.id,
          slots_up: endpoint.id === "ssh" ? 0 : 1,
          checks_recorded: 1,
        })),
      ]),
    );
    expect(today).toHaveLength(ENDPOINTS.length + 1);
  });
});
