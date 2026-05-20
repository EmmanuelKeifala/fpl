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

function stateWithSquad(players: BacktestPlayer[], chipsAvailable: ManagerState['chipsAvailable'] = ['wildcard', 'freehit', 'bboost', '3xc']): ManagerState {
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
