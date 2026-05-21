# LLM Experiment Variation Design

## Goal

Make LLM/news backtest experiments produce meaningful strategy variation while preserving reproducible comparisons by default. The current AI path is active, but it almost always receives only `hold` and one `best-transfer` candidate, so OpenAI consistently picks the deterministic top-projection transfer and the season score does not change across runs.

## Scope

This design extends the existing hybrid candidate-ranker experiment. It does not allow the LLM to invent arbitrary squads or bypass FPL legality checks. Deterministic code still generates legal candidates; the LLM only chooses among them.

The feature has two modes:

- Reproducible config variants by default.
- Explicit stochastic runs behind `--stochastic`.

## Candidate Generation

Candidate generation is the main source of meaningful variation. Instead of returning only `hold` and the single best transfer, the experiment should generate a bounded slate of legal choices:

- `hold`.
- Several one-transfer alternatives by projected gain.
- Optional hit-taking alternatives when the config allows hits.
- Different captaincy choices for otherwise identical squads when captain candidates are close.

Every candidate must remain legal through the existing replay validator. Candidate ids must be stable and descriptive enough for caching and reports, for example `transfer-1`, `transfer-2`, `hit-1`, or `captain-alt-1`.

## Experiment Configs

Experiment configs become real objects rather than implicit mode slices. Initial configs:

- `balanced`: prefers total expected points with moderate transfer discipline.
- `aggressive`: more willing to take hits and chase upside.
- `conservative`: prefers holds, avoids hits, and values transfer preservation.
- `differential`: can prefer lower-owned or non-template options when available in the snapshot data.
- `news-sensitive`: weighs relevant news more heavily when news exists, otherwise behaves like balanced.

Each config defines:

- Prompt instruction.
- Model name.
- Temperature for deterministic mode, normally `0`.
- Candidate count.
- Whether hits are allowed.
- Any candidate scoring bias used before candidates are sent to the LLM.

If ownership or differential data is unavailable in a historical snapshot, `differential` must degrade explicitly to available fields and include a warning or report note rather than silently pretending ownership data exists.

## CLI Behavior

The experiment runner should separate modes from configs:

- Modes: `fair`, `llm-news-strict`, `llm-news-loose`.
- Configs: `balanced`, `aggressive`, `conservative`, `differential`, `news-sensitive`.

`--max-configs=N` limits LLM configs, not modes. Fair always runs once per season as the comparator. With `--allow-llm-news`, each selected config runs for each selected LLM/news mode.

Add explicit stochastic support:

- `--stochastic` enables nonzero temperature for configs that define one.
- `--run-id=<id>` identifies a stochastic run and is included in ranker cache keys.
- If `--stochastic` is set without `--run-id`, generate a short run id and print it in the summary.
- Without `--stochastic`, reruns with the same inputs and cache should remain reproducible.

## Ranker Prompt And Cache

The OpenAI request should keep strict JSON schema output constrained to candidate ids. The prompt should include the active config's strategy bias and concise candidate metadata. Cache keys should include:

- Model.
- Mode.
- Config id.
- Candidate slate.
- News context.
- Stochastic flag.
- Run id when stochastic.

Provider failures and invalid candidate ids continue to use deterministic fallback. Fallbacks should be visible in cached ranker explanations and reports.

## Reporting

Experiment summaries should make variation auditable. Add per-row metadata:

- Config id.
- Model.
- Temperature.
- Stochastic flag.
- Run id when present.
- Candidate choice counts by candidate id prefix.
- Fallback count.

The summary should still include total points, transfers, chips, captain points, bench points, warnings, and delta versus fair.

## Testing

Tests should cover:

- Candidate generation returns multiple legal candidates when alternatives exist.
- Conservative configs exclude hit candidates.
- Aggressive configs may include hit candidates when legal and useful.
- `--max-configs` limits configs rather than modes.
- `--stochastic` changes cache identity by run id.
- Deterministic mode remains reproducible.
- Reports include choice counts and fallback counts.

## Non-Goals

- Direct LLM-created arbitrary transfers or squads.
- Large hyperparameter search.
- Guaranteeing that every config beats fair.
- Making scores change by adding hidden randomness to deterministic runs.
