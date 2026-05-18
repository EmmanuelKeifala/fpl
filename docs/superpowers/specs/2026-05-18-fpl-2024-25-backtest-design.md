# FPL 2024/25 Backtest Design

## Goal

Build a local historical replay system that runs the FPL agent through the 2024/25 season from GW1 to GW38. The agent should build its own GW1 squad, then manage transfers, captain, vice-captain, bench order, and chip usage using only information that was available before each gameweek deadline.

The backtest should produce a multi-objective outcome report: total points, estimated overall rank percentile, transfer and chip usage quality, squad value, weekly points, captain returns, bench points, risk stats, and decision logs.

## Core Requirements

- Replay the full 2024/25 season locally from cached historical data.
- Download and normalize public data once, then run backtests from immutable local snapshots.
- Enforce strict point-in-time integrity: no future scores, future prices, future injuries/news, later ownership, or later fixture outcomes may be visible before a deadline.
- Simulate a full-season manager: GW1 squad selection, weekly transfers, captain/vice, bench order, and chips.
- Reuse existing strategy rules, squad validation, projections, and optimizer logic where appropriate.
- Keep historical replay separate from live automation so backtest code cannot accidentally mutate a real team.

## Architecture

The system should use a Snapshot Replay Engine with four primary units:

- HistoricalDataIngest: downloads public 2024/25 data, validates it, and stores normalized local inputs.
- SnapshotStore: exposes immutable per-gameweek snapshots that include only data known before each deadline plus separate post-deadline actual results.
- BacktestEngine: runs GW1-GW38, asks the strategy layer for decisions, validates decisions, applies legal state transitions, and scores locked teams against actual results.
- BacktestReport: emits machine-readable JSON and a concise terminal summary with season, weekly, and decision-level metrics.

The strategy layer must never read raw season data directly. It receives only the current manager state and the current gameweek's pre-deadline snapshot. Actual results are applied only after the gameweek decision is locked.

## Data Flow

Historical data should be stored under a dedicated local cache such as `data/historical/2024-2025/`. The first version should treat prepared snapshots as immutable. If source data changes or normalization improves, the dataset version should change rather than silently altering an existing replay.

Per gameweek flow:

1. Load the pre-deadline snapshot for GW N.
2. Build a legal decision context from current manager state.
3. On GW1, ask the strategy layer to select the initial 15-player squad within budget and rules.
4. On later gameweeks, ask for transfers, captain, vice-captain, starting XI, bench order, and optional chip.
5. Validate the selected decision against FPL rules before accepting it.
6. Lock the decision.
7. Apply actual GW N results after the lock.
8. Update squad state, bank, free transfers, transfer hits, player purchase/selling prices, chip availability, squad value, weekly points, and logs.
9. Continue until GW38.
10. Emit the full season report.

Snapshot generation must explicitly separate `knownBeforeDeadline` from `actualResults`. Projection and decision code can use only `knownBeforeDeadline`; scoring can use only `actualResults` after lock.

## Components

The first implementation should keep backtest-specific code under `src/backtest/`:

- `src/backtest/data-source.ts`: defines source URLs, download behavior, local cache paths, and data provenance.
- `src/backtest/snapshots.ts`: normalizes downloaded data into per-GW snapshots and exposes `getSnapshot(gameweek)`.
- `src/backtest/state.ts`: models simulated manager state, including squad, bank, free transfers, chips, transfer history, player purchase prices, selling prices, weekly decisions, and accumulated points.
- `src/backtest/engine.ts`: owns the replay loop and calls a strategy decision function without embedding strategy-specific ranking logic.
- `src/backtest/report.ts`: builds JSON output and terminal summaries.
- `src/backtest/index.ts` or a CLI entrypoint: exposes commands such as `prepare-data` and `run-season`.
- Existing `src/strategy/*`: remains the source for FPL rules, squad validation, projections, and later higher-level strategy decisions.

Backtest state transitions should use the same rule helpers as live strategy where possible. If replay requires additional rules, such as autosubs or exact chip scoring, those rules should be added to the shared strategy layer rather than duplicated inside the backtest engine.

## Point-In-Time Integrity

The main correctness risk is data leakage. The design should prevent leakage through boundaries, not convention alone:

- Snapshot APIs should expose pre-deadline inputs and actual results as separate fields.
- Decision functions should accept only pre-deadline inputs.
- Engine tests should prove decisions are produced before results are applied.
- Reports should include data provenance and known missing historical signals.
- Optional historical fields, such as injury/news history, should be marked unavailable if they cannot be reconstructed safely.

If a point-in-time field cannot be sourced reliably, the first version should omit it or mark it unavailable rather than substituting later data.

## Error Handling

Backtest integrity issues should fail fast:

- Missing or malformed historical files stop `prepare-data`.
- Snapshot generation rejects future leakage, duplicate player IDs, invalid prices, missing fixtures, and incomplete result rows.
- Illegal decisions are rejected before scoring.
- Decision validation errors include the gameweek, current state summary, and exact invalid condition.
- Optional data gaps are represented explicitly instead of silently filled from later data.
- Reports include source URLs, download time, season, snapshot version, and known limitations.

The first version should avoid best-effort auto-repair. Suspect data should stop the run so the issue is visible.

## Reporting

The final report should include:

- Total FPL points after GW38.
- Estimated overall rank percentile after GW38, if enough public rank distribution data is available.
- Weekly points and cumulative points.
- GW1 squad and final squad.
- Transfers, hits, bank, squad value, and selling-price effects.
- Captain, vice-captain, bench, and autosub outcomes.
- Chip usage and chip returns.
- Bench points and missed bench points.
- Risk stats such as unavailable starters, low-minute starters, failed captaincy picks, and transfer outcomes.
- Decision logs with selected action, rejected alternatives if available, expected utility, and actual outcome.

The report should be machine-readable first, likely JSON, with a concise terminal summary for quick local runs.

## Testing And Validation

Validation should protect FPL rules, replay correctness, and point-in-time integrity:

- Snapshot normalization tests: verify prices, fixtures, player IDs, deadlines, and result mapping.
- Manager state tests: verify free transfers, hits, bank, squad value, chip usage, captain points, bench order, autosubs, and selling prices.
- Leakage tests: use a tiny fake season where a future high scorer is only obvious after GW2, then assert GW1 decisions cannot access GW2 actual data.
- Engine tests: replay a 2-3 GW miniature season and verify decisions are locked before scoring and totals match expected values.
- Report tests: verify total points, rank estimate field, weekly points, transfer log, chips, squad value, and data provenance.
- Integration smoke test: run the 2024/25 replay only when the local dataset exists; otherwise skip with a clear message so CI does not require internet access.

## Implementation Scope

The implementation should be incremental:

1. Define historical data source and cache layout.
2. Add snapshot types and normalization for a minimal reliable dataset.
3. Add manager state transitions and scoring for a miniature season fixture.
4. Add the replay engine and JSON report.
5. Add 2024/25 data preparation and a local full-season smoke run.
6. Integrate stronger strategy decisions for GW1 squad, transfers, captaincy, bench, and chips.

This design intentionally prioritizes deterministic replay and leakage prevention over immediate model sophistication. Once the replay loop is reliable, projection and strategy improvements can be measured against the same frozen season.
