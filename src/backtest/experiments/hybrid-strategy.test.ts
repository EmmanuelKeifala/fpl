import { strict as assert } from 'node:assert';
import test from 'node:test';
import { buildCandidateDecisions } from './candidates.js';
import { createHybridStrategy } from './hybrid-strategy.js';
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

function stateWithSquad(players: BacktestPlayer[]): ManagerState {
  return {
    season: '2024-2025',
    squad: players.map(candidate => ({ playerId: candidate.id, purchasePrice: candidate.price, sellingPrice: candidate.price })),
    bank: 100,
    freeTransfers: 1,
    chipsAvailable: ['wildcard', 'freehit', 'bboost', '3xc'],
    totalPoints: 0,
    weeklyResults: [],
    decisions: [],
  };
}

test('buildCandidateDecisions includes hold and transfer candidates', () => {
  const squad = legalSquadPlayers();
  const replacement = player(99, 12, 45, 3, 99);
  const candidates = buildCandidateDecisions({
    state: stateWithSquad(squad),
    snapshot: {
      season: '2024-2025', gameweek: 2, deadline: '2024-08-24T10:00:00Z',
      knownBeforeDeadline: { players: [...squad, replacement], fixtures: [], unavailableFields: [] },
      provenance: { sourceUrls: ['https://example.test'], downloadedAt: '2026-05-20T00:00:00.000Z', snapshotVersion: 'v1', knownLimitations: [] },
    },
  });

  assert.equal(candidates[0]?.id, 'hold');
  assert.deepEqual(candidates.map(candidate => candidate.decision.transfers), [[], [{ out: 12, in: 99 }]]);
});

test('buildCandidateDecisions creates an initial squad candidate in GW1', () => {
  const players = legalSquadPlayers();
  const candidates = buildCandidateDecisions({
    state: { ...stateWithSquad([]), bank: 1000 },
    snapshot: {
      season: '2024-2025', gameweek: 1, deadline: '2024-08-16T17:30:00Z',
      knownBeforeDeadline: { players, fixtures: [], unavailableFields: [] },
      provenance: { sourceUrls: ['https://example.test'], downloadedAt: '2026-05-20T00:00:00.000Z', snapshotVersion: 'v1', knownLimitations: [] },
    },
  });

  assert.equal(candidates[0]?.decision.squad?.length, 15);
  assert.equal(candidates[0]?.decision.startingXi.length, 11);
});

test('createHybridStrategy returns the ranker selected candidate unchanged', async () => {
  const squad = legalSquadPlayers();
  const replacement = player(99, 12, 45, 3, 99);
  const strategy = createHybridStrategy({
    ranker: async input => ({ candidateId: input.candidates[1]!.id, explanation: 'higher expected points' }),
  });
  const decision = await strategy({
    state: stateWithSquad(squad),
    snapshot: {
      season: '2024-2025', gameweek: 2, deadline: '2024-08-24T10:00:00Z',
      knownBeforeDeadline: { players: [...squad, replacement], fixtures: [], unavailableFields: [] },
      provenance: { sourceUrls: ['https://example.test'], downloadedAt: '2026-05-20T00:00:00.000Z', snapshotVersion: 'v1', knownLimitations: [] },
    },
  });

  assert.deepEqual(decision.transfers, [{ out: 12, in: 99 }]);
  assert.equal(decision.notes.includes('LLM hybrid selected: higher expected points'), true);
});
