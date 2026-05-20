import { strict as assert } from 'node:assert';
import test from 'node:test';
import { FPL_RULES } from '../../strategy/rules.js';
import { validateFormation, validateSquad } from '../../strategy/squad.js';
import { deterministicStrategy } from './baseline.js';
import type { BacktestPlayer, ManagerState } from '../types.js';

function player(id: number, expectedPoints: number, price: number, elementType = 3, team = id): BacktestPlayer {
  return {
    id,
    webName: `Player ${id}`,
    elementType,
    team,
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
  const ownedPlayers = [
    player(1, 1, 50, 1),
    player(2, 2, 50, 1),
    ...Array.from({ length: 5 }, (_, index) => player(index + 3, index + 3, 50, 2)),
    ...Array.from({ length: 5 }, (_, index) => player(index + 8, index + 8, 50, 3)),
    ...Array.from({ length: 3 }, (_, index) => player(index + 13, index + 13, 50, 4)),
  ];
  const ownedPlayerIds = ownedPlayers.map(candidate => candidate.id);
  const decision = await deterministicStrategy()({
    state: stateWithSquad(ownedPlayerIds),
    snapshot: {
      season: '2024-2025',
      gameweek: 2,
      deadline: '2024-08-24T10:00:00Z',
      knownBeforeDeadline: {
        players: [player(99, 99, 50), ...ownedPlayers],
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
  const expensivePlayers = [
    player(1, 100, 90, 1),
    player(2, 99, 90, 1),
    ...Array.from({ length: 5 }, (_, index) => player(index + 3, 98 - index, 90, 2)),
    ...Array.from({ length: 5 }, (_, index) => player(index + 8, 93 - index, 90, 3)),
    ...Array.from({ length: 3 }, (_, index) => player(index + 13, 88 - index, 90, 4)),
  ];
  const cheapPlayers = [
    player(16, 50, 20, 1),
    player(17, 49, 20, 1),
    ...Array.from({ length: 5 }, (_, index) => player(index + 18, 48 - index, 20, 2)),
    ...Array.from({ length: 5 }, (_, index) => player(index + 23, 43 - index, 20, 3)),
    ...Array.from({ length: 3 }, (_, index) => player(index + 28, 38 - index, 20, 4)),
  ];
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

test('deterministicStrategy builds a legal GW1 squad composition and respects club limits', async () => {
  const players = [
    player(1, 100, 45, 1, 1),
    player(2, 99, 45, 1, 2),
    ...Array.from({ length: 8 }, (_, index) => player(index + 3, 98 - index, 45, 2, index < 3 ? 1 : index)),
    ...Array.from({ length: 8 }, (_, index) => player(index + 11, 90 - index, 45, 3, index < 3 ? 1 : index + 3)),
    ...Array.from({ length: 4 }, (_, index) => player(index + 19, 82 - index, 45, 4, index + 9)),
  ];
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
  const playersById = new Map(players.map(candidate => [candidate.id, candidate]));
  const validation = validateSquad(squad.map(playerId => playersById.get(playerId)!), FPL_RULES.initialBudget);

  assert.deepEqual(validation.errors, []);
  assert.equal(squad.filter(playerId => playersById.get(playerId)?.team === 1).length, FPL_RULES.maxPlayersPerClub);
});

test('deterministicStrategy starts a legal formation when backup goalkeeper is highly ranked', async () => {
  const players = [
    player(1, 100, 45, 1),
    player(2, 99, 45, 1),
    ...Array.from({ length: 5 }, (_, index) => player(index + 3, 80 - index, 45, 2)),
    ...Array.from({ length: 5 }, (_, index) => player(index + 8, 70 - index, 45, 3)),
    ...Array.from({ length: 3 }, (_, index) => player(index + 13, 60 - index, 45, 4)),
  ];
  const decision = await deterministicStrategy()({
    state: stateWithSquad(players.map(candidate => candidate.id)),
    snapshot: {
      season: '2024-2025',
      gameweek: 2,
      deadline: '2024-08-24T10:00:00Z',
      knownBeforeDeadline: { players, fixtures: [], unavailableFields: [] },
      provenance: { sourceUrls: ['https://example.test'], downloadedAt: '2026-05-18T00:00:00.000Z', snapshotVersion: 'v1', knownLimitations: [] },
    },
  });

  const startingPlayers = decision.startingXi.map(playerId => players.find(candidate => candidate.id === playerId)!);
  const formation = validateFormation(startingPlayers.map(candidate => candidate.elementType));

  assert.equal(startingPlayers.filter(candidate => candidate.elementType === 1).length, 1);
  assert.deepEqual(formation.errors, []);
});
