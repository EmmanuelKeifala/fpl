# Backtest Season Flag Design

## Goal

Allow the backtest prepare and run commands to target historical seasons other than the current hardcoded `2024-2025`, starting with `2023-2024`.

## Approach

Add an explicit `--season=YYYY-YYYY` CLI option for both `prepare-data` and `run-season`. If omitted, the default remains `2024-2025` so existing behavior is unchanged.

The selected season drives three values:

- The snapshot season passed through the normalizer and engine.
- The default cache directory, `data/historical/<season>`, unless `FPL_BACKTEST_CACHE_DIR` is set.
- The Vaastav dataset path, derived from `YYYY-YYYY` as `YYYY-YY` (for example, `2023-2024` maps to `2023-24`).

## Validation

Reject malformed season values before any fetch or replay work starts. The accepted form is four digits, a hyphen, and four digits, with the second year exactly one greater than the first.

## Testing

Add parser tests for the default season, explicit valid seasons, and invalid season values. Then run the full test suite, build, and 2023/24 prepare plus baseline/fair/oracle replay smoke tests.
