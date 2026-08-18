# FPL Agent

AI-powered Fantasy Premier League assistant with game theory optimization.

## Features

- **Team Analysis**: View your squad with expected points projections
- **Player Stats**: Detailed player data with form and fixtures
- **Transfer Optimization**: Smart recommendations using hit ROI analysis
- **Chip Timing**: Optimal chip usage based on fixture analysis
- **Performance Tracking**: SQLite database tracks all decisions
- **Constrained LLM Review**: Structured risk review of deterministic legal plans
- **Autonomous Learning**: Forecast reconciliation and rolling bias/profile calibration
- **Kapso WhatsApp Updates**: Ordered plan and before/after action observability

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
   - `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, and `KAPSO_WHATSAPP_TO`:
     Kapso/WhatsApp delivery credentials and the international recipient number

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
restarting it. `EMERGENCY_STOP=true` remains the startup-level stop. The live
LLM reviewer has no tools or FPL API access: it can approve the supplied
deterministic option or hold, but cannot invent or execute transfers,
captaincy, lineups, or chips. Live mode can require a sufficiently confident
structured LLM approval in addition to every deterministic safety gate.

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
the FPL credentials, manager ID, OpenAI key, Kapso credentials, WhatsApp
recipient, approved template name, and optional Discord webhook without storing
those secrets in Git.

On Render, the ML observer automatically generates the correct next-gameweek
feature sidecar from public FPL data, validates it against the current fixture
schedule and model schema, and caches it on the persistent disk. The LLM layer
uses structured output, a 30-second timeout, a persistent decision cache, and a
75% approval threshold. Missing or invalid ML/LLM output is recorded and cannot
authorize a mutation.

Kapso sends an approved WhatsApp utility template for proactive plan and action
updates. The delivery queue is serialized so `before` is submitted ahead of
`after`, but neither send is awaited before an FPL request. A timeout, invalid
credential, provider outage, or rejected WhatsApp message is logged and retried
when transient; it never approves, blocks, cancels, retries, or changes an FPL
action. Plan payloads are deduplicated within the worker process.

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

For autonomous live observation, enable `FPL_ML_SHADOW_ENABLED=true` and
`FPL_ML_AUTO_FEATURES=true`. The worker generates one validated, immutable
sidecar per actionable gameweek and refreshes it if the public fixture schedule
changes. `npm run ml:live-features` plus `FPL_ML_FEATURE_SIDECAR` remains the
manual/offline alternative. ML remains a separate shadow observer: it does not
alter optimizer projections, transfer plans, lineups, captaincy, chips, or
authenticated API payloads. See `scripts/ml/README.md` for the feature contract
and validation results.

## LLM Decision Layer

The autonomous worker sends only compact proposal data—never FPL credentials or
session tokens—to a tool-free OpenAI reviewer. Zod structured output restricts
the response to `approve` or `hold`, a supplied option ID, bounded confidence,
risk, reasoning, and a fixed concern list. Code then verifies the option ID and
minimum confidence again. Cached responses are keyed by the complete proposal,
model, and threshold, so changed news, fixtures, or plans trigger a new review.

```dotenv
FPL_LLM_ENABLED=true
FPL_LLM_REQUIRED_FOR_LIVE=true
FPL_LLM_MODEL=gpt-5.4-nano
FPL_LLM_MIN_CONFIDENCE=0.75
```

An LLM outage never becomes an implicit approval. When review is required, a
timeout, refusal, malformed response, unknown option, low confidence, or hold
verdict blocks the mutation while the worker continues monitoring.

After configuring the OpenAI key, verify API connectivity and structured output
without touching FPL:

```bash
npm run llm:smoke
```

## Kapso WhatsApp Observability

Create and obtain approval for a WhatsApp utility template named
`fpl_agent_update` with body text `FPL agent update:\n{{update}}`. Configure
`update` as the single named body parameter, then set the Render secrets:

```dotenv
KAPSO_WHATSAPP_ENABLED=true
KAPSO_API_KEY=<secret>
KAPSO_PHONE_NUMBER_ID=<sender-phone-number-id>
KAPSO_WHATSAPP_TO=<international-number-with-country-code>
KAPSO_WHATSAPP_MODE=template
KAPSO_WHATSAPP_TEMPLATE_NAME=fpl_agent_update
KAPSO_WHATSAPP_LANGUAGE=en_US
KAPSO_WHATSAPP_TEMPLATE_PARAMETER_NAME=update
```

The recipient is intentionally a secret rather than a value committed to the
repository. After the approved template and secrets are configured, test only
the notification path—without calling FPL—with:

```bash
npm run kapso:smoke
```

The runner sends a deduplicated gameweek plan and ordered `before`/`after`
updates for transfer, lineup, captaincy/chip, and completed-gameweek outcomes.
WhatsApp is strictly informational and has no code path into optimization,
validation, LLM review, or authenticated FPL mutations.
