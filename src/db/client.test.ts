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
  getForecastAccuracy,
  getMlShadowForecastAccuracy,
  getMlShadowForecastRuns,
  reconcileMlShadowForecastOutcomes,
  saveMlShadowForecastRun,
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

test('ML shadow forecasts persist separately, reconcile, and do not contaminate heuristic calibration', async () => {
  const runId = await saveMlShadowForecastRun({
    season: '2025-2026',
    gameweek: 4,
    deadlineAt: new Date('2025-09-12T17:30:00Z'),
    capturedAt: new Date('2025-09-12T12:00:00Z'),
    completedAt: new Date('2025-09-12T12:01:00Z'),
    horizon: 1,
    status: 'completed',
    heuristicVersion: 'heuristic-v1',
    modelVersion: 'player-fixture-v1',
    dataVersion: 'historical-gw-raw-v1',
    schemaVersion: 'player-fixture-features-v1',
    artifactSha256: 'a'.repeat(64),
    featureSidecarSha256: 'b'.repeat(64),
    featureSidecarPath: '/features/gw-4.json',
    featureCutoffGameweek: 3,
    error: null,
    forecasts: [
      {
        playerId: 101,
        fixtureCount: 1,
        coverage: 'predicted',
        heuristicPoints: 7,
        heuristicMinutesPerFixture: 80,
        heuristicMinutesGameweek: 80,
        heuristicConfidence: 0.8,
        mlPoints: 5,
        mlExpectedMinutes: 70,
        mlAppearanceProbability: 0.9,
        mlStartProbability: 0.8,
        mlDirectPoints: 5.2,
        mlConditionalPoints: 5,
        mlExpectedAppearances: 0.9,
        mlExpectedStarts: 0.8,
        featurePayloadJson: '{"fixtures":[]}',
      },
      {
        playerId: 102,
        fixtureCount: 0,
        coverage: 'no-fixture',
        heuristicPoints: 0,
        heuristicMinutesPerFixture: 75,
        heuristicMinutesGameweek: 0,
        heuristicConfidence: 0.7,
        mlPoints: null,
        mlExpectedMinutes: null,
        mlAppearanceProbability: null,
        mlStartProbability: null,
        mlDirectPoints: null,
        mlConditionalPoints: null,
        mlExpectedAppearances: null,
        mlExpectedStarts: null,
        featurePayloadJson: null,
      },
    ],
  });
  assert.ok(runId > 0);
  const [run] = await getMlShadowForecastRuns('2025-2026', 4);
  assert.equal(run?.status, 'completed');
  assert.equal(run?.playerCount, 2);
  assert.equal(run?.completedAt?.toISOString(), '2025-09-12T12:01:00.000Z');

  const updated = await reconcileMlShadowForecastOutcomes('2025-2026', 4, new Map([
    [101, { points: 4, minutes: 90, starts: 1 }],
    [102, { points: 0, minutes: 0, starts: 0 }],
  ]));
  assert.equal(updated, 2);
  const shadow = await getMlShadowForecastAccuracy('2025-2026', 4);
  assert.equal(shadow.samples, 1);
  assert.equal(shadow.heuristicMeanAbsoluteError, 3);
  assert.equal(shadow.mlMeanAbsoluteError, 1);
  assert.equal(shadow.mlWins, 1);

  const heuristic = await getForecastAccuracy(4);
  assert.equal(heuristic.samples, 0);
});

test('failed ML shadow runs store errors without player forecasts', async () => {
  const runId = await saveMlShadowForecastRun({
    season: '2025-2026',
    gameweek: 5,
    deadlineAt: new Date('2025-09-19T17:30:00Z'),
    capturedAt: new Date('2025-09-19T12:00:00Z'),
    completedAt: new Date('2025-09-20T12:01:00Z'),
    horizon: 1,
    status: 'failed',
    heuristicVersion: 'heuristic-v1',
    modelVersion: null,
    dataVersion: null,
    schemaVersion: null,
    artifactSha256: null,
    featureSidecarSha256: null,
    featureSidecarPath: null,
    featureCutoffGameweek: null,
    error: 'sidecar unavailable',
    forecasts: [],
  });
  const [run] = await getMlShadowForecastRuns('2025-2026', 5);
  assert.equal(run?.id, runId);
  assert.equal(run?.status, 'failed');
  assert.equal(run?.playerCount, 0);
  assert.equal(run?.error, 'sidecar unavailable');
});
