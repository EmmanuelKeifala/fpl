# Top-10k Improvement Program Design

## Goal

Build an autonomous FPL decision system that can credibly target a top-10k finish. Success is measured against verified historical top-10k cutoffs on untouched seasons, not against a fixed raw score. A 2,500-point season remains a useful ambition, but scoring environments and chip rules vary by season.

## Benchmark Integrity

The existing historical reports are diagnostic, not promotion-grade. Same-gameweek Vaastav `xP` may have been captured after matches, final fixture files can reveal later rescheduling, and global rules do not accurately represent every season. The 2024/25 autonomous score of 2,808 must not be used as evidence of elite performance.

Create two explicitly labeled replay tiers:

- `strict`: only fields demonstrably available before the deadline.
- `reconstructed`: safely lagged statistics plus fixture information whose exact announcement time is unavailable.

Every decision-facing forecast field must record its source, effective gameweek, and availability classification. Snapshot validation must reject same-gameweek result-derived inputs and fields observed after the deadline. Existing reports remain available as `legacy` results but cannot pass promotion gates.

## Season Rules

Replace global historical assumptions with an explicit `SeasonRules` configuration containing:

- Maximum saved free transfers and special top-ups.
- Chip inventory, reset dates, and chip-specific transfer behavior.
- Available chip types, including a declared unsupported status where necessary.
- Season scoring rules.
- Transfer, squad, captain, and lineup constraints.

The replay engine must reject seasons without a ruleset. Reports must disclose unsupported scoring mechanisms such as the 2024/25 Assistant Manager chip and avoid direct rank claims when parity is impossible.

## Historical Feature Pipeline

Build pre-deadline player features exclusively from previously revealed gameweeks:

- Rolling 2/4/6-gameweek minutes, starts, substitute appearances, points, xG, and xA.
- Season-to-date rates with position-level shrinkage for small samples.
- Team attacking and defensive strength calculated from prior results.
- Home/away fixture context and fixture count.
- Price and team membership from the last safe observation.
- Availability represented as `unknown` when historical status is unavailable, never silently `available`.

Same-gameweek Vaastav `xP` is excluded. Current-gameweek rows are used only for scoring after the decision boundary. Final fixture assignments may be used only in `reconstructed` mode and must be labeled as a limitation.

## Projection Model

Forecast player outcomes through separate components:

1. Probability of starting.
2. Probability of a substitute appearance.
3. Minutes conditional on starting or appearing from the bench.
4. Goals, assists, clean sheets, saves, bonus, cards, and defensive contributions conditional on minutes.
5. Integrated expected FPL points and uncertainty for each future gameweek.

Train and calibrate with rolling-origin evaluation. A forecast for gameweek N may use only seasons and gameweeks completed before N. Calibration is segmented by position, expected-minutes cohort, projection decile, and fixture count. Stored forecasts include model version, feature version, capture time, deadline, horizon, and component probabilities.

## Shared Planner

Introduce one pure planner used by both replay and live automation. Its inputs are a point-in-time squad state, season rules, multi-gameweek forecasts, known fixtures, and available chips. It must not fetch APIs, read actual results, write databases, or execute FPL mutations.

Planner state contains:

- Squad and purchase/selling prices.
- Bank and saved free transfers.
- Available chips.
- Current gameweek and planning horizon.

Planner actions include hold, one to three transfers, Wildcard, Free Hit, Bench Boost, and Triple Captain where legal. The search replans every gameweek over a default six-gameweek horizon.

The objective combines:

- Expected legal starting-XI points.
- Captain and conditional vice-captain value.
- Formation-aware autosub and bench value.
- Transfer hit costs.
- Terminal squad quality, bank flexibility, and saved-transfer value.
- Downside penalties for uncertain minutes and concentrated availability risk.

Initial squads, Wildcards, and Free Hits use global legal squad optimization instead of greedy selection. Candidate pruning must preserve distinct outgoing, budget, and club-limit paths.

## Chip Planning

Remove forced chip weeks and global blank/double heuristics. Evaluate each chip counterfactually:

- Free Hit: temporary optimal squad value minus the best no-chip action.
- Wildcard: multi-week optimal rebuild value minus the best transfer path.
- Bench Boost: all-15 expected return minus normal lineup and autosub value.
- Triple Captain: extra captain multiplier value for the selected captain.

Play a chip only when its current incremental gain exceeds both a minimum threshold and the estimated opportunity value of retaining it. Fixture uncertainty must reduce, not increase, confidence in a chip recommendation.

## Decision Attribution

Every replay report must separate:

- Projection error.
- Starting-XI and bench regret.
- Captain and vice-captain regret.
- Transfer gain and hit cost.
- Incremental chip gain rather than whole-gameweek score.
- Points attributable to unsupported or reconstructed data.

Add three clearly named hindsight comparators: fixed-squad lineup oracle, one-gameweek legal transfer oracle, and full-season legal oracle. These isolate where points are lost without exposing outcomes to the fair strategy.

## Evaluation Protocol

Use chronological train, validation, and test partitions:

- Train projection parameters on the earliest supported seasons.
- Select planner and chip parameters on a later validation season.
- Evaluate once on an untouched test season.
- Keep the current live season out of repeated historical tuning.

Compare strict and reconstructed modes separately. Report score, verified top-10k cutoff, active-manager benchmarks where available, projection MAE and bias, transfer count, hit cost, chip gain, and regret decomposition.

Promotion requires all of the following:

- No deadline-boundary or field-availability violations.
- Better out-of-sample projection accuracy than the preceding model.
- Better untouched-season points than the preceding planner.
- Performance at or above the verified top-10k cutoff where scoring parity exists.
- Stable improvement across more than one season before enabling live execution.

If top-10k cutoff data or scoring parity is unavailable, the report must state that the promotion criterion is unverified rather than infer success from average score.

## Live Rollout

Deploy new models in shadow mode first. Persist the complete pre-deadline snapshot, candidate actions, selected action, forecast versions, and explanation. Reconcile only the final forecast captured before the deadline. Live mutations remain behind the existing transfer, lineup, chip, and emergency-stop controls.

Promote in stages:

1. Leakage-safe dataset and season rules.
2. Walk-forward projection baseline.
3. Global squad and multi-gameweek transfer planner.
4. Counterfactual chip planner.
5. Appearance-aware lineup and captaincy.
6. Shadow evaluation, then guarded live execution.

## Error Handling

- Fail snapshot generation when required timestamps or provenance are missing.
- Fail replay startup when the season ruleset is absent.
- Reject non-finite forecasts and illegal planner actions before scoring.
- Preserve the previous promoted model when a candidate model fails evaluation.
- Never replace missing historical information with current API values.
- Cache model inputs and outputs by dataset, feature, and model version for reproducibility.

## Testing

Add focused coverage for:

- Same-gameweek and post-deadline field rejection.
- Lagged feature construction and rolling-origin boundaries.
- Season-specific free-transfer, scoring, and chip behavior.
- Planner legality, budget, club limits, hit accounting, and determinism.
- Counterfactual chip gains and opportunity-cost decisions.
- Captain/vice and formation-aware autosub behavior.
- Shared planner parity between replay and live adapters.
- Golden replays against selected official manager gameweeks.
- End-to-end strict replay with no access to current or future results.

## Success Criteria

- Legacy contaminated scores are clearly labeled and excluded from promotion.
- Strict snapshots contain no same-gameweek result-derived forecast inputs.
- Every supported replay uses an explicit season ruleset.
- Replay and live automation call the same pure planner.
- Projection and decision metrics are reproducible by model and dataset version.
- The final candidate reaches a verified historical top-10k cutoff on an untouched, scoring-compatible season before being described as top-10k capable.
