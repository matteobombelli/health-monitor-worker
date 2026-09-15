import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { storeResults } from "../src/index";
import { DOMAIN_ID, ENDPOINTS } from "../src/status";

const DAY_START = Date.parse("2026-09-01T00:00:00Z") / 1000;

interface DailyRow {
  day: string;
  id: string;
  slots_up: number;
  checks_recorded: number;
}

function results(down: string[] = []) {
  return ENDPOINTS.map((endpoint) => ({
    id: endpoint.id,
    label: endpoint.label,
    url: endpoint.url,
    up: !down.includes(endpoint.id),
    code: 200,
    ms: 10,
  }));
}

async function daily(): Promise<DailyRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT day, id, slots_up, checks_recorded FROM daily ORDER BY day, id",
  ).all<DailyRow>();
  return results;
}

function expectDay(day: string, slotsUp: Record<string, number>, checks: number): DailyRow[] {
  return [DOMAIN_ID, ...ENDPOINTS.map((endpoint) => endpoint.id)].map((id) => ({
    day,
    id,
    slots_up: slotsUp[id] ?? checks,
    checks_recorded: checks,
  }));
}

describe("storeResults", () => {
  beforeEach(async () => {
    await env.DB.batch(
      ["checks", "daily", "current_status", "metadata"].map((table) =>
        env.DB.prepare(`DELETE FROM ${table}`),
      ),
    );
  });

  it("accumulates daily slots per run and treats the domain as up only when every endpoint is up", async () => {
    await storeResults(env.DB, DAY_START - 300, results());
    await storeResults(env.DB, DAY_START, results());
    await storeResults(env.DB, DAY_START + 300, results(["ssh"]));

    const rows = await daily();
    expect(rows).toHaveLength(2 * (ENDPOINTS.length + 1));
    expect(rows).toEqual(
      expect.arrayContaining([
        ...expectDay("2026-08-31", {}, 1),
        ...expectDay("2026-09-01", { ssh: 1, [DOMAIN_ID]: 1 }, 2),
      ]),
    );
  });

  it("ignores a duplicate delivery of the same run", async () => {
    await storeResults(env.DB, DAY_START, results());
    await storeResults(env.DB, DAY_START, results(["home"]));

    expect(await daily()).toEqual(expect.arrayContaining(expectDay("2026-09-01", {}, 1)));
    const { results: checks } = await env.DB.prepare(
      "SELECT up FROM checks WHERE run = ?1 AND id = 'home'",
    )
      .bind(DAY_START)
      .all<{ up: number }>();
    expect(checks).toEqual([{ up: 1 }]);
  });

  it("drops checks older than the retention window", async () => {
    const old = DAY_START - 40 * 86_400;
    await storeResults(env.DB, old, results());
    await storeResults(env.DB, DAY_START, results());

    const { results: remaining } = await env.DB.prepare(
      "SELECT DISTINCT run FROM checks ORDER BY run",
    ).all<{ run: number }>();
    expect(remaining).toEqual([{ run: DAY_START }]);
  });
});
