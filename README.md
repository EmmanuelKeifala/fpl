# FPL Agent

AI-powered Fantasy Premier League assistant with game theory optimization.

## Features

- **Team Analysis**: View your squad with expected points projections
- **Player Stats**: Detailed player data with form and fixtures
- **Transfer Optimization**: Smart recommendations using hit ROI analysis
- **Chip Timing**: Optimal chip usage based on fixture analysis
- **Performance Tracking**: SQLite database tracks all decisions

## Setup

1. Copy environment file:
   ```bash
   cp .env.example .env
   ```

2. Add your credentials to `.env`:
   - `OPENAI_API_KEY`: Your OpenAI API key
   - `FPL_EMAIL`: Your Premier League account email
   - `FPL_PASSWORD`: Your Premier League account password
   - `FPL_MANAGER_ID`: Optional manager ID for read-only use

### FPL Session

The agent signs in through the current `account.premierleague.com` OAuth flow and stores
the refreshable session in the gitignored `data/fpl-session.json` file. It validates the
session against `/api/me/` at startup and derives the current season's manager ID from the
account. `FPL_BEARER_TOKEN` can be used instead, but it must be the token stored by the
Fantasy site rather than the general Premier League website.

Without valid authentication the agent still runs in read-only mode, monitoring news,
prices, and deadlines.

3. Install dependencies:
   ```bash
   npm install
   ```

4. Run the agent:
   ```bash
    npm run dev
    ```

## Autonomous Worker

The worker is fail-closed. A fresh setup is a shadow observer with every
mutation disabled and the emergency stop active. Verify the current public and
authenticated state first:

```bash
npm run preflight
npm run auto:once
npm run auto
```

Do not set `FPL_RUN_MODE=live` merely to test the worker. Live mode requires an
explicit expected manager ID, a remote alert channel, the relevant per-action
flag, a clear emergency stop, an authoritative deadline outside the safety
margin, an unchanged team fingerprint, a single process/mutation lock, and
confidence/gain gates. Every POST is persisted before execution and reconciled
against `/my-team/`; an ambiguous outcome quarantines subsequent actions.

Create `data/EMERGENCY_STOP` to stop mutations in a running process without
restarting it. `EMERGENCY_STOP=true` remains the startup-level stop. LLM tools
are analysis-only and cannot execute transfers, captaincy, lineups, or chips.

After a lost response, inspect the authoritative FPL team before resolving the
operation:

```bash
npm run mutations:resolve -- --id=<id> --status=confirmed --message="verified in FPL" --ack=I_VERIFIED_FPL_STATE
```

`npm run health` reads the durable worker heartbeat. See
`docs/deployment-readiness.md` before enabling any live action.

### Render deployment

`render.yaml` provisions one Node background worker with a 1 GB persistent disk
mounted at `data/`. The Blueprint deliberately deploys in shadow mode with the
emergency stop active. During the initial Blueprint setup, Render prompts for
the FPL credentials, manager ID, OpenAI key, and Discord webhook without storing
those secrets in Git.

Render must keep the worker at one instance because SQL.js and the mutation
journal are single-writer. The worker exits after three consecutive failed
cycles so Render can restart it. Automatic deploys wait for repository checks to
pass. The worker handles `SIGTERM` gracefully, but Render does not permit a
custom shutdown delay on disk-backed services, so deploys use Render's default
shutdown window.

After the first deploy, inspect the worker logs and persistent heartbeat for at
least three complete gameweeks before considering the staged live canaries in
`docs/deployment-readiness.md`.

Autonomous mode also stores point-in-time player and fixture changes, takes periodic pre-deadline forecast snapshots, and reconciles predictions with actual points after each finished gameweek.

Official availability updates and timestamped trusted news are resolved to players and applied to expected minutes before transfers, lineup, and captaincy are optimized. Inside the final 90 minutes, news polling increases to every five minutes by default. Undated website items are treated as low confidence, and post-deadline items are rejected.

## Usage

Ask the agent questions like:
- "Show me my team"
- "How is Salah performing?"
- "Should I take a hit for Haaland?"
- "What are the trending transfers?"
- "When should I use my bench boost?"

## Season Rules

Live season rules are read from the game's own `bootstrap-static` payload rather than
hardcoded: budget, squad and club limits, transfer cap, saved free transfer cap, and the
per-chip windows. The runner prints the derived configuration at startup and warns when a
value drifts from the static assumptions in `src/strategy/rules.ts`.

For 2026/27 the game publishes wildcard GW2-19 and GW20-38, free hit GW2-19 and GW20-38,
and bench boost / triple captain GW1-19 and GW20-38 — so no wildcard or free hit is legal
in GW1. In-season free transfer grants are not published in bootstrap; set
`FPL_TRANSFER_TOP_UPS="16:5"` if the game announces one.

## FPL Rules (2026/27)

- Squad: 15 players, 2 GKP / 5 DEF / 5 MID / 3 FWD
- Starting XI: 1 GKP, at least 3 DEF, at least 2 MID, at least 1 FWD
- Save up to 5 free transfers
- -4 points per transfer beyond available free transfers
- Max 20 transfers in a GW unless using Wildcard or Free Hit
- Chips are split around the GW19 deadline: 2 Bench Boosts, 2 Triple Captains, 2 Free Hits, 2 Wildcards
- Only one chip can be played per GW
- Defensive contribution points are included in projections
- Price selling keeps half of profit rounded down to £0.1m

## Historical Replays

Use reconstructed mode for lagged-feature experiments. It excludes same-gameweek Vaastav xP and isolates corrected caches from legacy reports:

```bash
npm run backtest:prepare -- --season=2025-2026 --data-mode=reconstructed
npm run backtest:run -- --strategy=autonomous --season=2025-2026 --data-mode=reconstructed
```

Use the full deployment-shadow profile to exercise six-gameweek transfer planning,
lineup and bench selection, captaincy, chips, hits, saved transfers, and the final
pre-deadline execution decision for every gameweek:

```bash
npm run backtest:full -- --season=2025-2026 --data-mode=reconstructed
```

The deployment replay is local-only and cannot call authenticated FPL endpoints. Its
report records the execution profile and every weekly decision. Reconstructed historical
data has no trustworthy timestamped injury/news archive or intraweek polling snapshots,
so those live behaviors are disclosed as unavailable rather than simulated with hindsight.

Reconstructed fixtures come from the final season schedule, so these reports cannot verify top-10k performance. `--data-mode=strict` intentionally fails until point-in-time fixture snapshots are available. Use `--data-mode=legacy` only for diagnostic comparison with older reports.

## Identity-Independent ML

The local player-fixture model fits reusable schedule, position, team, and
rolling-performance patterns without fitting player, club, opponent, or fixture
identity. Training uses 2022/23 and 2023/24, blend and deployment-policy selection use
2024/25, and 2025/26 is a diagnostic out-of-season replay.

```bash
python3 -m venv .venv-ml
. .venv-ml/bin/activate
python -m pip install -r requirements-ml.txt
python scripts/ml/pipeline.py all --overwrite
npm run ml:calibrate-policy
npm run backtest:ml
```

The portable model is emitted at
`artifacts/ml/player-fixture-v1/model.json`; historical datasets and replay
prediction CSVs remain local generated inputs under `data/`.

For live observation, generate a public-data feature sidecar with
`npm run ml:live-features`, set `FPL_ML_SHADOW_ENABLED=true` and point
`FPL_ML_FEATURE_SIDECAR` at the printed file. ML remains a separate shadow
observer: it does not alter optimizer projections, transfer plans, lineups,
captaincy, chips, or authenticated API payloads. See `scripts/ml/README.md`
for the feature contract, artifacts, validation results, and weekly workflow.
