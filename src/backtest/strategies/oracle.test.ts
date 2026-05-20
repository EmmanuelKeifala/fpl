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
