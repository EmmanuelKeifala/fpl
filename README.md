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
   - `FPL_EMAIL`: Your FPL login email
   - `FPL_PASSWORD`: Your FPL password
   - `FPL_MANAGER_ID`: Your manager ID (from team URL)

3. Install dependencies:
   ```bash
   npm install
   ```

4. Run the agent:
   ```bash
    npm run dev
    ```

## Autonomous Mode

Run the deadline-aware worker with:

```bash
npm run auto
```

The worker automatically optimizes the legal starting XI, bench order, captain, and vice-captain. Set `AUTO_EXECUTE_TRANSFERS=true` to permit single or multi-transfer execution and `AUTO_PLAY_CHIPS=true` to permit high-confidence Bench Boost and Triple Captain activation. `EMERGENCY_STOP=true` immediately blocks mutations.

Autonomous mode also stores point-in-time player and fixture changes, takes periodic pre-deadline forecast snapshots, and reconciles predictions with actual points after each finished gameweek.

Official availability updates and timestamped trusted news are resolved to players and applied to expected minutes before transfers, lineup, and captaincy are optimized. Inside the final 90 minutes, news polling increases to every five minutes by default. Undated website items are treated as low confidence, and post-deadline items are rejected.

## Usage

Ask the agent questions like:
- "Show me my team"
- "How is Salah performing?"
- "Should I take a hit for Haaland?"
- "What are the trending transfers?"
- "When should I use my bench boost?"

## FPL Rules (2025/26)

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

Reconstructed fixtures come from the final season schedule, so these reports cannot verify top-10k performance. `--data-mode=strict` intentionally fails until point-in-time fixture snapshots are available. Use `--data-mode=legacy` only for diagnostic comparison with older reports.
