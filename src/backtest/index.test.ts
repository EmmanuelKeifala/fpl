import { strict as assert } from 'node:assert';
import test from 'node:test';
import { FPL_RULES } from '../strategy/rules.js';
import { deterministicStrategy } from './index.js';
import type { BacktestPlayer, ManagerState } from './types.js';

function player(id: number, expectedPoints: number, price: number): BacktestPlayer {
  return {
    id,
    webName: `Player ${id}`,
    elementType: 3,
    team: id,
    price,
    status: 'a',
    selectedByPercent: 0,
    expectedPoints,
  };
}

function stateWithSquad(playerIds: number[]): ManagerState {
  return {
    season: '2024-2025',
    squad: playerIds.map(playerId => ({ playerId, purchasePrice: 50, sellingPrice: 50 })),
    bank: 250,
    freeTransfers: 1,
    chipsAvailable: ['wildcard', 'freehit', 'bboost', '3xc'],
    totalPoints: 0,
    weeklyResults: [],
    decisions: [],
  };
}

test('deterministicStrategy starts only owned players after GW1', async () => {
  const ownedPlayerIds = Array.from({ length: 15 }, (_, index) => index + 1);
  const decision = await deterministicStrategy()({
    state: stateWithSquad(ownedPlayerIds),
    snapshot: {
      season: '2024-2025',
      gameweek: 2,
      deadline: '2024-08-24T10:00:00Z',
      knownBeforeDeadline: {
        players: [player(99, 99, 50), ...ownedPlayerIds.map(id => player(id, id, 50))],
        fixtures: [],
        unavailableFields: [],
      },
      provenance: { sourceUrls: ['https://example.test'], downloadedAt: '2026-05-18T00:00:00.000Z', snapshotVersion: 'v1', knownLimitations: [] },
    },
  });

  const lineup = [...decision.startingXi, ...decision.bench];
  assert.equal(decision.squad, undefined);
  assert.equal(lineup.includes(99), false);
  assert.deepEqual([...lineup].sort((a, b) => a - b), ownedPlayerIds);
  assert.equal(ownedPlayerIds.includes(decision.captain), true);
  assert.equal(ownedPlayerIds.includes(decision.viceCaptain), true);
});

test('deterministicStrategy builds a GW1 squad within budget when top picks are too expensive', async () => {
  const expensivePlayers = Array.from({ length: 15 }, (_, index) => player(index + 1, 100 - index, 90));
  const cheapPlayers = Array.from({ length: 15 }, (_, index) => player(index + 16, 50 - index, 20));
  const players = [...expensivePlayers, ...cheapPlayers];
  const decision = await deterministicStrategy()({
    state: stateWithSquad([]),
    snapshot: {
      season: '2024-2025',
      gameweek: 1,
      deadline: '2024-08-16T17:30:00Z',
      knownBeforeDeadline: { players, fixtures: [], unavailableFields: [] },
      provenance: { sourceUrls: ['https://example.test'], downloadedAt: '2026-05-18T00:00:00.000Z', snapshotVersion: 'v1', knownLimitations: [] },
    },
  });

  const squad = decision.squad ?? [];
  const pricesById = new Map(players.map(candidate => [candidate.id, candidate.price]));
  const totalPrice = squad.reduce((total, playerId) => total + (pricesById.get(playerId) ?? 0), 0);

  assert.equal(squad.length, FPL_RULES.squadSize);
  assert.equal(totalPrice <= FPL_RULES.initialBudget, true);
  assert.equal(squad.some(playerId => playerId > 15), true);
});
