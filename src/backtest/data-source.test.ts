import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BacktestDataSource, getDefaultBacktestCacheDir } from './data-source.js';

test('getDefaultBacktestCacheDir returns season-specific cache path', () => {
  assert.equal(getDefaultBacktestCacheDir('2024-2025'), 'data/historical/2024-2025');
});

test('BacktestDataSource writes a manifest after prepare', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fpl-data-source-'));
  try {
    const dataSource = new BacktestDataSource({
      season: '2024-2025',
      cacheDir: dir,
      sourceUrls: ['https://example.test/source.json'],
      fetchJson: async () => ({ ok: true }),
      now: () => new Date('2026-05-18T00:00:00.000Z'),
    });

    await dataSource.prepare();
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));

    assert.equal(manifest.season, '2024-2025');
    assert.deepEqual(manifest.sourceUrls, ['https://example.test/source.json']);
    assert.equal(manifest.downloadedAt, '2026-05-18T00:00:00.000Z');
    assert.equal(manifest.snapshotVersion, '2024-2025-v1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('BacktestDataSource reports dataset presence from manifest file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fpl-data-source-'));
  try {
    const dataSource = new BacktestDataSource({ season: '2024-2025', cacheDir: dir, sourceUrls: [] });
    assert.equal(await dataSource.hasPreparedDataset(), false);
    await dataSource.writeManifest(['https://example.test/source.json']);
    assert.equal(await dataSource.hasPreparedDataset(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('BacktestDataSource removes prepared status when refresh fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fpl-data-source-'));
  try {
    const dataSource = new BacktestDataSource({
      season: '2024-2025',
      cacheDir: dir,
      sourceUrls: ['https://example.test/source-1.json', 'https://example.test/source-2.json'],
      fetchJson: async (url) => {
        if (url.endsWith('source-2.json')) throw new Error('fetch failed');
        return { ok: true };
      },
    });

    await dataSource.writeManifest(['https://example.test/old-source.json']);
    await writeFile(join(dir, 'source-1.json'), JSON.stringify({ old: true }));
    await assert.rejects(() => dataSource.prepare(), /fetch failed/);

    assert.equal(await dataSource.hasPreparedDataset(), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('BacktestDataSource default fetch passes an abort signal with timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fpl-data-source-'));
  try {
    let sawAbortSignal = false;
    const dataSource = new BacktestDataSource({
      season: '2024-2025',
      cacheDir: dir,
      sourceUrls: ['data:application/json,{"ok":true}'],
      fetchTimeoutMs: 1234,
      fetchImpl: async (_url, init) => {
        sawAbortSignal = init?.signal instanceof AbortSignal;
        throw new Error('controlled fetch failure');
      },
    });

    await assert.rejects(() => dataSource.prepare(), /controlled fetch failure/);
    assert.equal(sawAbortSignal, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('BacktestDataSource writes named JSON and text sources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fpl-data-source-'));
  try {
    const dataSource = new BacktestDataSource({
      season: '2024-2025',
      cacheDir: dir,
      sourceUrls: [],
      sources: [
        { url: 'https://example.test/listing.json', fileName: 'source-listing.json', format: 'json' },
        { url: 'https://example.test/fixtures.csv', fileName: 'fixtures.csv', format: 'text' },
      ],
      fetchJson: async () => ({ ok: true }),
      fetchText: async () => 'id,event\n1,1\n',
      now: () => new Date('2026-05-19T00:00:00.000Z'),
    });

    await dataSource.prepare();

    assert.deepEqual(JSON.parse(await readFile(join(dir, 'source-listing.json'), 'utf8')), { ok: true });
    assert.equal(await readFile(join(dir, 'fixtures.csv'), 'utf8'), 'id,event\n1,1\n');
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')).sourceUrls, [
      'https://example.test/listing.json',
      'https://example.test/fixtures.csv',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('BacktestDataSource removes stale files for failed optional sources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fpl-data-source-'));
  try {
    await writeFile(join(dir, 'xp-raw-5.csv'), 'id,xP\n1,99\n');
    const dataSource = new BacktestDataSource({
      season: '2024-2025',
      cacheDir: dir,
      sourceUrls: [],
      sources: [
        { url: 'https://example.test/xP5.csv', fileName: 'xp-raw-5.csv', format: 'text', optional: true },
      ],
      fetchText: async () => {
        throw new Error('optional unavailable');
      },
    });

    await dataSource.prepare();

    await assert.rejects(() => readFile(join(dir, 'xp-raw-5.csv'), 'utf8'), (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, 'ENOENT');
      return true;
    });
    assert.equal(await dataSource.hasPreparedDataset(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
