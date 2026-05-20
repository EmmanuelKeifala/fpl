# Competitive Backtest Strategies Design

## Goal

Make the 2024/25 backtest useful for strategy improvement instead of only replay plumbing. The system should run a strict point-in-time `fair` strategy and a separate hindsight `oracle` comparator, both able to use legal transfers and existing chips. The current `1634`-point deterministic baseline remains available as a control.

## Context

The current backtest can prepare Vaastav 2024/25 snapshots and replay GW1-GW38. It produces `1634` points with `0` transfers and `0` chips because `deterministicStrategy` intentionally returns an empty transfer list and no `chip`. Public 2024/25 benchmarks show the winning score was about `2810`, with top-10 scores around `2754`, so `1634` is not competitive.

This phase targets existing supported chips only:

- Wildcard
- Free Hit
- Bench Boost
- Triple Captain

Assistant Manager is intentionally deferred because it requires new chip types, source mapping, manager scoring, and 2024/25-specific rules.

## Strategy Modes

### Baseline

The current deterministic strategy remains available for regression comparison. It builds a GW1 squad, picks legal lineups, makes no transfers, and plays no chips.

### Fair

The `fair` strategy must use only information available through `DecisionSnapshotInput` and prior `ManagerState`. It must not inspect `actualResults` or future snapshots.

Fair mode should:

- Build a legal GW1 squad under budget and club limits.
- Select legal starting XI, bench, captain, and vice captain by expected points.
- Evaluate legal weekly transfers using current expected points, fixture difficulty, squad value, bank, free transfers, hit costs, and replacement value.
- Allow no-transfer weeks when transfers are not projected to help.
- Allow hits only when projected gain clears a configurable threshold, initially `4.5` points.
- Use Wildcard when a rebuilt squad has materially higher projected value than the current squad, with preference for early-season and late-season fixture-turn windows.
- Use Free Hit when current squad coverage is unusually poor or a gameweek has blank/double-gameweek characteristics inferred from fixture counts.
- Use Triple Captain on the best high-projection captain week, especially double gameweeks.
- Use Bench Boost when bench expected points are unusually high.

The initial success target for fair mode is to beat the `1634` baseline substantially and to use transfers and chips meaningfully. A `2500+` target is aspirational for later iterations; this strict fair version should not add future leakage to chase it.

### Oracle

The `oracle` strategy is a hindsight comparator, not a fair agent. It may inspect current and future `actualResults` and future snapshots to estimate the legal upper bound available to the engine.

Oracle mode should:

- Build a GW1 squad using realized season value.
- Plan transfers and chips using actual outcomes while still passing through the normal `applyGameweekDecision` legality and scoring rules.
- Respect budget, squad composition, club limits, lineups, captain/vice constraints, chip availability, transfer costs, Wildcard, Free Hit, Bench Boost, and Triple Captain scoring.
- Never be reported as fair performance.

Oracle output should explain the gap between strict fair decisions and hindsight-optimal or hindsight-greedy decisions.

## Architecture

Add focused strategy modules under `src/backtest/strategies/`:

- `baseline.ts`: exports the current deterministic baseline strategy moved out of `src/backtest/index.ts`.
- `lineup.ts`: shared legal formation, bench, captain, and vice-captain helpers.
- `transfers.ts`: shared transfer candidate generation, legal squad checks, transfer-cost-aware scoring, and replacement selection.
- `fair.ts`: strict point-in-time strategy using only decision snapshot and manager state.
- `oracle.ts`: hindsight comparator using full snapshots and future data through a separate runner path.

Keep `BacktestEngine` unchanged for fair strategies. Add an oracle-specific runner or strategy factory that receives the full snapshot schedule explicitly so the leakage is isolated and visible by type/API. Do not make `actualResults` available to normal `BacktestStrategy`.

Update `src/backtest/index.ts` to select a strategy from CLI flags:

- `--strategy=baseline`
- `--strategy=fair`
- `--strategy=oracle`

The default should remain `baseline` until fair mode is verified stable. The CLI output must include the selected strategy name.

## Data Flow

1. `backtest:prepare` continues to create `gw-1.json` through `gw-38.json`.
2. `backtest:run -- --strategy=baseline` runs the current baseline.
3. `backtest:run -- --strategy=fair` runs the strict point-in-time strategy through `BacktestEngine`.
4. `backtest:run -- --strategy=oracle` loads all snapshots and runs the oracle comparator through legality/scoring functions.
5. Reports include strategy name, totals, transfers, chips, captain output, bench output, final value, and provenance.

## Fair Transfer Model

Fair transfer evaluation should stay simple for the first version:

- Candidate pool: top expected-points players by position plus affordable replacements, capped per position for speed.
- Transfer counts: evaluate `0`, `1`, and limited `2` transfer moves each week.
- Score: projected starting XI gain plus bench value, minus hit cost, plus small squad-value and bank tie-breakers.
- Legality: every candidate must pass squad size, budget, club limit, and composition checks.
- Determinism: sort ties by expected points, then price efficiency, then player id.

This deliberately avoids complex multi-week optimization in the first pass. The oracle comparator and reports will show where single-week greedy decisions are insufficient.

## Chip Planner

Fair mode should use a threshold planner:

- Triple Captain: play on the highest captain expected-points week remaining, with preference for double-gameweek fixture count. To avoid waiting forever, allow use when projection exceeds a threshold and the season is past a configured checkpoint.
- Bench Boost: play when current bench expected points exceed a threshold and all four bench players have nonzero expected points or fixture coverage.
- Wildcard: compare current squad projected value against a rebuilt squad. Play only when projected improvement clears a threshold and the chip is legal.
- Free Hit: compare current squad projected XI against a one-week best legal squad. Play only when one-week gain clears a threshold and the chip is legal.

Oracle mode should choose chip weeks from realized outcomes while preserving legal usage constraints.

## Reporting

Extend backtest reports with:

- `strategy`: `baseline`, `fair`, or `oracle`.
- Points gained over baseline when comparing multiple modes.
- Transfer count, transfer costs, and transfer rows.
- Chip rows with gameweek, chip, and points.
- Captain points and bench points totals.
- Optional comparison output showing fair vs oracle gaps by category.

Rank percentile remains unavailable until rank distribution data is added.

## Testing

Add unit and integration coverage for:

- Strategy CLI selection and default behavior.
- Baseline parity after moving strategy code.
- Fair strategy makes a beneficial legal transfer when projected gain clears threshold.
- Fair strategy refuses a hit when projected gain does not clear threshold.
- Fair strategy selects legal lineups and captains highest projected starter.
- Fair strategy plays Triple Captain and Bench Boost in controlled high-value scenarios.
- Fair strategy plays Wildcard or Free Hit only when the threshold comparison is met.
- Oracle strategy can use actual results through an explicitly separate API and normal fair strategies cannot.
- Oracle decisions still pass `applyGameweekDecision` legality checks.
- Full smoke: prepared 2024/25 data can run `baseline`, `fair`, and `oracle` without crashing.

## Success Criteria

- `baseline` still reproduces the current deterministic behavior.
- `fair` makes transfers and plays at least Triple Captain and Bench Boost when legal/value-positive in the 2024/25 replay.
- `fair` materially beats the `1634` baseline without future leakage.
- `oracle` produces a higher ceiling and clearly reports that it used hindsight.
- Existing `npm run backtest:prepare` and `npm run backtest:run` continue to work.
- `npm test` and `npm run build` pass.

## Deferred Work

- Assistant Manager chip support.
- Rank distribution ingestion and rank percentile estimation.
- Multi-week dynamic programming or solver-based fair transfer planning.
- Learned prediction model trained only on past gameweeks.
- External ownership/effective-ownership data.
