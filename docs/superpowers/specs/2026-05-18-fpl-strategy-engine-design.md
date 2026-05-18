# FPL Strategy Engine Design

## Goal

Build a fully automatic Fantasy Premier League strategy engine that maximizes season outcome through a multi-objective strategy: cumulative expected points, rank-adjusted utility, and mini-league win probability. The engine should plan across the season, react to price/news changes, and execute legal actions automatically unless an emergency stop is enabled.

## Official Rule Inputs

The engine must model official FPL rules as first-class constraints:

- Squad size: 15 players, consisting of 2 goalkeepers, 5 defenders, 5 midfielders, and 3 forwards.
- Initial budget: GBP 100.0m.
- Club limit: maximum 3 players from one Premier League club.
- Starting XI: 11 players by the deadline.
- Formation: 1 goalkeeper, at least 3 defenders, at least 1 forward.
- Captain: captain score doubles; vice-captain replaces captain only if captain plays 0 minutes.
- Bench priority: autosubs follow bench order and must preserve valid formation.
- Transfers: 1 free transfer per gameweek after the first deadline.
- Saved transfers: unused free transfers carry over, up to 5 free transfers.
- Hit cost: each additional transfer costs 4 points.
- Per-GW transfer cap: 20 transfers unless using Wildcard or Free Hit.
- AFCON rule: after the GW15 deadline and before GW16, managers are topped up to 5 free transfers.
- Selling price: if a player rises after purchase, the selling price keeps half the gain rounded down to the nearest GBP 0.1m.
- Chips: only one chip can be played in a gameweek.
- Chip availability: two Bench Boosts, two Triple Captains, two Free Hits, and two Wildcards, split around the GW19 deadline.
- Free Hit and Wildcard retain saved free transfers after use.
- Deadlines: all team changes must be made before the gameweek deadline, normally 90 minutes before first kickoff; deadlines do not change within 24 hours of scheduled time.
- Scoring: minutes, position-specific goals, assists, clean sheets, saves, defensive contribution, penalties, cards, own goals, goals conceded, and bonus points.

## Architecture

The core should be a deterministic Strategy Engine. The LLM should be an interface, explainer, and news summarizer, not the authority for irreversible actions.

Components:

- Rules Engine: validates official constraints, scoring, deadlines, formations, transfer limits, chip windows, selling prices, and special events.
- State Store: keeps current squad, sale prices, bank, free transfers, chips, rank, leagues, rivals, fixtures, deadlines, and historical decisions.
- Projection Engine: estimates expected points, expected minutes, clean sheet probability, attacking returns, bonus probability, defensive contribution, and risk.
- News Intelligence: ingests FPL API data, official/club news, curated sources, broad X/social search, and source reliability history.
- Scenario Simulator: evaluates candidate actions over adaptive horizons.
- Utility Engine: combines expected points, rank leverage, mini-league win gain, price value, risk, hit cost, and opportunity cost.
- Execution Policy: automatically executes selected actions unless blocked by correctness gates or `EMERGENCY_STOP=true`.
- Calibration Loop: compares predictions to actual outcomes and adjusts confidence/source weights.

Tools and schedulers should ask the Strategy Engine for decisions. They should not independently invent transfers, chips, bench order, or captaincy choices.

## Decision Flow

Each gameweek should run as a rolling cycle:

1. Post-Deadline Review
   Store actual points, autosubs, captain outcome, chip usage, transfer result, rank movement, mini-league changes, and prediction error.

2. Early Gameweek Baseline Plan
   Generate a provisional plan using adaptive horizons:
   - Captain, vice-captain, and bench: 1 gameweek.
   - Transfers: 4-8 gameweeks.
   - Wildcard: 8-12 gameweeks.
   - Chips: season-window comparison.

3. Price Watch
   Track planned buys, planned sells, risky holds, and affordability thresholds. Execute early only when waiting would make the best plan unaffordable, materially reduce future flexibility, or cross a configured expected-points/team-value loss threshold.

4. News Watch
   Continuously update expected minutes and confidence using FPL API status, official news, curated sources, and broad X/social signals.

5. Deadline Re-Optimization
   Near the deadline, rerun the simulator with latest news, injuries, lineups/leaks, prices, and deadline timing.

6. Automatic Execution
   Execute transfers, captain/vice, bench order, and chips if selected by policy and not blocked by legality or safety checks.

7. Audit Log
   Record candidates considered, selected action, rejected actions, reason, expected utility, and sources used.

## Optimization Model

The optimizer should rank candidate actions by a combined utility score:

```text
Utility = SeasonExpectedPoints
  + RankLeverage
  + MiniLeagueWinGain
  + PriceValueGain
  - RiskPenalty
  - HitCost
  - OpportunityCost
```

Definitions:

- SeasonExpectedPoints: projected points over the relevant horizon.
- RankLeverage: ownership/captaincy leverage when upside justifies risk.
- MiniLeagueWinGain: adjustment from rival teams, likely captains, and points gaps.
- PriceValueGain: value from preserving affordability and team value.
- RiskPenalty: availability uncertainty, rotation risk, weak bench cover, and low source confidence.
- HitCost: explicit 4-point cost per additional transfer.
- OpportunityCost: value of saving free transfers or chips for future opportunities.

The simulator should compare:

- Bank transfer.
- Single transfer.
- Multiple transfers with hits.
- Captain, vice-captain, and bench alternatives.
- Chip and no-chip alternatives.
- Wildcard and Free Hit squad paths.
- Future flexibility after each move.

The output must be an auditable ranked list with utility breakdowns.

## News And Social Strategy

The system should use a hybrid source strategy:

- Authoritative sources: FPL API status, fixtures, deadlines, and official club/PL injury news.
- Trusted sources: reliable FPL news accounts, press conference aggregators, and lineup leak accounts with historical reliability.
- Broad social/X search: detects emerging rumors, unusual volume, lineup leaks, injury chatter, and sentiment shifts.

Broad social signals can affect monitoring and risk, but automatic execution should require corroboration or low downside. Source reliability should be scored over time by comparing claims to actual outcomes.

## Availability And Minutes Model

Player availability should use a probability model:

- Estimate expected minutes from FPL chance fields, status, injury news, pressers, lineup leaks, historical starts, and fixture congestion.
- Reduce expected points smoothly for uncertainty.
- Hard-block players below configurable confidence thresholds for captaincy and incoming transfers.
- Include bench cover and autosub quality when evaluating risk.

## Automation And Safety

The target mode is fully automatic, including transfers, captain/vice, bench order, and chips. The engine should not require human confirmation once enabled.

Hard blocks still apply:

- Illegal squad or formation.
- Over budget.
- Over club limit.
- Past or stale deadline data.
- Missing authenticated team state.
- Duplicate execution for the same planned action.
- Emergency stop enabled.
- Source confidence too low for the action type.
- FPL API mutation result not verified.

Human override is through configuration, especially `EMERGENCY_STOP=true`. Optional max-risk configuration can reduce aggression without code changes.

For chips, the engine may play them automatically only when the season-window simulator shows the current opportunity beats expected future chip value by enough margin.

## Data And Calibration

Persist these records:

- Squad snapshots, sale prices, bank, free transfers, chips.
- Fixture calendar, double/blank gameweek flags, deadlines.
- Player projections by gameweek: xP, expected minutes, availability confidence, and source reasons.
- News items with source, timestamp, affected player, extracted claim, confidence, and outcome.
- Candidate actions considered and rejected.
- Executed actions with utility breakdown.
- Actual outcomes after each gameweek.
- Source reliability history.
- Model calibration errors.

Calibration should compare predicted vs actual points, minutes, price changes, and player availability. It should adjust confidence/source weights while keeping strategy rules explicit and inspectable.

## Testing And Validation

Validation should be layered before enabling live full automation:

- Rules tests: squad legality, formation, budget, club limit, chip windows, transfer costs, selling price, and deadlines.
- Projection tests: DGW/BGW handling, expected minutes, availability uncertainty, autosubs, and captain effects.
- Simulator tests: candidate ranking, hit accounting, opportunity cost, and future flexibility.
- Execution tests: no duplicate transfers, no stale deadline execution, no action without authenticated state, and verified API mutation results.
- Backtests: replay historical gameweeks and compare decisions against actual outcomes.
- Dry-run shadow mode: log what the agent would do before enabling live execution.
- Audit tests: every action has an explanation with utility breakdown and source evidence.

## Implementation Scope

This design should be implemented incrementally:

1. Formalize rules and state models.
2. Replace ad-hoc optimizer calculations with rule-aware projections.
3. Add scenario simulation and utility ranking.
4. Add news/source confidence and price triggers.
5. Add execution policy and audited automatic action plans.
6. Add calibration and backtesting.

The first implementation plan should focus on rules/state/projection foundations before live execution expansion.
