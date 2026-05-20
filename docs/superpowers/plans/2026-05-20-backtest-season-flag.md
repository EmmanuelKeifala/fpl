# Backtest Season Flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--season=YYYY-YYYY` support to backtest prepare/run commands and use it to run 2023/24 strategy smoke tests.

**Architecture:** Keep season parsing in `src/backtest/index.ts`, where CLI parsing already lives. Derive Vaastav source URLs from the selected season and keep the existing `2024-2025` default.

**Tech Stack:** TypeScript, Node `tsx`, built-in `node:test`, existing backtest data source and normalizer.

---

### Task 1: CLI Season Option

**Files:**
- Modify: `src/backtest/index.ts`
- Modify: `src/backtest/index.test.ts`

- [ ] **Step 1: Add failing parser tests**

Add tests in `src/backtest/index.test.ts` for default season, explicit season, and invalid season.

```ts
test('parseRunOptions defaults to baseline strategy and default season', () => {
  assert.deepEqual(parseRunOptions([]), { strategy: 'baseline', season: '2024-2025' });
});

test('parseRunOptions accepts fair and oracle strategies with explicit season', () => {
  assert.deepEqual(parseRunOptions(['--strategy=fair', '--season=2023-2024']), { strategy: 'fair', season: '2023-2024' });
  assert.deepEqual(parseRunOptions(['--strategy=oracle', '--season=2023-2024']), { strategy: 'oracle', season: '2023-2024' });
});

test('parseRunOptions rejects malformed seasons', () => {
  assert.throws(() => parseRunOptions(['--season=2023-24']), /invalid season/i);
  assert.throws(() => parseRunOptions(['--season=2023-2025']), /invalid season/i);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx tsx --test src/backtest/index.test.ts`

Expected: FAIL because `parseRunOptions` does not include `season` and does not parse `--season`.

- [ ] **Step 3: Implement season parsing and Vaastav URL derivation**

In `src/backtest/index.ts`, replace hardcoded season constants with helpers:

```ts
const DEFAULT_SEASON = '2024-2025';

function parseSeason(value: string): string {
  const match = /^(\d{4})-(\d{4})$/.exec(value);
  if (!match) throw new Error(`Invalid season ${value}; expected YYYY-YYYY`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (end !== start + 1) throw new Error(`Invalid season ${value}; end year must follow start year`);
  return value;
}

function toVaastavSeasonPath(season: string): string {
  const [start, end] = season.split('-');
  return `${start}-${end.slice(2)}`;
}

function getVaastavSources(season: string): { base: string; listing: string } {
  const vaastavSeason = toVaastavSeasonPath(season);
  return {
    base: `https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data/${vaastavSeason}`,
    listing: `https://api.github.com/repos/vaastav/Fantasy-Premier-League/contents/data/${vaastavSeason}?ref=master`,
  };
}
```

Update `parseRunOptions(args)` to return `{ strategy, season }`, defaulting season to `DEFAULT_SEASON` and parsing `--season=`.

Update `prepareData`, `runSeason`, and their dependency wrappers to receive the selected season and source URLs instead of using hardcoded constants.

- [ ] **Step 4: Run focused tests**

Run: `npx tsx --test src/backtest/index.test.ts`

Expected: PASS.

- [ ] **Step 5: Build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/backtest/index.ts src/backtest/index.test.ts
git commit -m "Add backtest season CLI option"
```

### Task 2: 2023/24 Verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Run full tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 2: Run build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 3: Prepare 2023/24 cache**

Run: `FPL_BACKTEST_CACHE_DIR=/tmp/opencode/fpl-2023-2024-smoke npm run backtest:prepare -- --season=2023-2024`

Expected: prepares `gw-1.json` through `gw-38.json` for `2023-2024`.

- [ ] **Step 4: Run baseline replay**

Run: `FPL_BACKTEST_CACHE_DIR=/tmp/opencode/fpl-2023-2024-smoke npm run backtest:run -- --season=2023-2024 --strategy=baseline`

Expected: command exits 0 and summary says `Season: 2023-2024`, `Strategy: baseline`, `Gameweeks replayed: 38`.

- [ ] **Step 5: Run fair replay**

Run: `FPL_BACKTEST_CACHE_DIR=/tmp/opencode/fpl-2023-2024-smoke npm run backtest:run -- --season=2023-2024 --strategy=fair`

Expected: command exits 0 and summary says `Season: 2023-2024`, `Strategy: fair`, `Gameweeks replayed: 38`.

- [ ] **Step 6: Run oracle replay**

Run: `FPL_BACKTEST_CACHE_DIR=/tmp/opencode/fpl-2023-2024-smoke npm run backtest:run -- --season=2023-2024 --strategy=oracle`

Expected: command exits 0 and summary says `Season: 2023-2024`, `Strategy: oracle`, `Gameweeks replayed: 38`.

### Self-Review

- Spec coverage: season flag, default behavior, Vaastav path derivation, validation, tests, and 2023/24 smoke runs are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: `parseRunOptions` returns `strategy` and `season`; command wrappers consume the same shape.
