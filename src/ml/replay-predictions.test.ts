import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GameweekSnapshot } from '../backtest/types.js';
import { applyReplayPredictionOverlay, loadReplayPredictionOverlay } from './replay-predictions.js';

const HEADER = [
  'season',
  'target_gameweek',
  'fixture_id',
  'player_id',
  'team_id',
  'position',
  'expected_points',
  'appearance_probability',
  'start_probability',
  'expected_minutes',
].join(',');

function row(gameweek: number, fixtureId: number, points: number, appearance: number, start: number, minutes: number): string {
  return `2025-2026,${gameweek},${fixtureId},1,1,MID,${points},${appearance},${start},${minutes}`;
}

function snapshot(): GameweekSnapshot {
  return {
    season: '2025-2026',
    gameweek: 1,
    deadline: '2025-08-15T17:30:00Z',
    knownBeforeDeadline: {
      players: [
        { id: 1, webName: 'Active', elementType: 3, team: 1, price: 75, status: 'a', selectedByPercent: 20, expectedPoints: 1, forecastProvenance: { sourceGameweek: null, availability: 'unavailable', source: 'fixture' } },
        { id: 2, webName: 'Inactive', elementType: 2, team: 2, price: 45, status: 'a', selectedByPercent: 2, expectedPoints: 6, forecastProvenance: { sourceGameweek: null, availability: 'unavailable', source: 'fixture' } },
      ],
      fixtures: [
        { id: 100, event: 1, kickoffTime: '2025-08-16T14:00:00Z', teamHome: 1, teamAway: 2, teamHomeDifficulty: 3, teamAwayDifficulty: 3 },
        { id: 999, event: 1, kickoffTime: '2025-08-18T19:00:00Z', teamHome: 3, teamAway: 1, teamHomeDifficulty: 3, teamAwayDifficulty: 3 },
      ],
      unavailableFields: [],
    },
    actualResults: {
      playerResults: [
        { playerId: 1, minutes: 90, totalPoints: 8 },
        { playerId: 2, minutes: 0, totalPoints: 0 },
      ],
      averageEntryScore: 50,
      highestScore: 100,
    },
    provenance: {
      sourceUrls: ['https://example.test'],
      downloadedAt: '2026-08-11T00:00:00Z',
      snapshotVersion: 'test-v1',
      dataMode: 'legacy',
      rulesVersion: 'test-v1',
      knownLimitations: [],
    },
  };
}

test('replay overlay aggregates double gameweeks and zeros players absent from the prediction registry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fpl-ml-predictions-'));
  try {
    const rows = Array.from({ length: 38 }, (_, index) => row(index + 1, 100 + index, 3, 0.5, 0.4, 40));
    rows.push(row(1, 999, 4, 0.5, 0.5, 50));
    const path = join(dir, 'predictions.csv');
    await writeFile(path, `${HEADER}\n${rows.join('\n')}\n`);

    const overlay = await loadReplayPredictionOverlay(path, '2025-2026');
    assert.deepEqual(overlay.get(1)?.get(1), {
      teamId: 1,
      position: 'MID',
      expectedPoints: 7,
      appearanceProbability: 0.75,
      startProbability: 0.7,
      expectedMinutes: 90,
      fixtureCount: 2,
    });

    const [result] = applyReplayPredictionOverlay([snapshot()], overlay, 'player-fixture-v1');
    assert.equal(result?.knownBeforeDeadline.players[0]?.expectedPoints, 7);
    assert.equal(result?.knownBeforeDeadline.players[0]?.mlPrediction?.fixtureCount, 2);
    assert.equal(result?.knownBeforeDeadline.players[1]?.expectedPoints, 0);
    assert.equal(result?.knownBeforeDeadline.players[1]?.mlPrediction?.appearanceProbability, 0);
    assert.match(result?.knownBeforeDeadline.players[1]?.forecastProvenance.source ?? '', /registry zero/);

    const staleClub = snapshot();
    staleClub.knownBeforeDeadline.players[0]!.team = 2;
    const [staleResult] = applyReplayPredictionOverlay([staleClub], overlay, 'player-fixture-v1');
    assert.equal(staleResult?.knownBeforeDeadline.players[0]?.expectedPoints, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
