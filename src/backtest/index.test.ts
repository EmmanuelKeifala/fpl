import { strict as assert } from 'node:assert';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { formatPrepareDataMessage, parseRunOptions, prepareDataWithDependencies } from './index.js';

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

test('parseRunOptions defaults to baseline strategy', () => {
  assert.deepEqual(parseRunOptions([]), { strategy: 'baseline' });
});

test('parseRunOptions accepts fair and oracle strategies', () => {
  assert.deepEqual(parseRunOptions(['--strategy=fair']), { strategy: 'fair' });
  assert.deepEqual(parseRunOptions(['--strategy=oracle']), { strategy: 'oracle' });
});
