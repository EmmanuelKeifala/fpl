# FPL Historical Snapshot Normalizer Design

## Goal

Make `npm run backtest:prepare` produce runnable 2024/25 replay snapshots. The command should download public historical source data, normalize it into `gw-1.json` through `gw-38.json`, validate every snapshot, and allow `npm run backtest:run` to execute without the current missing `gw-1.json` failure.

## Data Source Strategy

Use the public Vaastav Fantasy Premier League dataset as the first normalizer source:

- GitHub API directory listing for provenance.
- `fixtures.csv` for fixture rows, kickoff times, teams, scores, and difficulty.
- `teams.csv` for stable team IDs and names where needed.
- `gws/gw1.csv` through `gws/gw38.csv` for per-player gameweek rows and actual results.
- `gws/xP1.csv` through `gws/xP38.csv` when available for expected-points inputs.

This is a hybrid fidelity approach. It makes the replay runnable now while clearly marking fields that are approximated rather than exact historical pre-deadline API snapshots.

## Snapshot Mapping

For each gameweek, generate one `GameweekSnapshot` consumed by `FileSnapshotStore`:

- `season`: `2024-2025`.
- `gameweek`: current GW number.
- `deadline`: earliest kickoff time for the gameweek until exact historical deadline data is available.
- `knownBeforeDeadline.players`: derived from the GW CSV plus optional xP CSV.
- `knownBeforeDeadline.fixtures`: derived from `fixtures.csv` rows where `event` equals the GW.
- `knownBeforeDeadline.unavailableFields`: lists unavailable point-in-time fields.
- `actualResults.playerResults`: derived from GW CSV `element`, `minutes`, and `total_points`.
- `actualResults.averageEntryScore`: `0` until reliable public rank/event summary data is added.
- `actualResults.highestScore`: `0` until reliable public rank/event summary data is added.
- `provenance`: source URLs, download time, snapshot version, and known limitations.

Player mapping:

- `id`: `element`.
- `webName`: `name`.
- `elementType`: `GK=1`, `DEF=2`, `MID=3`, `FWD=4`.
- `team`: stable team ID from `teams.csv`, falling back to deterministic team-name indexing if needed.
- `price`: `value` in FPL 0.1m units.
- `status`: `a` when no reliable historical status exists.
- `selectedByPercent`: derived from `selected` when available, otherwise `0`.
- `expectedPoints`: `xP` from the GW row or xP file when available, otherwise `0`.

Known limitations must include missing injury/news history, exact pre-deadline player status, exact deadline times, ownership timing, rank distribution, and any xP fallback use.

## Data Flow

`backtest:prepare` should run two phases.

1. Fetch phase:
Download the source listing, fixtures, teams, all GW CSVs, and available xP CSVs into the cache directory. Raw source files are provenance and normalizer input.

2. Normalize phase:
Parse cached CSVs, build `GameweekSnapshot` objects, validate each with `validateSnapshot`, then write `gw-N.json` files only after all snapshots pass validation.

After preparation, the cache contains both raw source files and normalized replay snapshots. Raw files remain implementation details; `gw-N.json` files are the immutable replay contract used by `backtest:run`.

## Components

Add focused normalizer code under `src/backtest/`:

- `csv.ts`: small local CSV parser for the dataset fields, including quoted fields and empty values.
- `normalizer.ts`: transforms cached Vaastav files into `GameweekSnapshot` objects and writes validated snapshots.
- `normalizer.test.ts`: tests mapping, validation failures, and atomic write behavior.
- `data-source.ts`: extend source download support so `prepare-data` can fetch text/CSV files as well as JSON metadata.
- `index.ts`: update `prepareData()` to fetch sources and invoke the normalizer.

Do not add a database dependency or external CSV parser for the first version. The required CSV behavior is small enough to test locally.

## Error Handling

The normalizer should fail fast for structural problems:

- Missing `gwN.csv` for any gameweek 1-38.
- Missing required columns: `element`, `name`, `position`, `team`, `value`, `xP`, `minutes`, `total_points`, `round`, and `kickoff_time`.
- Invalid positions outside `GK`, `DEF`, `MID`, and `FWD`.
- Duplicate player IDs within a gameweek.
- Missing actual result rows for known players.
- Missing fixture rows for a gameweek.
- Any generated snapshot failing `validateSnapshot`.

Optional data does not block generation:

- Missing xP input becomes `0` and adds a limitation.
- Missing exact deadline data uses earliest kickoff and adds a limitation.
- Missing rank distribution keeps average and highest score at `0` and adds a limitation.

Writes should be atomic enough for local use. Generate and validate all snapshots before replacing existing `gw-N.json` files. If normalization fails, existing runnable snapshots should remain untouched.

## Testing

Add tests that prove the current failure is fixed and normalization is safe:

- CSV parser tests for quoted commas, empty fields, numeric conversion, and header validation.
- Normalizer unit test using a tiny fake dataset for 2 GWs that writes valid `gw-1.json` and `gw-2.json`.
- Failure test where duplicate player IDs or missing columns prevent writes.
- Atomicity test where existing `gw-1.json` remains unchanged if normalization fails.
- CLI integration test where `prepare-data` with injected/local fake source files produces snapshots loadable by `FileSnapshotStore`.
- Full verification with `npm test` and `npm run build`.
- Manual full run with `npm run backtest:prepare && npm run backtest:run`.

## Implementation Scope

The first implementation should target a runnable deterministic replay, not perfect historical fidelity. It should generate snapshots from the available public CSV data, make limitations explicit, and keep the door open for stricter archived pre-deadline API snapshots later.

Deferred work:

- Exact historical FPL deadline times.
- Exact point-in-time injury/news/status snapshots.
- Rank distribution and final overall rank percentile.
- Better expected-points model beyond the dataset xP field.
- Data-source checksums for every downloaded raw file.
