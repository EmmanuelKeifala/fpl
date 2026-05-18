import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dbDir = mkdtempSync(join(tmpdir(), 'fpl-agent-db-'));
process.env.FPL_DB_PATH = join(dbDir, 'fpl.db');

const {
  getDecisions,
  logDecision,
  saveGameweekSnapshot,
  getGameweekSnapshot,
  getPerformanceStats,
} = await import('./client.js');

test('logDecision persists and returns camelCase decision fields', async () => {
  const created = await logDecision({
    gameweek: 1,
    decisionType: 'transfer',
    action: '{}',
    reasoning: 'test decision',
    expectedPoints: 6,
    rankBefore: 100000,
    hitsTaken: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });

  assert.notEqual(created.id, undefined);

  const decisions = await getDecisions(1);
  const decision = decisions.find(d => d.id === created.id);

  assert.equal(decision?.decisionType, 'transfer');
  assert.equal(decision?.expectedPoints, 6);
  assert.equal(decision?.rankBefore, 100000);
  assert.equal(decision?.hitsTaken, 1);
});

test('saveGameweekSnapshot inserts and updates camelCase snapshot fields', async () => {
  await saveGameweekSnapshot({
    gameweek: 2,
    totalPoints: 70,
    overallRank: 500000,
    gameweekPoints: 70,
    gameweekRank: 120000,
    teamValue: 100.5,
    bank: 1.2,
    transfersMade: 1,
    transfersCost: 0,
    pointsOnBench: 8,
    captainId: 123,
    captainPoints: 20,
    createdAt: new Date('2026-01-02T00:00:00Z'),
  });

  await saveGameweekSnapshot({
    gameweek: 2,
    totalPoints: 82,
    overallRank: 400000,
    gameweekPoints: 82,
    createdAt: new Date('2026-01-03T00:00:00Z'),
  });

  const snapshot = await getGameweekSnapshot(2);

  assert.equal(snapshot?.totalPoints, 82);
  assert.equal(snapshot?.overallRank, 400000);
  assert.equal(snapshot?.gameweekPoints, 82);
});

test('getPerformanceStats reads mapped camelCase decision fields', async () => {
  await logDecision({
    gameweek: 3,
    decisionType: 'captain',
    action: '{}',
    expectedPoints: 4,
    actualPoints: 8,
    hitsTaken: 0,
    createdAt: new Date('2026-01-04T00:00:00Z'),
  });

  const stats = await getPerformanceStats();

  assert.ok(stats.totalDecisions >= 1);
  assert.ok(stats.successfulDecisions >= 1);
  assert.ok(stats.averagePointsGain >= 0);
});
