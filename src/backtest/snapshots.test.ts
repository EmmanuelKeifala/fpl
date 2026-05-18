import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileSnapshotStore, validateSnapshot } from './snapshots.js';
import type { GameweekSnapshot } from './types.js';

function validSnapshot(): GameweekSnapshot {
  return {
    season: '2024-2025',
    gameweek: 1,
    deadline: '2024-08-16T17:30:00Z',
    knownBeforeDeadline: {
      players: [
        { id: 1, webName: 'Alpha', elementType: 3, team: 1, price: 75, status: 'a', selectedByPercent: 25.4, expectedPoints: 5.2 },
        { id: 2, webName: 'Bravo', elementType: 2, team: 2, price: 55, status: 'a', selectedByPercent: 12.1, expectedPoints: 4.1 },
      ],
      fixtures: [
        { id: 10, event: 1, kickoffTime: '2024-08-17T14:00:00Z', teamHome: 1, teamAway: 2, teamHomeDifficulty: 3, teamAwayDifficulty: 4 },
      ],
      unavailableFields: ['injury-news-history'],
    },
    actualResults: {
      playerResults: [
        { playerId: 1, minutes: 90, totalPoints: 8 },
        { playerId: 2, minutes: 90, totalPoints: 2 },
      ],
      averageEntryScore: 57,
      highestScore: 118,
    },
    provenance: {
      sourceUrls: ['https://example.test/gw1.json'],
      downloadedAt: '2026-05-18T00:00:00.000Z',
      snapshotVersion: '2024-2025-v1',
      knownLimitations: ['No reliable historical injury news in fixture'],
    },
  };
}

test('validateSnapshot accepts a well-formed snapshot', () => {
  const result = validateSnapshot(validSnapshot());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateSnapshot rejects duplicate player ids and missing results', () => {
  const snapshot = validSnapshot();
  snapshot.knownBeforeDeadline.players.push({ ...snapshot.knownBeforeDeadline.players[0] });
  snapshot.actualResults.playerResults = [{ playerId: 1, minutes: 90, totalPoints: 8 }];

  const result = validateSnapshot(snapshot);

  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('Duplicate player id 1 in knownBeforeDeadline.players'));
  assert.ok(result.errors.includes('Missing actual result for player id 2'));
});

test('FileSnapshotStore loads snapshots without exposing actual results through decision input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fpl-backtest-'));
  try {
    await writeFile(join(dir, 'gw-1.json'), JSON.stringify(validSnapshot(), null, 2));
    const store = new FileSnapshotStore(dir);

    const snapshot = await store.getSnapshot(1);
    const decisionInput = store.toDecisionInput(snapshot);

    assert.equal(snapshot.actualResults.playerResults[0].totalPoints, 8);
    assert.equal('actualResults' in decisionInput, false);
    assert.equal(decisionInput.knownBeforeDeadline.players[0].expectedPoints, 5.2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
