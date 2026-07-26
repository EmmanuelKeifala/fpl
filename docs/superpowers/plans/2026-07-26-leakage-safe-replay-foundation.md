# Leakage-Safe Replay Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace contaminated same-gameweek forecasts and season-inaccurate replay rules with an explicitly versioned, lagged, reconstructed historical benchmark.

**Architecture:** Keep raw match rows exclusively on the scoring side of the gameweek boundary. Build decision features from rows revealed in earlier gameweeks, classify every replay dataset as `legacy`, `reconstructed`, or `strict`, and route historical transfer/chip behavior through season-specific rules. Preserve the current strategy interfaces so projection and planner work can build on this foundation.

**Tech Stack:** TypeScript, Node.js, existing CSV/snapshot pipeline, existing replay engine and CLI.

**Constraint:** Do not add new automated tests. Verify with the existing suite, TypeScript build, snapshot validation, and full-season replays.

---

### Task 1: Add Dataset Classification and Forecast Provenance

**Files:**
- Modify: `src/backtest/types.ts`
- Modify: `src/backtest/data-source.ts`
- Modify: `src/backtest/report.ts`

- [ ] **Step 1: Define replay data classifications**

Add these types to `src/backtest/types.ts`:

```ts
export type ReplayDataMode = 'legacy' | 'reconstructed' | 'strict';
export type FieldAvailability = 'exact' | 'lagged' | 'reconstructed' | 'unavailable';

export interface ForecastProvenance {
  sourceGameweek: number | null;
  availability: FieldAvailability;
  source: string;
}
```

Add `forecastProvenance: ForecastProvenance` to `BacktestPlayer`. Add `dataMode: ReplayDataMode` and `rulesVersion: string` to `SnapshotProvenance`.

- [ ] **Step 2: Version prepared manifests**

Add `dataMode` and `rulesVersion` to `BacktestManifest`. Change snapshot versions from `${season}-v1` to `${season}-${dataMode}-v2` so old caches cannot masquerade as corrected data.

- [ ] **Step 3: Disclose replay integrity in reports**

Extend `BacktestReport` and `formatBacktestSummary` to emit `dataMode`, `rulesVersion`, and a warning when `dataMode !== 'strict'`. Legacy reports must be labeled diagnostic and reconstructed reports must not claim verified top-10k performance.

- [ ] **Step 4: Verify compilation**

Run: `npm run build`

Expected: TypeScript errors identify every snapshot constructor that must supply the new required provenance. Resolve those constructors in the same task with `dataMode: 'legacy'` for test fixtures and existing non-normalized callers.

- [ ] **Step 5: Commit**

```bash
git add src/backtest/types.ts src/backtest/data-source.ts src/backtest/report.ts
git commit -m "Classify historical replay integrity"
```

### Task 2: Add Season-Specific Replay Rules

**Files:**
- Create: `src/backtest/season-rules.ts`
- Modify: `src/backtest/state.ts`
- Modify: `src/backtest/index.ts`

- [ ] **Step 1: Define explicit season rules**

Create `src/backtest/season-rules.ts` with:

```ts
import type { ChipName } from '../strategy/rules.js';

export interface SeasonRules {
  version: string;
  maxSavedTransfers: number;
  transferTopUps: Readonly<Record<number, number>>;
  initialChips: readonly ChipName[];
  chipResetAfterGameweek?: number;
  unsupportedChips: readonly string[];
}

const RULES: Record<string, SeasonRules> = {
  '2024-2025': {
    version: '2024-2025-v1',
    maxSavedTransfers: 5,
    transferTopUps: {},
    initialChips: ['wildcard', 'freehit', 'bboost', '3xc'],
    unsupportedChips: ['assistant-manager'],
  },
  '2025-2026': {
    version: '2025-2026-v1',
    maxSavedTransfers: 5,
    transferTopUps: { 16: 5 },
    initialChips: ['wildcard', 'freehit', 'bboost', '3xc'],
    chipResetAfterGameweek: 19,
    unsupportedChips: [],
  },
};

export function getSeasonRules(season: string): SeasonRules {
  const rules = RULES[season];
  if (!rules) throw new Error(`No replay rules configured for season ${season}`);
  return rules;
}
```

- [ ] **Step 2: Route state transitions through season rules**

In `src/backtest/state.ts`, initialize chips from `getSeasonRules(season)`, calculate carryover with the season's `maxSavedTransfers` and `transferTopUps`, and reset chips only at `chipResetAfterGameweek`. Keep live `FPL_RULES` unchanged.

- [ ] **Step 3: Attach rules version during preparation**

In `src/backtest/index.ts`, call `getSeasonRules(season)` before downloading or replaying. Pass `rules.version` into manifest and snapshot normalization. Unsupported seasons must fail before network or cache work begins.

- [ ] **Step 4: Verify existing behavior**

Run: `npm test && npm run build`

Expected: Existing suite passes and both supported seasons compile with explicit rules.

- [ ] **Step 5: Commit**

```bash
git add src/backtest/season-rules.ts src/backtest/state.ts src/backtest/index.ts
git commit -m "Apply season-specific replay rules"
```

### Task 3: Build Lagged Historical Player Features

**Files:**
- Create: `src/backtest/lagged-features.ts`
- Modify: `src/backtest/types.ts`
- Modify: `src/backtest/normalizer.ts`

- [ ] **Step 1: Expand decision-facing lagged features**

Add a `BacktestPlayerFeatures` object containing `sampleGameweeks`, `minutesPerMatch`, `startRate`, `pointsPer90`, `expectedGoalsPer90`, and `expectedAssistsPer90`. Attach it to `BacktestPlayer` as `features`.

- [ ] **Step 2: Implement a pure rolling accumulator**

Create `src/backtest/lagged-features.ts`. Store prior `CsvRow` observations by player and derive rates from only those rows. Aggregate duplicate fixture rows within a gameweek before updating history. Use position priors when history is empty:

```ts
const POSITION_PRIOR_XP: Record<number, number> = { 1: 3.5, 2: 3.4, 3: 3.8, 4: 4.0 };
```

Shrink observed points per 90 toward the prior using `reliability = Math.min(1, totalMinutes / 900)`. Multiply by expected minutes derived from lagged start rate and minutes per match. Return finite values clamped to `[0, 15]`.

- [ ] **Step 3: Correct the normalizer data boundary**

In `src/backtest/normalizer.ts`, stop reading `xp-raw-${gameweek}.csv` for decision forecasts. For each GW:

1. Parse current rows into `actualResults`.
2. Build players from identity fields plus feature history containing only GWs `< current GW`.
3. Use the last prior row for price; use current identity only when no prior identity exists.
4. Set status to `u` because exact historical availability is unknown.
5. Set `forecastProvenance.sourceGameweek` to the latest prior GW, or `null` for the position prior.
6. Only after the snapshot is complete, append current rows to feature history.

- [ ] **Step 4: Remove contaminated xP sources**

Stop downloading `xP*.csv` in `src/backtest/index.ts`. Keep old raw files ignored; the new snapshot version prevents accidental reuse.

- [ ] **Step 5: Verify generated values**

Run:

```bash
npm run build
npm run backtest:prepare -- --season=2025-2026 --data-mode=reconstructed
```

Expected: all 38 snapshots validate; GW1 players use `sourceGameweek: null`; GW2 players use only GW1 features; no snapshot provenance references `xP*.csv`.

- [ ] **Step 6: Commit**

```bash
git add src/backtest/lagged-features.ts src/backtest/types.ts src/backtest/normalizer.ts src/backtest/index.ts
git commit -m "Build forecasts from lagged gameweek data"
```

### Task 4: Enforce Snapshot Integrity

**Files:**
- Modify: `src/backtest/snapshots.ts`
- Modify: `src/backtest/normalizer.ts`

- [ ] **Step 1: Validate forecast provenance**

Reject snapshots when expected points are non-finite, forecast source GW is greater than or equal to the snapshot GW, reconstructed fields are labeled exact, or provenance mode/version is absent.

- [ ] **Step 2: Validate result and chronology integrity**

Reject duplicate result IDs, mismatched seasons, invalid fixture kickoff times, and result-derived source labels in `knownBeforeDeadline`.

- [ ] **Step 3: Make strict mode fail honestly**

The current final-season fixture source has no announcement timeline. If `--data-mode=strict` is requested, fail preparation with `Strict mode requires point-in-time fixture snapshots`. Reconstructed mode remains runnable and explicitly labeled.

- [ ] **Step 4: Verify failure and success paths**

Run:

```bash
npm run backtest:prepare -- --season=2025-2026 --data-mode=strict
npm run backtest:prepare -- --season=2025-2026 --data-mode=reconstructed
```

Expected: strict exits with the fixture-timeline error; reconstructed prepares 38 valid snapshots.

- [ ] **Step 5: Commit**

```bash
git add src/backtest/snapshots.ts src/backtest/normalizer.ts
git commit -m "Enforce replay forecast boundaries"
```

### Task 5: Add Replay Mode CLI and Cache Isolation

**Files:**
- Modify: `src/backtest/index.ts`
- Modify: `src/backtest/data-source.ts`
- Modify: `README.md`

- [ ] **Step 1: Parse replay data mode**

Add `dataMode: ReplayDataMode` to `RunOptions` and parse `--data-mode=legacy|reconstructed|strict`. Default new preparation and replay commands to `reconstructed`; require `--data-mode=legacy` to load old v1 caches.

- [ ] **Step 2: Isolate cache directories**

Use `data/historical/<season>/<dataMode>/` so legacy and corrected snapshots cannot overwrite each other. Include mode in report filenames and summaries.

- [ ] **Step 3: Document honest commands**

Update `README.md` with reconstructed preparation/replay commands and state that reconstructed output cannot yet verify top-10k performance because fixture announcement timing is unavailable.

- [ ] **Step 4: Verify CLI behavior**

Run: `npm test && npm run build`

Expected: existing tests and build pass. No new tests are added.

- [ ] **Step 5: Commit**

```bash
git add src/backtest/index.ts src/backtest/data-source.ts README.md
git commit -m "Isolate replay datasets by integrity mode"
```

### Task 6: Establish the Corrected Baseline

**Files:**
- Modify: `docs/superpowers/specs/2026-07-26-top-10k-improvement-program-design.md`

- [ ] **Step 1: Run full verification**

Run:

```bash
npm test
npm run build
npm run backtest:prepare -- --season=2024-2025 --data-mode=reconstructed
npm run backtest:run -- --strategy=autonomous --season=2024-2025 --data-mode=reconstructed
npm run backtest:prepare -- --season=2025-2026 --data-mode=reconstructed
npm run backtest:run -- --strategy=autonomous --season=2025-2026 --data-mode=reconstructed
```

Expected: all commands complete, reports are labeled reconstructed, and no same-GW xP source appears in snapshots or report provenance.

- [ ] **Step 2: Record baseline outcomes**

Append a short `Corrected Baseline` section to the design document with both season totals, model/data versions, and explicit limitations. Do not compare raw totals to top-10k until scoring parity and cutoff data are available.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-26-top-10k-improvement-program-design.md
git commit -m "Record leakage-safe reconstructed baseline"
```

### Task 7: Define the Next Projection and Planner Milestone

**Files:**
- Create: `docs/superpowers/plans/2026-07-26-walk-forward-planner.md`

- [ ] **Step 1: Use corrected reports to quantify losses**

Compare projection bias, captain returns, transfer frequency, chip gain, and early-season squad quality under reconstructed data. Treat the corrected score, not legacy 2,808 or 2,283, as the starting point.

- [ ] **Step 2: Write the next executable plan**

The next plan must cover walk-forward projection calibration, global initial/rebuild squad optimization, a shared six-GW planner, and counterfactual chips in that order. It must preserve the no-new-tests constraint and use untouched-season replay as the promotion gate.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-07-26-walk-forward-planner.md
git commit -m "Plan walk-forward top-10k optimizer"
```
