import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getNewsContext } from './news.js';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fpl-news-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('getNewsContext strict mode keeps only pre-deadline timestamped items', async () => {
  await withTempDir(async cacheDir => {
    const context = await getNewsContext({
      cacheDir,
      season: '2024-2025',
      gameweek: 2,
      deadline: '2024-08-24T10:00:00Z',
      mode: 'llm-news-strict',
      fetchNews: async () => ([
        { title: 'Early injury update', url: 'https://example.test/a', publisher: 'Example', publishedAt: '2024-08-23T12:00:00Z', retrievedAt: '2026-05-20T00:00:00Z' },
        { title: 'Late leak', url: 'https://example.test/b', publisher: 'Example', publishedAt: '2024-08-24T11:00:00Z', retrievedAt: '2026-05-20T00:00:00Z' },
        { title: 'Undated rumour', url: 'https://example.test/c', publisher: 'Example', retrievedAt: '2026-05-20T00:00:00Z' },
      ]),
    });

    assert.deepEqual(context.items.map(item => item.title), ['Early injury update']);
    assert.equal(context.warnings.some(warning => warning.includes('filtered')), true);
  });
});

test('getNewsContext loose mode keeps broad context and warns about fairness', async () => {
  await withTempDir(async cacheDir => {
    const context = await getNewsContext({
      cacheDir,
      season: '2024-2025',
      gameweek: 2,
      deadline: '2024-08-24T10:00:00Z',
      mode: 'llm-news-loose',
      fetchNews: async () => ([
        { title: 'Late leak', url: 'https://example.test/b', publisher: 'Example', publishedAt: '2024-08-24T11:00:00Z', retrievedAt: '2026-05-20T00:00:00Z' },
      ]),
    });

    assert.equal(context.items.length, 1);
    assert.equal(context.warnings.some(warning => warning.includes('not strictly fair')), true);
  });
});

test('getNewsContext reuses cached news after first fetch', async () => {
  await withTempDir(async cacheDir => {
    let calls = 0;
    const fetchNews = async () => {
      calls++;
      return [{ title: 'Cached update', url: 'https://example.test/a', publisher: 'Example', publishedAt: '2024-08-23T12:00:00Z', retrievedAt: '2026-05-20T00:00:00Z' }];
    };

    await getNewsContext({ cacheDir, season: '2024-2025', gameweek: 2, deadline: '2024-08-24T10:00:00Z', mode: 'llm-news-strict', fetchNews });
    await getNewsContext({ cacheDir, season: '2024-2025', gameweek: 2, deadline: '2024-08-24T10:00:00Z', mode: 'llm-news-strict', fetchNews });

    assert.equal(calls, 1);
  });
});

test('getNewsContext returns warnings when news fetch fails', async () => {
  await withTempDir(async cacheDir => {
    const context = await getNewsContext({
      cacheDir,
      season: '2024-2025',
      gameweek: 2,
      deadline: '2024-08-24T10:00:00Z',
      mode: 'llm-news-strict',
      fetchNews: async () => { throw new Error('network down'); },
    });

    assert.deepEqual(context.items, []);
    assert.equal(context.warnings.some(warning => warning.includes('network down')), true);
  });
});
