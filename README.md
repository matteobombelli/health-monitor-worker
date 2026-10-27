# Cloudflare health monitor

This Worker hosts `https://status.matteob.dev` independently of the home
server. A Cron Trigger checks the public endpoints every five minutes, D1
stores 30 days of results, and the Worker serves both the status page and
`/status.json`. Each service card includes a 30-day daily strip and a four-hour
strip at five-minute resolution.

The monitored endpoints are:

- `https://matteob.dev`
- `https://apps.matteob.dev` (its intentional 404 response is healthy)
- `https://webtunes.matteob.dev`
- `https://todo.matteob.dev`
- `https://vocab.matteob.dev`
- `https://savethedate.matteob.dev`
- `https://ssh.matteob.dev`

The SSH check authenticates to Cloudflare Access, opens the Tunnel's WebSocket
carrier, and requires an SSH protocol identification such as `SSH-2.0-OpenSSH`.
A connected Tunnel or a working Access login page is therefore not enough to
mark SSH as healthy.

The Worker owns `status.matteob.dev` as a Custom Domain, so the status page
has no dependency on the home server or the Tunnel. `wrangler deploy` creates
the DNS record and certificate; the hostname must not already have a DNS
record (the old Tunnel public hostname was removed before the first deploy).

## Deploy from a clean clone

This runbook assumes you are deploying to the existing `matteob.dev` Cloudflare
account. That account already has:

- the `matteob-health-monitor` D1 database referenced by `wrangler.jsonc`;
- a Tunnel published application for `ssh.matteob.dev` that routes to the SSH
  service; and
- a self-hosted Cloudflare Access application covering `ssh.matteob.dev`.

For a different account or domain, create equivalent resources and replace the
account-specific database ID, Custom Domain, hostnames, and endpoint URLs in this
repository before continuing.

### 1. Install prerequisites and clone

Install Git plus a Cloudflare-supported Node.js release with npm. Cloudflare
recommends using a Node version manager and installing Wrangler locally in the
project; `npm ci` below installs the version locked by this repository.

```bash
git clone https://github.com/matteobombelli/health-monitor-worker.git
cd health-monitor-worker
npm ci
npx wrangler --version
```

### 2. Authenticate Wrangler

Check which Cloudflare account Wrangler is using:

```bash
npx wrangler whoami
```

If it is not authenticated to the account that owns `matteob.dev`, run:

```bash
npx wrangler login
npx wrangler whoami
```

Do not continue until the expected account appears.

### 3. Create the SSH monitor service token

The Worker needs a dedicated
[Cloudflare Access service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
to get through Access without an interactive browser login.

1. Open the Cloudflare dashboard and go to **Zero Trust > Access controls >
   Service credentials > Service Tokens**.
2. Select **Create Service Token**.
3. Name it `matteob-health-monitor-ssh`.
4. Choose an appropriate lifetime and set an expiration reminder.
5. Select **Generate token**.
6. Keep this page open. Cloudflare shows the Client Secret only once. Do not
   paste either credential into chat, source code, `wrangler.jsonc`, or a
   committed file.

The token is only an Access front-door credential. It does not contain an SSH
username, SSH key, or Cloudflare API permission.

### 4. Authorize only that token for SSH

Create a dedicated reusable Access policy:

1. In Zero Trust, go to **Access controls > Policies** and select
   **Add a policy**.
2. Use the name `SSH health monitor`.
3. Set **Action** to **Service Auth**.
4. Add exactly this rule:

   | Rule type | Selector | Value |
   | --- | --- | --- |
   | Include | Service Token | `matteob-health-monitor-ssh` |

5. Save the policy.
6. Go to **Access controls > Applications**, configure the existing application
   covering `ssh.matteob.dev`, open **Policies**, and attach the new
   `SSH health monitor` policy.
7. Keep the existing human `Allow` policies unchanged.

Select the specific token, not **Any Access Service Token**, and do not use a
**Bypass** policy.

### 5. Add both credentials to the Worker

The safest first-time setup is to add both values together in the dashboard:

1. In a second browser tab, go to **Workers & Pages >
   matteob-health-monitor > Settings > Variables and Secrets**.
2. Select **Add** and create these two entries with type **Secret**:

   | Variable name | Value from the token page |
   | --- | --- |
   | `SSH_ACCESS_CLIENT_ID` | Client ID |
   | `SSH_ACCESS_CLIENT_SECRET` | Client Secret |

3. Select **Deploy** to save both secrets.
4. Close the token page after confirming both values were accepted.

Verify from the clone that the two names exist. This command never displays
their values:

```bash
npx wrangler secret list
```

The output must contain both `SSH_ACCESS_CLIENT_ID` and
`SSH_ACCESS_CLIENT_SECRET`. The names are declared as required in
`wrangler.jsonc`, so a code deployment fails closed if either is missing.

### 6. Test, migrate, and deploy

Run the complete check suite and validate the deployment bundle:

```bash
npm run check
npm run deploy:dry
```

Apply any unapplied D1 migrations to the remote production database. Review the
target database shown by Wrangler before confirming:

```bash
npm run db:migrate:remote
```

Deploy the Worker, its Custom Domain, and the five-minute Cron Trigger:

```bash
npm run deploy
```

### 7. Verify the running deployment

The status page should respond immediately:

```bash
curl -fsS https://status.matteob.dev/status.json
```

The SSH result is updated by the next five-minute Cron run. To watch the
scheduled invocation, start a live log tail and leave it open until a
`health checks complete` event appears:

```bash
npx wrangler tail --format pretty
```

Then inspect the SSH result:

```bash
curl -fsS https://status.matteob.dev/status.json |
  jq '.endpoints[] | select(.id == "ssh") | .current'
```

If `jq` is not installed, open `https://status.matteob.dev/status.json` in a
browser and locate the endpoint whose `id` is `ssh`. A healthy SSH daemon has
`"up": true`; a live Tunnel with an unavailable SSH daemon has `"up": false`.

## Local development

Create the local D1 schema and start Wrangler's development server:

```bash
npm run db:migrate:local
npm run dev
```

With the server running, invoke the scheduled handler and view its stored
result:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?format=json"
curl "http://localhost:8787/status.json"
```

To exercise the real SSH probe locally, create a gitignored `.dev.vars` file
containing `SSH_ACCESS_CLIENT_ID` and `SSH_ACCESS_CLIENT_SECRET`. Never commit
that file.

## Deploy later updates

The Access policy and Worker secrets persist across normal code deployments.
For subsequent updates:

```bash
git pull --ff-only
npm ci
npm run check
npm run deploy:dry
npm run db:migrate:remote
npm run deploy
curl -fsS https://status.matteob.dev/status.json
```

## Rotate or revoke the SSH monitor token

To rotate it without interrupting monitoring:

1. Create a new dedicated service token.
2. Add the new token to the `SSH health monitor` Service Auth policy.
3. Replace both Worker secret values together under **Variables and Secrets**.
4. Wait for a successful scheduled SSH check.
5. Remove and delete the old service token.

Deleting a service token revokes its Access permission. Merely revoking an
Access session does not invalidate the Client ID and Client Secret.

## Roll back a deployment

List recent Worker versions and roll back to a known-good version:

```bash
npx wrangler versions list
npx wrangler rollback
```

Rollback does not alter the D1 monitoring history. Afterward, verify the two
Worker secret names and wait for a successful scheduled SSH check.

## Disaster recovery

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
