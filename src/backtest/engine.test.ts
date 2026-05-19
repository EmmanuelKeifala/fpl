import { strict as assert } from 'node:assert';
import test from 'node:test';
import { BacktestEngine } from './engine.js';
import type { BacktestDecision, GameweekSnapshot } from './types.js';

function makeSnapshot(gameweek: number, midfielderPoints: number): GameweekSnapshot {
  return {
    season: '2024-2025',
    gameweek,
    deadline: `2024-08-${15 + gameweek}T17:30:00Z`,
    knownBeforeDeadline: {
      players: [
        { id: 1, webName: 'Keeper', elementType: 1, team: 1, price: 45, status: 'a', selectedByPercent: 10, expectedPoints: 3 },
        { id: 2, webName: 'Defender', elementType: 2, team: 2, price: 55, status: 'a', selectedByPercent: 20, expectedPoints: 4 },
        { id: 3, webName: 'Midfielder', elementType: 3, team: 3, price: 95, status: 'a', selectedByPercent: 35, expectedPoints: 7 },
        { id: 4, webName: 'Forward', elementType: 4, team: 4, price: 80, status: 'a', selectedByPercent: 18, expectedPoints: 5 },
        { id: 5, webName: 'Bench', elementType: 2, team: 5, price: 40, status: 'a', selectedByPercent: 5, expectedPoints: 2 },
      ],
      fixtures: [],
      unavailableFields: [],
    },
    actualResults: {
      playerResults: [
        { playerId: 1, minutes: 90, totalPoints: 3 },
        { playerId: 2, minutes: 90, totalPoints: 6 },
        { playerId: 3, minutes: 90, totalPoints: midfielderPoints },
        { playerId: 4, minutes: 90, totalPoints: 2 },
        { playerId: 5, minutes: 90, totalPoints: 4 },
      ],
      averageEntryScore: 50,
      highestScore: 100,
    },
    provenance: { sourceUrls: ['https://example.test'], downloadedAt: '2026-05-18T00:00:00.000Z', snapshotVersion: '2024-2025-v1', knownLimitations: [] },
  };
}

test('BacktestEngine replays a miniature season', async () => {
  const engine = new BacktestEngine({
    season: '2024-2025',
    gameweeks: [1, 2],
    getSnapshot: async gameweek => makeSnapshot(gameweek, gameweek === 1 ? 10 : 12),
    strategy: async ({ snapshot }): Promise<BacktestDecision> => ({
      gameweek: snapshot.gameweek,
      squad: snapshot.gameweek === 1 ? [1, 2, 3, 4, 5] : undefined,
      transfers: [],
      startingXi: [1, 2, 3, 4],
      bench: [5],
      captain: 3,
      viceCaptain: 4,
      notes: ['deterministic test strategy'],
    }),
  });

  const result = await engine.run();

  assert.equal(result.totalPoints, 66);
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
      return {
        gameweek: 1,
        squad: [1, 2, 3, 4, 5],
        transfers: [],
        startingXi: [1, 2, 3, 4],
        bench: [5],
        captain: 3,
        viceCaptain: 4,
        notes: ['leakage guard'],
      };
    },
  });

  const result = await engine.run();
  assert.equal(result.totalPoints, 209);
});
