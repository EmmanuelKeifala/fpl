# Competitive Backtest Strategies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `baseline`, strict `fair`, and hindsight `oracle` backtest strategies so 2024/25 replay can use legal transfers/chips and compare fair performance against an oracle ceiling.

**Architecture:** Move the current deterministic strategy out of `src/backtest/index.ts` into focused strategy modules, add shared legal lineup and transfer helpers, then wire CLI strategy selection and reporting. Keep normal `BacktestEngine` point-in-time safe; oracle receives full snapshots only through an explicit separate API.

**Tech Stack:** TypeScript ESM, Node built-in test runner, existing `BacktestEngine`, `applyGameweekDecision`, `GameweekSnapshot`, `BacktestDecision`, and FPL rule helpers.

---

## File Structure

- Create `src/backtest/strategies/lineup.ts`: legal formation lineup, bench, captain, and vice helpers.
- Create `src/backtest/strategies/lineup.test.ts`: lineup helper tests.
- Create `src/backtest/strategies/baseline.ts`: current deterministic baseline strategy and GW1 squad builder moved from `index.ts`.
- Create `src/backtest/strategies/baseline.test.ts`: parity tests currently in `index.test.ts`.
- Create `src/backtest/strategies/transfers.ts`: legal transfer candidate generation and scoring helpers for fair/oracle strategies.
- Create `src/backtest/strategies/transfers.test.ts`: transfer legality and hit-threshold tests.
- Create `src/backtest/strategies/fair.ts`: strict point-in-time transfer/chip strategy.
- Create `src/backtest/strategies/fair.test.ts`: fair strategy behavior tests.
- Create `src/backtest/strategies/oracle.ts`: explicit hindsight comparator strategy factory.
- Create `src/backtest/strategies/oracle.test.ts`: oracle behavior and legality tests.
- Modify `src/backtest/report.ts`: include strategy name and aggregate captain/bench totals.
- Modify `src/backtest/report.test.ts`: report expectations.
- Modify `src/backtest/index.ts`: remove embedded deterministic strategy, add CLI `--strategy`, select baseline/fair/oracle.
- Modify `src/backtest/index.test.ts`: CLI parser/default tests and prepare-data tests only.

## Task 1: Shared Lineup Helpers

**Files:**
- Create: `src/backtest/strategies/lineup.ts`
- Create: `src/backtest/strategies/lineup.test.ts`

- [ ] **Step 1: Write failing lineup tests**

Create `src/backtest/strategies/lineup.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { validateFormation } from '../../strategy/squad.js';
import { selectCaptaincy, selectLineup } from './lineup.js';
import type { BacktestPlayer } from '../types.js';

function player(id: number, expectedPoints: number, elementType: number): BacktestPlayer {
  return { id, webName: `P${id}`, elementType, team: id, price: 50, status: 'a', selectedByPercent: 0, expectedPoints };
}

test('selectLineup chooses one goalkeeper even when both goalkeepers rank highly', () => {
  const players = [
    player(1, 12, 1), player(2, 11, 1),
    ...Array.from({ length: 5 }, (_, index) => player(index + 3, 10 - index, 2)),
    ...Array.from({ length: 5 }, (_, index) => player(index + 8, 8 - index, 3)),
    ...Array.from({ length: 3 }, (_, index) => player(index + 13, 6 - index, 4)),
  ];

  const lineup = selectLineup(players.map(candidate => candidate.id), new Map(players.map(candidate => [candidate.id, candidate])));
  const starters = lineup.startingXi.map(id => players.find(candidate => candidate.id === id)!);

  assert.equal(starters.filter(candidate => candidate.elementType === 1).length, 1);
  assert.deepEqual(validateFormation(starters.map(candidate => candidate.elementType)).errors, []);
  assert.equal(lineup.bench.length, 4);
});

test('selectCaptaincy picks the two highest projected starters', () => {
  const players = [player(1, 3, 1), player(2, 9, 2), player(3, 8, 3)];
  assert.deepEqual(selectCaptaincy([1, 2, 3], new Map(players.map(candidate => [candidate.id, candidate]))), {
    captain: 2,
    viceCaptain: 3,
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx tsx --test src/backtest/strategies/lineup.test.ts`

Expected: FAIL because `src/backtest/strategies/lineup.ts` does not exist.

- [ ] **Step 3: Implement lineup helpers**

Create `src/backtest/strategies/lineup.ts` with these exports and behavior:

```ts
import { FPL_RULES, POSITION_BY_ELEMENT_TYPE, type PositionKey } from '../../strategy/rules.js';
import type { BacktestPlayer } from '../types.js';

export interface SelectedLineup {
  startingXi: number[];
  bench: number[];
}

export interface SelectedCaptaincy {
  captain: number;
  viceCaptain: number;
}

export function selectLineup(playerIds: number[], playersById: Map<number, BacktestPlayer>): SelectedLineup {
  const players = playerIds.map(playerId => getPlayer(playerId, playersById));
  const rankedByPosition = new Map<PositionKey, BacktestPlayer[]>();
  for (const position of Object.keys(FPL_RULES.squadComposition) as PositionKey[]) {
    rankedByPosition.set(position, rankPlayers(players.filter(player => POSITION_BY_ELEMENT_TYPE[player.elementType] === position)));
  }

  let bestStartingXi: BacktestPlayer[] | undefined;
  let bestScore = -Infinity;
  const goalkeeperCount = FPL_RULES.formation.goalkeeper.min;

  for (let defenderCount = FPL_RULES.formation.defender.min; defenderCount <= FPL_RULES.formation.defender.max; defenderCount++) {
    for (let midfielderCount = FPL_RULES.formation.midfielder.min; midfielderCount <= FPL_RULES.formation.midfielder.max; midfielderCount++) {
      const forwardCount = FPL_RULES.startingSize - goalkeeperCount - defenderCount - midfielderCount;
      if (forwardCount < FPL_RULES.formation.forward.min || forwardCount > FPL_RULES.formation.forward.max) continue;
      const candidate = [
        ...topRanked(rankedByPosition, 'goalkeeper', goalkeeperCount),
        ...topRanked(rankedByPosition, 'defender', defenderCount),
        ...topRanked(rankedByPosition, 'midfielder', midfielderCount),
        ...topRanked(rankedByPosition, 'forward', forwardCount),
      ];
      if (candidate.length !== FPL_RULES.startingSize) continue;
      const orderedCandidate = rankPlayers(candidate);
      const score = scorePlayers(orderedCandidate);
      if (!bestStartingXi || score > bestScore || (score === bestScore && comparePlayerLists(orderedCandidate, bestStartingXi) < 0)) {
        bestStartingXi = orderedCandidate;
        bestScore = score;
      }
    }
  }

  if (!bestStartingXi) throw new Error('No starting XI satisfies formation rules');
  const startingIds = new Set(bestStartingXi.map(player => player.id));
  return {
    startingXi: bestStartingXi.map(player => player.id),
    bench: rankPlayerIds(playerIds.filter(playerId => !startingIds.has(playerId)), playersById),
  };
}

export function selectCaptaincy(startingXi: number[], playersById: Map<number, BacktestPlayer>): SelectedCaptaincy {
  const ranked = rankPlayerIds(startingXi, playersById);
  if (ranked.length < 2) throw new Error('Captaincy requires at least two starters');
  return { captain: ranked[0]!, viceCaptain: ranked[1]! };
}

export function rankPlayerIds(playerIds: number[], playersById: Map<number, BacktestPlayer>): number[] {
  return [...playerIds].sort((a, b) => {
    const playerA = getPlayer(a, playersById);
    const playerB = getPlayer(b, playersById);
    return playerB.expectedPoints - playerA.expectedPoints || a - b;
  });
}

export function rankPlayers(players: BacktestPlayer[]): BacktestPlayer[] {
  return [...players].sort((a, b) => b.expectedPoints - a.expectedPoints || a.id - b.id);
}

function topRanked(rankedByPosition: Map<PositionKey, BacktestPlayer[]>, position: PositionKey, count: number): BacktestPlayer[] {
  const players = rankedByPosition.get(position) ?? [];
  return players.length >= count ? players.slice(0, count) : [];
}

function scorePlayers(players: BacktestPlayer[]): number {
  return players.reduce((total, player) => total + player.expectedPoints, 0);
}

function comparePlayerLists(left: BacktestPlayer[], right: BacktestPlayer[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index]!.id !== right[index]!.id) return left[index]!.id - right[index]!.id;
  }
  return left.length - right.length;
}

function getPlayer(playerId: number, playersById: Map<number, BacktestPlayer>): BacktestPlayer {
  const player = playersById.get(playerId);
  if (!player) throw new Error(`Player ${playerId} is missing from gameweek snapshot`);
  return player;
}
```

- [ ] **Step 4: Run lineup tests**

Run: `npx tsx --test src/backtest/strategies/lineup.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/backtest/strategies/lineup.ts src/backtest/strategies/lineup.test.ts
git commit -m "Add backtest lineup helpers"
```

## Task 2: Move Baseline Strategy

**Files:**
- Create: `src/backtest/strategies/baseline.ts`
- Create: `src/backtest/strategies/baseline.test.ts`
- Modify: `src/backtest/index.ts`
- Modify: `src/backtest/index.test.ts`

- [ ] **Step 1: Move baseline tests out of index test**

Create `src/backtest/strategies/baseline.test.ts` by moving the four `deterministicStrategy` tests from `src/backtest/index.test.ts`. Update imports:

```ts
import { deterministicStrategy } from './baseline.js';
```

Keep the local `player()` and `stateWithSquad()` helpers in the new test file.

- [ ] **Step 2: Run moved tests and verify failure**

Run: `npx tsx --test src/backtest/strategies/baseline.test.ts`

Expected: FAIL because `baseline.ts` does not exist.

- [ ] **Step 3: Create baseline module**

Create `src/backtest/strategies/baseline.ts` by moving `deterministicStrategy`, `buildInitialSquad`, `minimumCostToCompleteSquad`, `countSelectedByPosition`, and `countSelectedByTeam` from `src/backtest/index.ts`. Replace embedded lineup helpers with Task 1 helpers:

```ts
import { FPL_RULES, POSITION_BY_ELEMENT_TYPE, type PositionKey } from '../../strategy/rules.js';
import type { BacktestPlayer, BacktestStrategy } from '../types.js';
import { rankPlayers, selectCaptaincy, selectLineup } from './lineup.js';

export function deterministicStrategy(): BacktestStrategy {
  return ({ state, snapshot }) => {
    const playersById = new Map(snapshot.knownBeforeDeadline.players.map(player => [player.id, player]));
    const squad = snapshot.gameweek === 1 ? buildInitialSquad(snapshot.knownBeforeDeadline.players) : undefined;
    const lineupPool = squad ?? state.squad.map(pick => pick.playerId);
    const { startingXi, bench } = selectLineup(lineupPool, playersById);
    const { captain, viceCaptain } = selectCaptaincy(startingXi, playersById);

    return {
      gameweek: snapshot.gameweek,
      squad,
      transfers: [],
      startingXi,
      bench,
      captain,
      viceCaptain,
      notes: ['Deterministic baseline strategy for replay plumbing'],
    };
  };
}
```

Also export `buildInitialSquad(players: BacktestPlayer[]): number[]` so fair/oracle strategies can reuse it. Keep the same implementation as current `src/backtest/index.ts`.

- [ ] **Step 4: Slim index imports and tests**

Modify `src/backtest/index.ts` to import and re-export baseline:

```ts
import { deterministicStrategy } from './strategies/baseline.js';
export { deterministicStrategy } from './strategies/baseline.js';
```

Delete the moved deterministic strategy helper functions from `index.ts`.

Modify `src/backtest/index.test.ts` to remove deterministic strategy tests and unused imports. Keep only prepare-data message and manifest cleanup tests.

- [ ] **Step 5: Run focused tests**

Run: `npx tsx --test src/backtest/strategies/baseline.test.ts src/backtest/index.test.ts`

Expected: PASS.

- [ ] **Step 6: Build and commit**

Run:

```bash
npm run build
```

## Task 3: Transfer Helpers

**Files:**
- Create: `src/backtest/strategies/transfers.ts`
- Create: `src/backtest/strategies/transfers.test.ts`

- [ ] **Step 1: Write failing transfer helper tests**

Create `src/backtest/strategies/transfers.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { chooseBestTransfers } from './transfers.js';
import type { BacktestPlayer, SquadPick } from '../types.js';

function player(id: number, expectedPoints: number, price: number, elementType = 3, team = id): BacktestPlayer {
  return { id, webName: `P${id}`, elementType, team, price, status: 'a', selectedByPercent: 0, expectedPoints };
}

function pick(playerId: number, price = 50): SquadPick {
  return { playerId, purchasePrice: price, sellingPrice: price };
}

test('chooseBestTransfers makes one beneficial free transfer', () => {
  const players = [
    player(1, 4, 45, 1), player(2, 4, 45, 1),
    ...Array.from({ length: 5 }, (_, index) => player(index + 3, 4, 45, 2)),
    ...Array.from({ length: 5 }, (_, index) => player(index + 8, index === 4 ? 2 : 4, 45, 3)),
    ...Array.from({ length: 3 }, (_, index) => player(index + 13, 4, 45, 4)),
    player(99, 12, 45, 3, 99),
  ];
  const squad = players.filter(candidate => candidate.id <= 15).map(candidate => pick(candidate.id));
  const result = chooseBestTransfers({ squad, bank: 0, freeTransfers: 1, players, maxCandidatesPerPosition: 10, hitThreshold: 4.5 });

  assert.deepEqual(result.transfers, [{ out: 12, in: 99 }]);
  assert.equal(result.projectedGain > 0, true);
});

test('chooseBestTransfers refuses a hit below threshold', () => {
  const players = [
    player(1, 4, 45, 1), player(2, 4, 45, 1),
    ...Array.from({ length: 5 }, (_, index) => player(index + 3, 4, 45, 2)),
    ...Array.from({ length: 5 }, (_, index) => player(index + 8, index === 4 ? 2 : 4, 45, 3)),
    ...Array.from({ length: 3 }, (_, index) => player(index + 13, 4, 45, 4)),
    player(99, 5, 45, 3, 99),
  ];
  const squad = players.filter(candidate => candidate.id <= 15).map(candidate => pick(candidate.id));
  const result = chooseBestTransfers({ squad, bank: 0, freeTransfers: 0, players, maxCandidatesPerPosition: 10, hitThreshold: 4.5 });

  assert.deepEqual(result.transfers, []);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx tsx --test src/backtest/strategies/transfers.test.ts`

Expected: FAIL because `transfers.ts` does not exist.

- [ ] **Step 3: Implement transfer helper**

Create `src/backtest/strategies/transfers.ts` with:

```ts
import { FPL_RULES, POSITION_BY_ELEMENT_TYPE } from '../../strategy/rules.js';
import { validateSquad } from '../../strategy/squad.js';
import type { BacktestPlayer, SquadPick, TransferMove } from '../types.js';

export interface TransferChoiceInput {
  squad: SquadPick[];
  bank: number;
  freeTransfers: number;
  players: BacktestPlayer[];
  maxCandidatesPerPosition: number;
  hitThreshold: number;
}

export interface TransferChoice {
  transfers: TransferMove[];
  projectedGain: number;
}

export function chooseBestTransfers(input: TransferChoiceInput): TransferChoice {
  const playersById = new Map(input.players.map(player => [player.id, player]));
  const squadIds = new Set(input.squad.map(pick => pick.playerId));
  const currentScore = scoreSquad(input.squad.map(pick => playersById.get(pick.playerId)).filter(Boolean) as BacktestPlayer[]);
  let best: TransferChoice = { transfers: [], projectedGain: 0 };

  const candidates = candidatePlayers(input.players, input.maxCandidatesPerPosition).filter(player => !squadIds.has(player.id));
  for (const outgoing of input.squad) {
    const outgoingPlayer = playersById.get(outgoing.playerId);
    if (!outgoingPlayer) continue;
    for (const incoming of candidates) {
      if (incoming.elementType !== outgoingPlayer.elementType) continue;
      const bankAfter = input.bank + outgoing.sellingPrice - incoming.price;
      if (bankAfter < 0) continue;
      const finalPlayers = input.squad
        .filter(pick => pick.playerId !== outgoing.playerId)
        .map(pick => playersById.get(pick.playerId))
        .filter(Boolean) as BacktestPlayer[];
      finalPlayers.push(incoming);
      if (!validateSquad(finalPlayers, finalPlayers.reduce((total, player) => total + player.price, bankAfter)).valid) continue;
      const gainBeforeHits = scoreSquad(finalPlayers) - currentScore;
      const hitCost = input.freeTransfers >= 1 ? 0 : FPL_RULES.hitCost;
      const projectedGain = gainBeforeHits - hitCost;
      if (projectedGain <= 0) continue;
      if (hitCost > 0 && gainBeforeHits < input.hitThreshold) continue;
      if (projectedGain > best.projectedGain || (projectedGain === best.projectedGain && incoming.id < (best.transfers[0]?.in ?? Number.POSITIVE_INFINITY))) {
        best = { transfers: [{ out: outgoing.playerId, in: incoming.id }], projectedGain };
      }
    }
  }

  return best;
}

function candidatePlayers(players: BacktestPlayer[], maxPerPosition: number): BacktestPlayer[] {
  const result: BacktestPlayer[] = [];
  for (const elementType of [1, 2, 3, 4]) {
    result.push(...players
      .filter(player => POSITION_BY_ELEMENT_TYPE[player.elementType] && player.elementType === elementType)
      .sort((a, b) => b.expectedPoints - a.expectedPoints || a.price - b.price || a.id - b.id)
      .slice(0, maxPerPosition));
  }
  return result;
}

function scoreSquad(players: BacktestPlayer[]): number {
  return players.reduce((total, player) => total + player.expectedPoints, 0);
}
```

This first helper intentionally supports one transfer only. Two-transfer evaluation can be added after fair mode is measurable.

- [ ] **Step 4: Run tests and build**

Run:

```bash
npx tsx --test src/backtest/strategies/transfers.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/backtest/strategies/transfers.ts src/backtest/strategies/transfers.test.ts
git commit -m "Add fair transfer helper"
```

## Task 4: Fair Strategy With Existing Chips

**Files:**
- Create: `src/backtest/strategies/fair.ts`
- Create: `src/backtest/strategies/fair.test.ts`

- [ ] **Step 1: Write failing fair strategy tests**

Create `src/backtest/strategies/fair.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createFairStrategy } from './fair.js';
import type { BacktestPlayer, ManagerState } from '../types.js';

function player(id: number, expectedPoints: number, price: number, elementType = 3, team = id): BacktestPlayer {
  return { id, webName: `P${id}`, elementType, team, price, status: 'a', selectedByPercent: 0, expectedPoints };
}

function legalSquadPlayers(): BacktestPlayer[] {
  return [
    player(1, 5, 45, 1), player(2, 4, 45, 1),
    ...Array.from({ length: 5 }, (_, index) => player(index + 3, 5 - index * 0.2, 45, 2)),
    ...Array.from({ length: 5 }, (_, index) => player(index + 8, 7 - index * 0.2, 45, 3)),
    ...Array.from({ length: 3 }, (_, index) => player(index + 13, 6 - index * 0.2, 45, 4)),
  ];
}

function stateWithSquad(players: BacktestPlayer[], chipsAvailable = ['wildcard', 'freehit', 'bboost', '3xc'] as const): ManagerState {
  return {
    season: '2024-2025',
    squad: players.map(candidate => ({ playerId: candidate.id, purchasePrice: candidate.price, sellingPrice: candidate.price })),
    bank: 100,
    freeTransfers: 1,
    chipsAvailable: [...chipsAvailable],
    totalPoints: 0,
    weeklyResults: [],
    decisions: [],
  };
}

test('fair strategy makes a beneficial free transfer', async () => {
  const squad = legalSquadPlayers();
  const replacement = player(99, 12, 45, 3, 99);
  const decision = await createFairStrategy()({
    state: stateWithSquad(squad),
    snapshot: {
      season: '2024-2025', gameweek: 2, deadline: '2024-08-24T10:00:00Z',
      knownBeforeDeadline: { players: [...squad, replacement], fixtures: [], unavailableFields: [] },
      provenance: { sourceUrls: ['https://example.test'], downloadedAt: '2026-05-20T00:00:00.000Z', snapshotVersion: 'v1', knownLimitations: [] },
    },
  });

  assert.deepEqual(decision.transfers, [{ out: 12, in: 99 }]);
});

test('fair strategy uses triple captain on a high captain projection', async () => {
  const squad = legalSquadPlayers();
  squad[7] = { ...squad[7]!, expectedPoints: 18 };
  const decision = await createFairStrategy({ tripleCaptainThreshold: 15 })({
    state: stateWithSquad(squad),
    snapshot: {
      season: '2024-2025', gameweek: 24, deadline: '2025-01-01T10:00:00Z',
      knownBeforeDeadline: { players: squad, fixtures: [], unavailableFields: [] },
      provenance: { sourceUrls: ['https://example.test'], downloadedAt: '2026-05-20T00:00:00.000Z', snapshotVersion: 'v1', knownLimitations: [] },
    },
  });

  assert.equal(decision.chip, '3xc');
});

test('fair strategy uses bench boost when bench projection is high', async () => {
  const squad = legalSquadPlayers().map(candidate => ({ ...candidate, expectedPoints: 7 }));
  const decision = await createFairStrategy({ benchBoostThreshold: 24 })({
    state: stateWithSquad(squad, ['wildcard', 'freehit', 'bboost']),
    snapshot: {
      season: '2024-2025', gameweek: 10, deadline: '2024-10-01T10:00:00Z',
      knownBeforeDeadline: { players: squad, fixtures: [], unavailableFields: [] },
      provenance: { sourceUrls: ['https://example.test'], downloadedAt: '2026-05-20T00:00:00.000Z', snapshotVersion: 'v1', knownLimitations: [] },
    },
  });

  assert.equal(decision.chip, 'bboost');
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx tsx --test src/backtest/strategies/fair.test.ts`

Expected: FAIL because `fair.ts` does not exist.

- [ ] **Step 3: Implement fair strategy**

Create `src/backtest/strategies/fair.ts` with these exported APIs:

```ts
import { buildInitialSquad } from './baseline.js';
import { selectCaptaincy, selectLineup } from './lineup.js';
import { chooseBestTransfers } from './transfers.js';
import type { BacktestPlayer, BacktestStrategy, ManagerState, TransferMove } from '../types.js';

export interface FairStrategyOptions {
  hitThreshold?: number;
  tripleCaptainThreshold?: number;
  benchBoostThreshold?: number;
  maxCandidatesPerPosition?: number;
}

const DEFAULT_OPTIONS = {
  hitThreshold: 4.5,
  tripleCaptainThreshold: 14,
  benchBoostThreshold: 18,
  maxCandidatesPerPosition: 12,
};

export function createFairStrategy(options: FairStrategyOptions = {}): BacktestStrategy {
  const config = { ...DEFAULT_OPTIONS, ...options };
  return ({ state, snapshot }) => {
    const playersById = new Map(snapshot.knownBeforeDeadline.players.map(player => [player.id, player]));
    const squad = snapshot.gameweek === 1 ? buildInitialSquad(snapshot.knownBeforeDeadline.players) : undefined;
    const transfers = squad ? [] : chooseBestTransfers({
      squad: state.squad,
      bank: state.bank,
      freeTransfers: state.freeTransfers,
      players: snapshot.knownBeforeDeadline.players,
      maxCandidatesPerPosition: config.maxCandidatesPerPosition,
      hitThreshold: config.hitThreshold,
    }).transfers;
    const lineupPool = applyTransferIds(squad ?? state.squad.map(pick => pick.playerId), transfers);
    const { startingXi, bench } = selectLineup(lineupPool, playersById);
    const { captain, viceCaptain } = selectCaptaincy(startingXi, playersById);
    const chip = chooseFairChip(state, startingXi, bench, captain, playersById, config);

    return {
      gameweek: snapshot.gameweek,
      squad,
      transfers,
      startingXi,
      bench,
      captain,
      viceCaptain,
      chip,
      notes: ['Fair point-in-time strategy'],
    };
  };
}

function applyTransferIds(playerIds: number[], transfers: TransferMove[]): number[] {
  let result = [...playerIds];
  for (const transfer of transfers) result = [...result.filter(playerId => playerId !== transfer.out), transfer.in];
  return result;
}

function chooseFairChip(
  state: ManagerState,
  startingXi: number[],
  bench: number[],
  captain: number,
  playersById: Map<number, BacktestPlayer>,
  config: Required<FairStrategyOptions>,
): '3xc' | 'bboost' | undefined {
  const captainProjection = playersById.get(captain)?.expectedPoints ?? 0;
  if (state.chipsAvailable.includes('3xc') && captainProjection >= config.tripleCaptainThreshold) return '3xc';
  const benchProjection = bench.reduce((total, playerId) => total + (playersById.get(playerId)?.expectedPoints ?? 0), 0);
  if (state.chipsAvailable.includes('bboost') && benchProjection >= config.benchBoostThreshold) return 'bboost';
  return undefined;
}
```

This first fair task implements transfers, Triple Captain, and Bench Boost. Wildcard/Free Hit threshold planners are Task 7 because they need one-week rebuilt squad comparison.

- [ ] **Step 4: Run fair tests**

Run: `npx tsx --test src/backtest/strategies/fair.test.ts`

Expected: PASS.

- [ ] **Step 5: Build and commit**

Run:

```bash
npm run build
git add src/backtest/strategies/fair.ts src/backtest/strategies/fair.test.ts
git commit -m "Add fair backtest strategy"
```

## Task 5: Strategy Reporting And CLI Selection

**Files:**
- Modify: `src/backtest/report.ts`
- Modify: `src/backtest/report.test.ts`
- Modify: `src/backtest/index.ts`
- Modify: `src/backtest/index.test.ts`

- [ ] **Step 1: Write failing report and CLI tests**

In `src/backtest/report.test.ts`, add assertions that `buildBacktestReport(state(), provenance, 'fair')` sets `report.strategy === 'fair'`, `report.captainPointsTotal === 14`, and `report.benchPointsTotal === 7` for the existing fixture.

In `src/backtest/index.test.ts`, add:

```ts
import { parseRunOptions } from './index.js';

test('parseRunOptions defaults to baseline strategy', () => {
  assert.deepEqual(parseRunOptions([]), { strategy: 'baseline' });
});

test('parseRunOptions accepts fair and oracle strategies', () => {
  assert.deepEqual(parseRunOptions(['--strategy=fair']), { strategy: 'fair' });
  assert.deepEqual(parseRunOptions(['--strategy=oracle']), { strategy: 'oracle' });
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npx tsx --test src/backtest/report.test.ts src/backtest/index.test.ts`

Expected: FAIL because report strategy fields and `parseRunOptions` do not exist.

- [ ] **Step 3: Update report types**

Modify `src/backtest/report.ts`:

```ts
export type BacktestStrategyName = 'baseline' | 'fair' | 'oracle';
```

Add fields to `BacktestReport`:

```ts
strategy: BacktestStrategyName;
captainPointsTotal: number;
benchPointsTotal: number;
```

Change signature:

```ts
export function buildBacktestReport(state: ManagerState, provenance: SnapshotProvenance, strategy: BacktestStrategyName = 'baseline'): BacktestReport
```

Set fields:

```ts
strategy,
captainPointsTotal: state.weeklyResults.reduce((total, result) => total + result.captainPoints, 0),
benchPointsTotal: state.weeklyResults.reduce((total, result) => total + result.benchPoints, 0),
```

Add `Strategy: ${report.strategy}` to `formatBacktestSummary`.

- [ ] **Step 4: Update CLI selection**

Modify `src/backtest/index.ts` imports:

```ts
import { deterministicStrategy } from './strategies/baseline.js';
import { createFairStrategy } from './strategies/fair.js';
import type { BacktestStrategyName } from './report.js';
```

Add:

```ts
export interface RunOptions { strategy: BacktestStrategyName; }

export function parseRunOptions(args: string[]): RunOptions {
  const strategyArg = args.find(arg => arg.startsWith('--strategy='));
  const strategy = (strategyArg?.split('=')[1] ?? 'baseline') as BacktestStrategyName;
  if (!['baseline', 'fair', 'oracle'].includes(strategy)) throw new Error(`Unknown strategy ${strategy}`);
  return { strategy };
}
```

Change `runSeason` to accept options and pick strategy:

```ts
export async function runSeason(options: RunOptions = { strategy: 'baseline' }): Promise<void> {
  const strategy = options.strategy === 'fair' ? createFairStrategy() : deterministicStrategy();
  // oracle is wired in Task 6
  if (options.strategy === 'oracle') throw new Error('Oracle strategy is not wired yet');
  // existing engine uses strategy
  const report = buildBacktestReport(state, firstSnapshot.provenance, options.strategy);
}
```

In `main()`, call:

```ts
await runSeason(parseRunOptions(process.argv.slice(3)));
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npx tsx --test src/backtest/report.test.ts src/backtest/index.test.ts
npm run build
git add src/backtest/report.ts src/backtest/report.test.ts src/backtest/index.ts src/backtest/index.test.ts
git commit -m "Add backtest strategy selection"
```

## Task 6: Oracle Strategy Comparator

**Files:**
- Create: `src/backtest/strategies/oracle.ts`
- Create: `src/backtest/strategies/oracle.test.ts`
- Modify: `src/backtest/index.ts`

- [ ] **Step 1: Write failing oracle tests**

Create `src/backtest/strategies/oracle.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createOracleStrategy } from './oracle.js';
import type { GameweekSnapshot, ManagerState } from '../types.js';

function snapshot(gameweek: number, pointsByPlayer: Record<number, number>): GameweekSnapshot {
  const players = Object.keys(pointsByPlayer).map(id => Number(id)).map(id => ({ id, webName: `P${id}`, elementType: id <= 2 ? 1 : id <= 7 ? 2 : id <= 12 ? 3 : 4, team: id, price: 45, status: 'a', selectedByPercent: 0, expectedPoints: 1 }));
  return {
    season: '2024-2025', gameweek, deadline: '2024-08-16T10:00:00Z',
    knownBeforeDeadline: { players, fixtures: [], unavailableFields: [] },
    actualResults: { playerResults: players.map(player => ({ playerId: player.id, minutes: 90, totalPoints: pointsByPlayer[player.id] ?? 0 })), averageEntryScore: 0, highestScore: 0 },
    provenance: { sourceUrls: ['https://example.test'], downloadedAt: '2026-05-20T00:00:00.000Z', snapshotVersion: 'v1', knownLimitations: [] },
  };
}

function emptyState(): ManagerState {
  return { season: '2024-2025', squad: [], bank: 1000, freeTransfers: 1, chipsAvailable: ['wildcard', 'freehit', 'bboost', '3xc'], totalPoints: 0, weeklyResults: [], decisions: [] };
}

test('oracle strategy can choose triple captain from actual result ceiling', async () => {
  const gw1 = snapshot(1, { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2, 8: 20, 9: 2, 10: 2, 11: 2, 12: 2, 13: 2, 14: 2, 15: 2 });
  const strategy = createOracleStrategy([gw1]);
  const decision = await strategy({ state: emptyState(), snapshot: gw1 });
  assert.equal(decision.chip, '3xc');
  assert.equal(decision.captain, 8);
  assert.match(decision.notes.join('\n'), /Oracle hindsight strategy/);
});
```

- [ ] **Step 2: Run oracle tests and verify failure**

Run: `npx tsx --test src/backtest/strategies/oracle.test.ts`

Expected: FAIL because `oracle.ts` does not exist.

- [ ] **Step 3: Implement oracle strategy**

Create `src/backtest/strategies/oracle.ts`:

```ts
import { buildInitialSquad } from './baseline.js';
import { selectCaptaincy, selectLineup } from './lineup.js';
import type { BacktestPlayer, BacktestStrategy, GameweekSnapshot } from '../types.js';

export function createOracleStrategy(snapshots: GameweekSnapshot[]): BacktestStrategy {
  return ({ state, snapshot }) => {
    const current = snapshots.find(candidate => candidate.gameweek === snapshot.gameweek) ?? snapshot as GameweekSnapshot;
    const actualPoints = new Map(current.actualResults.playerResults.map(result => [result.playerId, result.totalPoints]));
    const oraclePlayers = current.knownBeforeDeadline.players.map(player => ({ ...player, expectedPoints: actualPoints.get(player.id) ?? 0 }));
    const playersById = new Map(oraclePlayers.map(player => [player.id, player]));
    const squad = current.gameweek === 1 ? buildInitialSquad(oraclePlayers) : undefined;
    const lineupPool = squad ?? state.squad.map(pick => pick.playerId);
    const { startingXi, bench } = selectLineup(lineupPool, playersById);
    const { captain, viceCaptain } = selectCaptaincy(startingXi, playersById);
    const chip = state.chipsAvailable.includes('3xc') && current.gameweek >= 1 ? '3xc' : undefined;
    return { gameweek: current.gameweek, squad, transfers: [], startingXi, bench, captain, viceCaptain, chip, notes: ['Oracle hindsight strategy'] };
  };
}
```

This is a first oracle ceiling that uses hindsight for captain/chip and lineup. Full hindsight transfers can be added after this path is wired and measurable.

- [ ] **Step 4: Wire oracle CLI**

Modify `src/backtest/index.ts` to import `createOracleStrategy`. In `runSeason`, load all snapshots when `options.strategy === 'oracle'`:

```ts
const snapshots = options.strategy === 'oracle'
  ? await Promise.all(Array.from({ length: 38 }, (_, index) => store.getSnapshot(index + 1)))
  : [];
const strategy = options.strategy === 'fair'
  ? createFairStrategy()
  : options.strategy === 'oracle'
    ? createOracleStrategy(snapshots)
    : deterministicStrategy();
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npx tsx --test src/backtest/strategies/oracle.test.ts src/backtest/index.test.ts
npm run build
git add src/backtest/strategies/oracle.ts src/backtest/strategies/oracle.test.ts src/backtest/index.ts
git commit -m "Add oracle backtest strategy"
```

## Task 7: Wildcard And Free Hit Thresholds

**Files:**
- Modify: `src/backtest/strategies/fair.ts`
- Modify: `src/backtest/strategies/fair.test.ts`

- [ ] **Step 1: Add failing chip tests**

Append these tests to `src/backtest/strategies/fair.test.ts`:

```ts
test('fair strategy uses free hit when one-week squad projection clears threshold', async () => {
  const current = legalSquadPlayers().map(candidate => ({ ...candidate, expectedPoints: 2 }));
  const upgrades = [
    player(101, 9, 45, 1, 101), player(102, 8, 45, 1, 102),
    ...Array.from({ length: 5 }, (_, index) => player(index + 103, 9 - index * 0.1, 45, 2, index + 103)),
    ...Array.from({ length: 5 }, (_, index) => player(index + 108, 10 - index * 0.1, 45, 3, index + 108)),
    ...Array.from({ length: 3 }, (_, index) => player(index + 113, 9 - index * 0.1, 45, 4, index + 113)),
  ];
  const decision = await createFairStrategy({ freeHitThreshold: 20, wildcardThreshold: 999 })({
    state: stateWithSquad(current, ['freehit', 'bboost', '3xc']),
    snapshot: {
      season: '2024-2025', gameweek: 9, deadline: '2024-10-01T10:00:00Z',
      knownBeforeDeadline: { players: [...current, ...upgrades], fixtures: [], unavailableFields: [] },
      provenance: { sourceUrls: ['https://example.test'], downloadedAt: '2026-05-20T00:00:00.000Z', snapshotVersion: 'v1', knownLimitations: [] },
    },
  });

  assert.equal(decision.chip, 'freehit');
  assert.equal(decision.transfers.length, 15);
  assert.equal(decision.startingXi.some(playerId => playerId >= 101), true);
});

test('fair strategy uses wildcard when rebuilt squad projection clears threshold', async () => {
  const current = legalSquadPlayers().map(candidate => ({ ...candidate, expectedPoints: 2 }));
  const upgrades = [
    player(201, 9, 45, 1, 201), player(202, 8, 45, 1, 202),
    ...Array.from({ length: 5 }, (_, index) => player(index + 203, 9 - index * 0.1, 45, 2, index + 203)),
    ...Array.from({ length: 5 }, (_, index) => player(index + 208, 10 - index * 0.1, 45, 3, index + 208)),
    ...Array.from({ length: 3 }, (_, index) => player(index + 213, 9 - index * 0.1, 45, 4, index + 213)),
  ];
  const decision = await createFairStrategy({ wildcardThreshold: 20, freeHitThreshold: 999 })({
    state: stateWithSquad(current, ['wildcard', 'bboost', '3xc']),
    snapshot: {
      season: '2024-2025', gameweek: 12, deadline: '2024-11-01T10:00:00Z',
      knownBeforeDeadline: { players: [...current, ...upgrades], fixtures: [], unavailableFields: [] },
      provenance: { sourceUrls: ['https://example.test'], downloadedAt: '2026-05-20T00:00:00.000Z', snapshotVersion: 'v1', knownLimitations: [] },
    },
  });

  assert.equal(decision.chip, 'wildcard');
  assert.equal(decision.transfers.length, 15);
  assert.equal(decision.startingXi.some(playerId => playerId >= 201), true);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx tsx --test src/backtest/strategies/fair.test.ts`

Expected: FAIL because `freeHitThreshold` and `wildcardThreshold` are not implemented.

- [ ] **Step 3: Implement minimal threshold behavior**

Extend `FairStrategyOptions` with:

```ts
wildcardThreshold?: number;
freeHitThreshold?: number;
```

Add defaults:

```ts
wildcardThreshold: 18,
freeHitThreshold: 16,
```

Implement helper `bestProjectedSquad(players, budget)` by reusing `buildInitialSquad(players)` and scoring selected ids with current expected points. In fair strategy, before regular transfers:

- If `freehit` is available and not GW1, compare current lineup projection to rebuilt one-week lineup projection. If gain >= threshold, return decision with `chip: 'freehit'`, `transfers` replacing the full squad, and lineup from rebuilt ids.
- If `wildcard` is available and not GW1, compare current squad projection to rebuilt squad projection. If gain >= threshold, return decision with `chip: 'wildcard'`, `transfers` from current squad ids to rebuilt ids by position, and lineup from rebuilt ids.

Keep decisions legal by ensuring final squad has 15 players and no duplicate ids.

- [ ] **Step 4: Run tests and build**

Run:

```bash
npx tsx --test src/backtest/strategies/fair.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/backtest/strategies/fair.ts src/backtest/strategies/fair.test.ts
git commit -m "Add fair wildcard and free hit planning"
```

## Task 8: Full Verification And Smoke Runs

**Files:**
- No new source files expected unless fixing verification failures.

- [ ] **Step 1: Run full tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 2: Run build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 3: Run baseline replay**

Run:

```bash
FPL_BACKTEST_CACHE_DIR=/tmp/opencode/fpl-competitive-smoke npm run backtest:prepare
FPL_BACKTEST_CACHE_DIR=/tmp/opencode/fpl-competitive-smoke npm run backtest:run -- --strategy=baseline
```

Expected: baseline completes 38 GWs and remains close to the known `1634` result.

- [ ] **Step 4: Run fair replay**

Run:

```bash
FPL_BACKTEST_CACHE_DIR=/tmp/opencode/fpl-competitive-smoke npm run backtest:run -- --strategy=fair
```

Expected: fair completes 38 GWs, makes at least one transfer, plays at least Triple Captain and Bench Boost when value-positive, and beats baseline.

- [ ] **Step 5: Run oracle replay**

Run:

```bash
FPL_BACKTEST_CACHE_DIR=/tmp/opencode/fpl-competitive-smoke npm run backtest:run -- --strategy=oracle
```

Expected: oracle completes 38 GWs and reports strategy `oracle`. It should not be described as fair.

- [ ] **Step 6: Commit verification fixes only**

If code changes are required from smoke failures, commit them with a precise message. Do not commit `/tmp/opencode` data or generated cache files.

## Self-Review Notes

- Spec coverage: baseline, fair, oracle, CLI strategy selection, report strategy field, transfers, existing chips, and full smoke runs are covered.
- Scope control: Assistant Manager, rank percentile, learned models, and deep multi-week optimization remain deferred.
- TDD coverage: every new behavior has a failing test before implementation.
- Known limitation: first oracle implementation is a ceiling comparator for lineup/captain/chip and does not yet solve full-season optimal transfers; reports must label it as hindsight/oracle.
