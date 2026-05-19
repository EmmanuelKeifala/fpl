import { strict as assert } from 'node:assert';
import test from 'node:test';
import { BacktestEngine } from './engine.js';
import type { BacktestDecision, BacktestPlayer, GameweekSnapshot } from './types.js';

const LEGAL_SQUAD = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const STARTING_XI = [1, 3, 4, 5, 8, 9, 10, 11, 13, 14, 15];
const BENCH = [2, 6, 7, 12];

function player(id: number, webName: string, elementType: number, team: number, price: number, expectedPoints: number): BacktestPlayer {
  return { id, webName, elementType, team, price, status: 'a', selectedByPercent: 10, expectedPoints };
}

function makeSnapshot(gameweek: number, midfielderPoints: number): GameweekSnapshot {
  const players = [
    player(1, 'Keeper One', 1, 1, 45, 3),
    player(2, 'Keeper Two', 1, 2, 40, 2),
    player(3, 'Defender One', 2, 1, 55, 6),
    player(4, 'Defender Two', 2, 2, 50, 5),
    player(5, 'Defender Three', 2, 3, 45, 4),
    player(6, 'Defender Four', 2, 4, 45, 3),
    player(7, 'Defender Five', 2, 5, 40, 2),
    player(8, 'Midfielder One', 3, 1, 95, midfielderPoints),
    player(9, 'Midfielder Two', 3, 2, 85, 8),
    player(10, 'Midfielder Three', 3, 3, 75, 7),
    player(11, 'Midfielder Four', 3, 4, 65, 6),
    player(12, 'Midfielder Five', 3, 5, 55, 5),
    player(13, 'Forward One', 4, 6, 80, 4),
    player(14, 'Forward Two', 4, 7, 75, 3),
    player(15, 'Forward Three', 4, 8, 70, 2),
    player(16, 'Replacement Forward', 4, 9, 80, 2),
    player(17, 'Replacement Defender', 2, 10, 40, 4),
  ];

  return {
    season: '2024-2025',
    gameweek,
    deadline: `2024-08-${15 + gameweek}T17:30:00Z`,
    knownBeforeDeadline: { players, fixtures: [], unavailableFields: [] },
    actualResults: {
      playerResults: players.map(candidate => ({ playerId: candidate.id, minutes: 90, totalPoints: candidate.expectedPoints })),
      averageEntryScore: 50,
      highestScore: 100,
    },
    provenance: { sourceUrls: ['https://example.test'], downloadedAt: '2026-05-18T00:00:00.000Z', snapshotVersion: '2024-2025-v1', knownLimitations: [] },
  };
}

function decision(overrides: Partial<BacktestDecision> = {}): BacktestDecision {
  return {
    gameweek: 1,
    squad: LEGAL_SQUAD,
    transfers: [],
    startingXi: STARTING_XI,
    bench: BENCH,
    captain: 8,
    viceCaptain: 13,
    notes: [],
    ...overrides,
  };
}

test('BacktestEngine replays a miniature season', async () => {
  const engine = new BacktestEngine({
    season: '2024-2025',
    gameweeks: [1, 2],
    getSnapshot: async gameweek => makeSnapshot(gameweek, gameweek === 1 ? 10 : 12),
    strategy: async ({ snapshot }): Promise<BacktestDecision> => decision({
      gameweek: snapshot.gameweek,
      squad: snapshot.gameweek === 1 ? LEGAL_SQUAD : undefined,
      notes: ['deterministic test strategy'],
    }),
  });

  const result = await engine.run();

  assert.equal(result.totalPoints, 140);
  assert.equal(result.weeklyResults.length, 2);
  assert.equal(result.decisions.length, 2);
});

test('BacktestEngine strategy context does not expose actualResults', async () => {
  const engine = new BacktestEngine({
    season: '2024-2025',
    gameweeks: [1],
    getSnapshot: async () => makeSnapshot(1, 99),
    strategy: async ({ snapshot }): Promise<BacktestDecision> => {
      assert.equal('actualResults' in snapshot, false);
      return decision({ notes: ['leakage guard'] });
    },
  });

  const result = await engine.run();
  assert.equal(result.totalPoints, 246);
});

test('BacktestEngine isolates decision snapshot mutations from scoring state', async () => {
  const engine = new BacktestEngine({
    season: '2024-2025',
    gameweeks: [1],
    getSnapshot: async () => makeSnapshot(1, 10),
    strategy: async ({ snapshot }): Promise<BacktestDecision> => {
      snapshot.knownBeforeDeadline.players[7].price = 995;
      return decision({ notes: ['mutates snapshot price'] });
    },
  });

  const result = await engine.run();
  assert.equal(result.totalPoints, 68);
  assert.equal(result.bank, 80);
});

test('BacktestEngine isolates strategy state mutations from transfer-hit accounting', async () => {
  const engine = new BacktestEngine({
    season: '2024-2025',
    gameweeks: [1, 2],
    getSnapshot: async gameweek => makeSnapshot(gameweek, gameweek === 1 ? 10 : 12),
    strategy: async ({ state, snapshot }): Promise<BacktestDecision> => {
      if (snapshot.gameweek === 2) {
        state.freeTransfers = 99;
        return decision({
          gameweek: 2,
          squad: undefined,
          transfers: [
            { out: 13, in: 16 },
            { out: 7, in: 17 },
          ],
          startingXi: [1, 3, 4, 5, 8, 9, 10, 11, 16, 14, 15],
          bench: [2, 6, 17, 12],
          viceCaptain: 16,
          notes: ['mutates free transfers'],
        });
      }

      return decision({ notes: ['initial squad'] });
    },
  });

  const result = await engine.run();
  assert.equal(result.totalPoints, 134);
  assert.equal(result.weeklyResults[1].transferCost, 4);
});
