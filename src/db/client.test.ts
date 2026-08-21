import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ExpectedPoints } from '../engine/optimizer.js';

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
  beginMutationOperation,
  getMutationOperations,
  updateMutationOperation,
  resolveMutationOperation,
  saveForecastSnapshot,
  reconcileForecastOutcomes,
} = await import('./client.js');

const decisionScope = { season: '2025-2026', managerId: 123 };

function heuristicForecast(playerId: number, points: number): ExpectedPoints {
  return {
    playerId,
    playerName: `P${playerId}`,
    team: 'TST',
    position: 'MID',
    nextGW: points,
    next5GW: points,
    confidence: 0.8,
    availability: { appearanceProbability: 0.9, startProbability: 0.85, zeroMinuteProbability: 0.1 },
    distribution: { p10: 0, p50: points, p90: points + 3, haulProbability: 0.2 },
    breakdown: {
      formFactor: 1,
      fixtureFactor: 1,
      minutesFactor: 1,
      expectedMinutes: 80,
      rateReliability: 0.5,
      calibrationAdjustment: 0,
      setpieceFactor: 1,
      defensiveContribution: 0,
      newsMultiplier: 1,
      newsConfidence: 0,
    },
  };
}

test('logDecision persists and returns camelCase decision fields', async () => {
  const created = await logDecision({
    ...decisionScope,
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

  const decisions = await getDecisions(decisionScope, 1);
  const decision = decisions.find(d => d.id === created.id);

  assert.equal(decision?.decisionType, 'transfer');
  assert.equal(decision?.expectedPoints, 6);
  assert.equal(decision?.rankBefore, 100000);
  assert.equal(decision?.hitsTaken, 1);
});

test('saveGameweekSnapshot inserts and updates camelCase snapshot fields', async () => {
  await saveGameweekSnapshot({
    season: '2025-2026',
    managerId: 123,
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
    season: '2025-2026',
    managerId: 123,
    gameweek: 2,
    totalPoints: 82,
    overallRank: 400000,
    gameweekPoints: 82,
    createdAt: new Date('2026-01-03T00:00:00Z'),
  });

  const snapshot = await getGameweekSnapshot('2025-2026', 123, 2);

  assert.equal(snapshot?.totalPoints, 82);
  assert.equal(snapshot?.overallRank, 400000);
  assert.equal(snapshot?.gameweekPoints, 82);
});

test('getPerformanceStats reads mapped camelCase decision fields', async () => {
  await logDecision({
    ...decisionScope,
    gameweek: 3,
    decisionType: 'captain',
    action: '{}',
    expectedPoints: 4,
    actualPoints: 8,
    hitsTaken: 0,
    createdAt: new Date('2026-01-04T00:00:00Z'),
  });

  const stats = await getPerformanceStats(decisionScope);

  assert.ok(stats.totalDecisions >= 1);
  assert.ok(stats.successfulDecisions >= 1);
  assert.ok(stats.averagePointsGain >= 0);
});

test('decision history is isolated by season and manager', async () => {
  const otherScope = { season: '2026-2027', managerId: 456 };
  const other = await logDecision({
    ...otherScope,
    gameweek: 1,
    decisionType: 'transfer',
    action: '{}',
    expectedPoints: 20,
    hitsTaken: 0,
    createdAt: new Date('2026-08-01T00:00:00Z'),
  });

  const current = await getDecisions(decisionScope, 1);
  const isolated = await getDecisions(otherScope, 1);

  assert.equal(current.some(decision => decision.id === other.id), false);
  assert.equal(isolated.some(decision => decision.id === other.id), true);
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

  const heuristic = await getForecastAccuracy('2025-2026', 4);
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

test('mutation operations are durable, idempotent, and block unresolved follow-up work', async () => {
  const first = await beginMutationOperation({
    operationKey: 'operation-1',
    managerId: 123,
    season: '2026-2027',
    gameweek: 1,
    kind: 'transfer',
    payloadHash: 'a'.repeat(64),
    preStateHash: 'b'.repeat(64),
  });
  assert.equal(first.duplicate, false);
  await updateMutationOperation(first.record.id, 'unknown', 'response lost');

  const duplicate = await beginMutationOperation({
    operationKey: 'operation-1',
    managerId: 123,
    season: '2026-2027',
    gameweek: 1,
    kind: 'transfer',
    payloadHash: 'a'.repeat(64),
    preStateHash: 'b'.repeat(64),
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.status, 'unknown');

  await assert.rejects(
    beginMutationOperation({
      operationKey: 'operation-2',
      managerId: 123,
      season: '2026-2027',
      gameweek: 1,
      kind: 'lineup',
      payloadHash: 'c'.repeat(64),
      preStateHash: 'd'.repeat(64),
    }),
    /unresolved/
  );
  assert.equal((await getMutationOperations(123)).length, 1);
  await resolveMutationOperation(first.record.id, 'rejected', 'Verified unchanged squad in FPL');
  assert.equal((await getMutationOperations(123))[0]?.status, 'rejected');
});

test('heuristic forecasts and reconciliation are isolated by season', async () => {
  const capturedAt = new Date('2026-08-20T12:00:00Z');
  await saveForecastSnapshot('2025-2026', 1, 1, [heuristicForecast(10, 2)], true, capturedAt);
  await saveForecastSnapshot('2026-2027', 1, 1, [heuristicForecast(10, 9)], true, capturedAt);
  assert.equal(await reconcileForecastOutcomes('2026-2027', 1, new Map([[10, 5]])), 1);
  assert.equal(await reconcileForecastOutcomes('2026-2027', 1, new Map([[10, 5]])), 0);
  const current = await getForecastAccuracy('2026-2027', 1);
  const previous = await getForecastAccuracy('2025-2026', 1);
  assert.equal(current.samples, 1);
  assert.equal(current.meanAbsoluteError, 4);
  assert.equal(previous.samples, 0);
});
