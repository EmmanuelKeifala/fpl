# Local Docker deployment

This deployment runs the autonomous worker continuously on the local machine.
It does not expose a port and does not require a database service: the worker is
the only process and persists its SQL.js database, FPL session, ML sidecars,
health heartbeat, and locks under the host `data/` directory.

## Safe first start

Docker Compose loads credentials and manager settings from the existing
gitignored `.env`. The local profile deliberately overrides all mutation flags,
keeps the emergency stop active, and requires shadow mode. It otherwise mirrors
the Render worker: the local ML observer, OpenAI reviewer, and Kapso WhatsApp
updates are enabled with the same model, thresholds, timeouts, and retry limits.

```bash
mkdir -p data
touch data/EMERGENCY_STOP
docker --context default compose build
docker --context default compose up -d
docker --context default compose ps
docker --context default compose logs --tail=200 worker
```

The first build downloads the Node base image and Debian packages. Subsequent
starts use the local image. Compose restarts the worker after process failure
and after a host reboot when Docker starts.

GW1 or another period that the official API explicitly marks `unlimited` uses
an atomic full-squad target capped by `MAX_UNLIMITED_TRANSFERS`. Rank-aware
protect, balanced, and push modes use ownership only after quality and
availability gates; low ownership is never rewarded by itself. The
`TEMPLATE_CORE_OWNERSHIP_THRESHOLD`, `MIN_TEMPLATE_CORE_PLAYERS`, and
`TEMPLATE_ANCHOR_OWNERSHIP_THRESHOLD` settings apply in protect mode and the
early-season balanced fallback; push mode remains unconstrained by that floor.
Preseason rebuilds use a three-gameweek horizon, Wildcard uses the permanent
horizon, and Free Hit uses one week.

Inside 90 minutes of the deadline the worker polls every minute, finalizes at
approximately T-5, and refuses mutation at or inside T-3. It holds when the
verified news feed is stale or contradictory. A transfer may go early only
after the same plan appears in consecutive cycles and a high-confidence
official price signal has material affordability or effective-value impact;
heuristic transfer-volume estimates remain observational.

Check the durable heartbeat after the first cycle:

```bash
docker --context default compose exec worker node dist/scheduler/health-check.js
```

## Operations

Follow logs:

```bash
docker --context default compose logs -f --tail=100 worker
```

Rebuild after a source update:

```bash
docker --context default compose build
docker --context default compose up -d
```

Stop without deleting persistent data:

```bash
docker --context default compose down
```

The `data/` directory is a bind mount, so `docker compose down` and image
rebuilds do not remove the database or session. Do not scale `worker` above one
replica and do not run a host worker against the same `data/` directory while
the container is running; SQL.js is intentionally single-writer.

Before host maintenance, use `docker compose stop` and allow the configured
90-second grace period. A normal stop releases the runner and database locks.

## External services

Local compute removes the Render hosting bill, but the OpenAI and Kapso features
still call their external APIs and may have their own usage charges. Supply the
same `OPENAI_API_KEY`, `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`,
`KAPSO_WHATSAPP_TO`, and `KAPSO_WHATSAPP_TEMPLATE_NAME` values that the Render
Blueprint prompts for. This deployment does not replace those providers with
local substitutes.

## Backups

Stop the worker before copying `data/` so the SQL.js database and journal are a
consistent snapshot:

```bash
docker --context default compose stop worker
tar -czf "fpl-agent-data-$(date +%Y%m%d-%H%M%S).tar.gz" data
docker --context default compose start worker
```

Store any backup containing `fpl-session.json` securely because it contains a
refreshable authenticated session.
