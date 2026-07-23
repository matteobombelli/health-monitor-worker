# Cloudflare health monitor

This Worker hosts `https://status.matteob.dev` independently of the home
server. A Cron Trigger checks the public endpoints every five minutes, D1
stores 30 days of results, and the Worker serves both the status page and
`/status.json`. Each service card includes a 30-day daily strip and a four-hour
strip at five-minute resolution.

The monitored endpoints are:

- `https://matteob.dev`
- `https://apps.matteob.dev` (its intentional 404 response is healthy)
- `https://apps.matteob.dev/projects/webtunes`
- `https://ssh.matteob.dev`

The SSH hostname check confirms that the Cloudflare Access login front door is
available. It cannot prove that the protected SSH daemon is accepting a
session without adding Access service credentials.

The production route intentionally uses the existing proxied
`status.matteob.dev` DNS record. Worker routes run before the Tunnel origin, so
the status page remains available when the home server or Tunnel is down. A
future DNS cleanup can replace the route with a Worker Custom Domain.

## Test locally

```bash
npm ci
npm run db:migrate:local
npm run check
npm run dev
```

With the dev server running, invoke the scheduled handler:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
curl "http://localhost:8787/status.json"
```

## Deploy an update

The Worker and D1 database are provisioned. Test and deploy updates with:

```bash
npm ci
npm run check
npm run db:migrate:remote
npm run deploy
curl -fsS https://status.matteob.dev/status.json
```

The initial deployment imported the local JSONL history on 2026-07-23. The
import and rebuild tools remain available for disaster recovery:

```bash
node scripts/import-history.mjs < ../data/checks.jsonl > /tmp/health-history.sql
npx wrangler d1 execute matteob-health-monitor --remote --file /tmp/health-history.sql
npx wrangler d1 execute matteob-health-monitor --remote --file scripts/rebuild.sql
```

The old local monitor is a rollback snapshot. Disable its timer after a
verified Cloudflare Cron run:

```bash
sudo systemctl disable --now health-monitor.timer
```
