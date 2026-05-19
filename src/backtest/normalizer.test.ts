import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeVaastavSnapshots } from './normalizer.js';
import { FileSnapshotStore } from './snapshots.js';

const fixturesCsv =
  'id,event,kickoff_time,team_h,team_a,team_h_difficulty,team_a_difficulty\n' +
  '10,1,2024-08-16T19:00:00Z,1,2,3,4\n' +
  '20,2,2024-08-24T14:00:00Z,2,1,2,5\n';

const teamsCsv = 'id,name\n1,Arsenal\n2,Chelsea\n';

function gwCsv(round: number): string {
  const kickoffTime = round === 1 ? '2024-08-16T19:00:00Z' : '2024-08-24T14:00:00Z';
  return (
    'name,position,team,xP,element,value,selected,minutes,total_points,round,kickoff_time\n' +
    `Raya,GK,Arsenal,4.5,1,55,1000000,90,6,${round},${kickoffTime}\n` +
    `Gabriel,DEF,Arsenal,4.0,2,60,900000,90,5,${round},${kickoffTime}\n` +
    `Saka,MID,Arsenal,6.5,3,100,2000000,90,8,${round},${kickoffTime}\n` +
    `Havertz,FWD,Arsenal,5.0,4,80,800000,70,4,${round},${kickoffTime}\n`
  );
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fpl-normalizer-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeBaseFiles(dir: string): Promise<void> {
  await writeFile(join(dir, 'fixtures.csv'), fixturesCsv);
  await writeFile(join(dir, 'teams.csv'), teamsCsv);
}

test('normalizeVaastavSnapshots writes valid snapshots for requested gameweeks', async () => {
  await withTempDir(async dir => {
    await writeBaseFiles(dir);
    await writeFile(join(dir, 'gw-raw-1.csv'), gwCsv(1));
    await writeFile(join(dir, 'gw-raw-2.csv'), gwCsv(2));

    await normalizeVaastavSnapshots({
      season: '2024-2025',
      cacheDir: dir,
      gameweeks: [1, 2],
      sourceUrls: ['https://example.test/vaastav'],
      downloadedAt: '2026-05-19T00:00:00.000Z',
      snapshotVersion: '2024-2025-v1',
    });

    const snapshot = await new FileSnapshotStore(dir).getSnapshot(1);

    assert.equal(snapshot.gameweek, 1);
    assert.equal(snapshot.deadline, '2024-08-16T19:00:00Z');
    assert.deepEqual(snapshot.knownBeforeDeadline.players[0], {
      id: 1,
      webName: 'Raya',
      elementType: 1,
      team: 1,
      price: 55,
      status: 'a',
      selectedByPercent: 1000000,
      expectedPoints: 4.5,
    });
    assert.deepEqual(snapshot.actualResults.playerResults.find(result => result.playerId === 3), {
      playerId: 3,
      minutes: 90,
      totalPoints: 8,
    });
    assert.ok(snapshot.provenance.knownLimitations.some(limitation => limitation.includes('exact historical deadline times unavailable')));
  });
});

test('normalizeVaastavSnapshots prefers optional xP overlay values by element', async () => {
  await withTempDir(async dir => {
    await writeBaseFiles(dir);
    await writeFile(join(dir, 'gw-raw-1.csv'), gwCsv(1));
    await writeFile(join(dir, 'xp-raw-1.csv'), 'element,xP\n1,7.25\n3,9.5\n');

    await normalizeVaastavSnapshots({
      season: '2024-2025',
      cacheDir: dir,
      gameweeks: [1],
      sourceUrls: ['https://example.test/vaastav'],
      downloadedAt: '2026-05-19T00:00:00.000Z',
      snapshotVersion: '2024-2025-v1',
    });

    const snapshot = await new FileSnapshotStore(dir).getSnapshot(1);

    assert.equal(snapshot.knownBeforeDeadline.players.find(player => player.id === 1)?.expectedPoints, 7.25);
    assert.equal(snapshot.knownBeforeDeadline.players.find(player => player.id === 2)?.expectedPoints, 4.0);
    assert.equal(snapshot.knownBeforeDeadline.players.find(player => player.id === 3)?.expectedPoints, 9.5);
  });
});

test('normalizeVaastavSnapshots rejects duplicate player ids without writing a snapshot', async () => {
  await withTempDir(async dir => {
    await writeBaseFiles(dir);
    await writeFile(
      join(dir, 'gw-raw-1.csv'),
      'name,position,team,xP,element,value,selected,minutes,total_points,round,kickoff_time\n' +
        'Raya,GK,Arsenal,4.5,1,55,1000000,90,6,1,2024-08-16T19:00:00Z\n' +
        'Raya 2,GK,Arsenal,4.5,1,55,1000000,90,6,1,2024-08-16T19:00:00Z\n'
    );

    await assert.rejects(
      () =>
        normalizeVaastavSnapshots({
          season: '2024-2025',
          cacheDir: dir,
          gameweeks: [1],
          sourceUrls: ['https://example.test/vaastav'],
          downloadedAt: '2026-05-19T00:00:00.000Z',
          snapshotVersion: '2024-2025-v1',
        }),
      /Duplicate player id 1/
    );
    assert.equal(existsSync(join(dir, 'gw-1.json')), false);
  });
});

test('normalizeVaastavSnapshots preserves existing snapshot when required columns are missing', async () => {
  await withTempDir(async dir => {
    await writeBaseFiles(dir);
    await writeFile(join(dir, 'gw-1.json'), '{"existing":true}\n');
    await writeFile(join(dir, 'gw-raw-1.csv'), 'name,position,team\nRaya,GK,Arsenal\n');

    await assert.rejects(
      () =>
        normalizeVaastavSnapshots({
          season: '2024-2025',
          cacheDir: dir,
          gameweeks: [1],
          sourceUrls: ['https://example.test/vaastav'],
          downloadedAt: '2026-05-19T00:00:00.000Z',
          snapshotVersion: '2024-2025-v1',
        }),
      /gw-raw-1.csv is missing required columns/
    );
    assert.equal(await readFile(join(dir, 'gw-1.json'), 'utf8'), '{"existing":true}\n');
  });
});
