# Local FPL Player-Fixture ML

This pipeline reconstructs player-fixture examples from four historical
seasons. It is leakage-safe at the gameweek boundary, but the source exports
are reconstructed post-event data rather than strict deadline snapshots.

## Setup

Python 3.10 or newer is required. From the repository root:

```bash
python3 -m venv .venv-ml
. .venv-ml/bin/activate
python -m pip install -r requirements-ml.txt
```

The training pipeline does not access the network, live-account credentials,
or live FPL endpoints. `live_features.py` is a separate account-independent
adapter that reads only public FPL endpoints.

## Commands

```bash
python scripts/ml/pipeline.py --help
python scripts/ml/pipeline.py build
python scripts/ml/pipeline.py train
```

Run both stages, replacing prior generated output:

```bash
python scripts/ml/pipeline.py all --overwrite
```

Generated datasets and predictions use ignored paths by default. The portable
deployment artifact is written under tracked `artifacts/` so a clean checkout
can run shadow inference without the historical training corpus:

- `data/ml/player-fixture-v1/dataset.csv`: metadata, ordered numeric features,
  and four targets at player-fixture grain.
- `data/ml/player-fixture-v1/manifest.json`: schema, row counts, cutoffs, and
  leakage controls.
- `data/ml/player-fixture-v1/out-of-season-predictions.csv`: 2024-2025
  validation and 2025-2026 test predictions with actual outcomes.
- `data/ml/player-fixture-v1/validation-predictions.csv`: physically isolated
  2024-2025 policy-calibration input.
- `data/ml/player-fixture-v1/diagnostic-test-predictions.csv`: physically
  isolated 2025-2026 diagnostic output.
- `artifacts/ml/player-fixture-v1/model.json`: plain JSON trees and all metadata
  needed for inference without Python or sklearn. The artifact embeds Python
  reference vectors that the TypeScript loader verifies at load time.
- `artifacts/ml/player-fixture-v1/metrics.json`: validation/test metrics and
  validation-only blend selection.

Use `--help` on any subcommand for path overrides. Existing generated outputs
are not replaced unless `--overwrite` is supplied.

## Feature And Model Contract

Every target row uses only lower-numbered gameweeks. All rows in a gameweek are
built before histories update, preventing one double-gameweek fixture from
entering another fixture's features. Prior observations must also have kicked
off before the target fixture. Known same-GW fixture kickoffs can affect rest
days, but same-GW outcomes never enter histories.

Features include current home/away and schedule context, prior known price,
one-hot position, 2/4/6-GW and season-to-date shrunk player rates, prior club
and opposition scoring/conceding rates, rest, and scoring-era flags. Per-90
rates use prior minutes; appearance and start rates use prior fixture rows;
clean-sheet rate is conditional on prior appearances. Team match outcomes are
deduplicated by fixture before history updates. Exact duplicate source records
are discarded, while conflicting rows at the canonical grain stop the build.

Player names and IDs, club names and IDs, opposition IDs, fixture IDs, and raw
kickoff timestamps are metadata only. Current-row expected points, minutes,
starts, ownership/transfers, match statistics, scores, and outcomes are never
fitted features.

Models fit 2022-2023 and 2023-2024. The blend between direct points and appearance times
conditional points is selected from a fixed list on 2024-2025 active-player
gameweek RMSE, then frozen before 2025-2026 is predicted or scored. The JSON
export self-checks every serialized gradient-boosting model against sklearn at
an absolute tolerance of `1e-10`. Metrics marked active use actual `minutes >
0` only for diagnostic subsetting, never as an inference-time feature. The
2025-2026 defensive-scoring flag is present in the schema but is unseen during
2022-2024 model fitting, so its scoring effect cannot be learned under this
strict season protocol. Historical source files before 2022-2023 do not contain
the `starts` and expected-goal columns required by this feature contract, so
they are not silently zero-filled; a separate common-schema model is needed to
use those older records honestly. Since 2025-2026 has already been inspected during
development, it is a held-out diagnostic season rather than an untouched
promotion test.

## Replay Policy

The replay overlay reads the out-of-season prediction file, aggregates double
gameweeks, and gives players absent from the current fixture registry zero
availability. Calibrate the small deployment-policy grid on 2024-2025 only:

```bash
npm run ml:calibrate-policy
```

This writes ignored `data/ml/player-fixture-v1/policy-calibration.json`. The
frozen v1 policy uses a one-gameweek horizon and an 8-point hit threshold. Run
the diagnostic 2025-2026 replay with:

```bash
npm run backtest:ml
```

The validation-only policy calibration selects a two-gameweek horizon, a
24-point hit threshold, and 40 candidates. It produced 2,354 net points with no
transfer hits and 29 gameweeks above the published weekly average. The frozen
2025-2026 diagnostic produced 2,112 net points with no transfer hits, 27 wins
and one draw against the weekly average, and 217 points above the published
season average. Its weekly win rate is 71.1%, so it still misses the proposed
90% promotion gate. These reconstructed results are not a verified rank or
promotion claim.

## Live Shadow Forecasts

Generate the next actionable gameweek's immutable feature sidecar before its
deadline:

```bash
npm run ml:live-features
```

The command reads public `/bootstrap-static/`, `/fixtures/`, and
`/element-summary/{id}/` data. It emits one 96-value row per player-fixture
under `data/live/player-fixture-features-v1/<season>/gw-<N>/` and prints the
exact output path. Player, team, opponent, and fixture IDs remain join metadata
and never enter a fitted vector. All lower-GW histories are frozen before any
target row is built, and values are rounded to the same ten significant digits
used by training.
For GW N, GW N-1 must already be marked finished and data-checked, and the
sidecar cutoff must be exactly N-1; partial or farther-future captures fail.

Point the worker at that sidecar:

```dotenv
FPL_ML_SHADOW_ENABLED=true
FPL_ML_MODEL_PATH=artifacts/ml/player-fixture-v1/model.json
FPL_ML_FEATURE_SIDECAR=data/live/player-fixture-features-v1/<season>/gw-<N>/<file>.json
```

Shadow mode is disabled by default. It stores paired heuristic and raw ML
forecasts in separate `ml_shadow_*` tables and reconciles points, minutes, and
starts after the GW. It cannot provide forecasts to the optimizer or call any
authenticated mutation endpoint. Invalid, stale, post-deadline, incomplete,
or schedule-drifted artifacts are recorded as failed shadow runs.

For an unattended worker, set `FPL_ML_AUTO_FEATURES=true` instead of a static
`FPL_ML_FEATURE_SIDECAR`. The worker generates the next actionable GW sidecar,
validates it against the model and current public fixture schedule, stores it in
`FPL_ML_FEATURE_DIRECTORY`, and regenerates it if the schedule drifts. A failed
or invalid generation is persisted as a failed shadow run and never reaches an
execution path.

Only the next actionable GW matches the training history boundary;
farther-horizon vectors would require unknown intervening results. Availability
and timestamped news intentionally remain outside the fitted 96-feature vector.

## Tests

The contract tests do not require NumPy or sklearn:

```bash
python -m unittest scripts.ml.test_pipeline scripts.ml.test_live_features
python -m py_compile scripts/ml/pipeline.py scripts/ml/live_features.py scripts/ml/test_pipeline.py scripts/ml/test_live_features.py
npm run build
npm test
```
