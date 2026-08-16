# Deployment Readiness

## Current Status

The worker is suitable for supervised 2026/27 shadow observation. It is not
approved for unattended live mutations.

The repository now includes a Render Blueprint for a single paid background
worker with a persistent disk. Render cron jobs are not used because they cannot
mount persistent disks, and a background worker matches the continuous polling
loop. The Blueprint remains fail-closed in shadow mode.

The local safe posture is:

```dotenv
FPL_RUN_MODE=shadow
AUTO_EXECUTE_TRANSFERS=false
AUTO_SET_LINEUP=false
AUTO_PLAY_CHIPS=false
EMERGENCY_STOP=true
MAX_TRANSFERS_PER_WEEK=1
MAX_TRANSFER_HIT_COST=0
```

Run these checks from a clean build:

```bash
npm ci
npm run build
npm test
npm run preflight:shadow
npm run auto:once
node dist/scheduler/runner.js --once
```

For Render, create a Blueprint from `render.yaml`, enter every prompted secret,
and leave the service name and disk mount unchanged. The first deployment is an
observer deployment, not authorization for live mutations.

`preflight:live` must fail while the worker is intentionally in shadow mode:

```bash
npm run preflight:live
```

## Implemented Safety Boundary

- All mutation flags default to false; emergency stop defaults to true.
- `FPL_RUN_MODE=live` and `FPL_EXPECTED_MANAGER_ID` are required for mutation.
- Authentication fails when the token belongs to a different manager.
- LLM tools are analysis-only. Only the deployment worker can reach POST paths.
- Every mutation is bound to manager, season, gameweek, deadline, safety margin,
  and the exact pre-action team fingerprint.
- Transfers validate selling/purchase prices, positions, budget, uniqueness,
  club limits, transaction eligibility, and the final squad composition.
- Lineups validate exact squad membership, positions 1-15, legal formation,
  substitute goalkeeper, captain, and vice-captain.
- POST results are reread from `/my-team/`. Unknown outcomes quarantine future
  mutations and persist across restart.
- Runner and mutation file locks prevent duplicate local processes and requests.
- Graceful shutdown waits for the active cycle.
- Three consecutive failed cycles terminate the worker so Render can restart it.
- Render does not accept a custom shutdown delay for disk-backed services; keep
  each polling cycle short enough to complete within the platform default.
- Heuristic observations, forecasts, and calibration are season-scoped.
- Decisions and performance snapshots are scoped by season and manager; news
  signals are season-scoped.
- SQL.js holds a process-lifetime lock. Stop the worker before running another
  database-backed command against the same file.
- ML remains a separate shadow observer with no optimizer or execution path.

## Rollout Stages

1. Shadow only through GW1. Compare every proposed lineup, captain, transfer,
   and chip against a human decision before the deadline.
2. Require at least three consecutive gameweeks with timely cycles, no stale
   health status, no unresolved operations, and acceptable forecast error.
3. Consider a lineup-only canary for one gameweek. Keep transfers, hits, and
   chips disabled. Review the exact pending selection manually before enabling.
4. Consider one free-transfer canary only after lineup canaries and after the
   transfer proposal clears confidence and net-gain gates. Keep hit cost at zero.
5. Do not enable automatic chips until a full window-aware chip schedule,
   Wildcard/Free Hit squad optimization, and live canary procedure exist.

Never enable multiple new mutation classes in the same gameweek.

## Remaining Blockers

- Current historical replay data is reconstructed, not strict deadline data.
- The expanded identity-independent model trains on 2022/23 and 2023/24, but
  its reconstructed 2025/26 diagnostic won 27 of 38 gameweeks (71.1%), below
  the proposed 90% promotion gate; it remains shadow-only.
- News collection needs explicit source-freshness/degraded-state reporting.
- Alert delivery needs a production canary and dead-man monitoring.
- SQL.js persistence requires the configured single Render worker and persistent
  disk; replicas remain unsupported.
- Wildcard and Free Hit execution are intentionally unavailable.
- Automatic chip scheduling across both half-season windows is incomplete.
- A live FPL mutation canary has not been performed with the new operation
  journal and post-state reconciliation.
- Current GW1 transfer and lineup proposals do not clear configured confidence
  gates; `npm run preflight` reports their current values.

## Incident Procedure

1. Create `data/EMERGENCY_STOP` immediately.
2. Inspect `npm run health`, logs, and `npm run preflight`.
3. Inspect the authoritative FPL website before touching an `unknown` operation.
4. Stop the worker so it releases the SQL.js database lock.
5. Resolve an operation only with `mutations:resolve` and written verification
   notes.
6. Keep the worker in shadow mode for at least the next complete cycle.

## Supervision

`deploy/fpl-agent-shadow.service` is a shadow-worker systemd template. Review
paths and environment values before installing it. It deliberately runs the
compiled worker, uses one replica, restarts on failure, and allows writes only
to `data/`.
