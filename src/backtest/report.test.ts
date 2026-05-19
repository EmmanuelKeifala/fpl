import { strict as assert } from 'node:assert';
import test from 'node:test';
import { buildBacktestReport, formatBacktestSummary } from './report.js';
import type { ManagerState, SnapshotProvenance } from './types.js';

const provenance: SnapshotProvenance = {
  sourceUrls: ['https://example.test/source.json'],
  downloadedAt: '2026-05-18T00:00:00.000Z',
  snapshotVersion: '2024-2025-v1',
  knownLimitations: ['No historical injury-news cache'],
};

function state(): ManagerState {
  return {
    season: '2024-2025',
    squad: [{ playerId: 1, purchasePrice: 75, sellingPrice: 76 }],
    bank: 25,
    freeTransfers: 2,
    chipsAvailable: ['wildcard', 'freehit'],
    totalPoints: 100,
    weeklyResults: [
      { gameweek: 1, points: 60, grossPoints: 60, transferCost: 0, captainPoints: 8, benchPoints: 4, squadValue: 1000, bank: 25 },
      { gameweek: 2, points: 40, grossPoints: 44, transferCost: 4, captainPoints: 6, benchPoints: 3, chip: '3xc', squadValue: 1002, bank: 15 },
    ],
    decisions: [
      { gameweek: 1, squad: [1], transfers: [], startingXi: [1], bench: [], captain: 1, viceCaptain: 1, notes: ['start'] },
      { gameweek: 2, transfers: [{ out: 1, in: 2 }], startingXi: [2], bench: [], captain: 2, viceCaptain: 2, chip: '3xc', notes: ['attack'] },
    ],
  };
}

test('buildBacktestReport includes season metrics and provenance', () => {
  const report = buildBacktestReport(state(), provenance);

  assert.equal(report.season, '2024-2025');
  assert.equal(report.totalPoints, 100);
  assert.equal(report.estimatedRankPercentile, null);
  assert.equal(report.weekly.length, 2);
  assert.equal(report.transfers.length, 1);
  assert.deepEqual(report.chips, [{ gameweek: 2, chip: '3xc', points: 40 }]);
  assert.equal(report.provenance.snapshotVersion, '2024-2025-v1');
});

test('formatBacktestSummary renders a concise terminal summary', () => {
  const summary = formatBacktestSummary(buildBacktestReport(state(), provenance));

  assert.match(summary, /Season: 2024-2025/);
  assert.match(summary, /Total points: 100/);
  assert.match(summary, /Gameweeks replayed: 2/);
  assert.match(summary, /Squad value: 100\.2m/);
});
