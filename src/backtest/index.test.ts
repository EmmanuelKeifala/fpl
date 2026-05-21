import { strict as assert } from 'node:assert';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { formatPrepareDataMessage, parseRunOptions, parseTopLevelCommand, prepareDataWithDependencies } from './index.js';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fpl-index-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('formatPrepareDataMessage says replay snapshots are prepared', () => {
  const message = formatPrepareDataMessage('data/historical/2024-2025');

  assert.match(message, /Prepared 2024-2025 replay cache/i);
  assert.match(message, /gw-1\.json through gw-38\.json/i);
  assert.doesNotMatch(message, /run-season requires gw-N\.json snapshots/i);
});

test('prepareDataWithDependencies removes manifest when normalization fails', async () => {
  await withTempDir(async dir => {
    await assert.rejects(
      () =>
        prepareDataWithDependencies({
          preparedCacheDir: dir,
          dataSource: {
            async prepare() {
              await writeFile(join(dir, 'manifest.json'), '{"prepared":true}\n');
            },
          },
          normalizeSnapshots: async () => {
            throw new Error('normalization failed');
          },
          log: () => {},
        }),
      /normalization failed/
    );

    await assert.rejects(() => access(join(dir, 'manifest.json')), { code: 'ENOENT' });
  });
});

test('parseRunOptions defaults to baseline strategy and default season', () => {
  assert.deepEqual(parseRunOptions([]), { strategy: 'baseline', season: '2024-2025' });
});

test('parseRunOptions accepts fair and oracle strategies with explicit season', () => {
  assert.deepEqual(parseRunOptions(['--strategy=fair', '--season=2023-2024']), { strategy: 'fair', season: '2023-2024' });
  assert.deepEqual(parseRunOptions(['--strategy=oracle', '--season=2023-2024']), { strategy: 'oracle', season: '2023-2024' });
});

test('parseRunOptions rejects malformed seasons', () => {
  assert.throws(() => parseRunOptions(['--season=2023-24']), /invalid season/i);
  assert.throws(() => parseRunOptions(['--season=2023-2025']), /invalid season/i);
});

test('parseTopLevelCommand accepts experiment command', () => {
  assert.equal(parseTopLevelCommand('run-experiment'), 'run-experiment');
});
