import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCachedRanker } from './ranker.js';
import type { CandidateDecision } from './candidates.js';

const candidates = [candidate('hold', 5), candidate('best-transfer', 9)];

function candidate(id: string, projectedPoints: number): CandidateDecision {
  return {
    id,
    label: id,
    projectedPoints,
    decision: { gameweek: 1, transfers: [], startingXi: [1], bench: [], captain: 1, viceCaptain: 2, notes: [] },
  };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fpl-ranker-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function rankerInput() {
  return {
    state: { season: '2024-2025', squad: [], bank: 0, freeTransfers: 1, chipsAvailable: [], totalPoints: 0, weeklyResults: [], decisions: [] },
    snapshot: {
      season: '2024-2025', gameweek: 2, deadline: '2024-08-24T10:00:00Z',
      knownBeforeDeadline: { players: [], fixtures: [], unavailableFields: [] },
      provenance: { sourceUrls: ['https://example.test'], downloadedAt: '2026-05-20T00:00:00Z', snapshotVersion: 'v1', knownLimitations: [] },
    },
    candidates,
    news: [],
    mode: 'llm-news-strict' as const,
    configId: 'smoke',
  };
}

test('createCachedRanker reuses cached provider responses', async () => {
  await withTempDir(async cacheDir => {
    let calls = 0;
    const ranker = createCachedRanker({
      cacheDir,
      provider: async () => {
        calls++;
        return { candidateId: 'best-transfer', explanation: 'provider choice' };
      },
    });

    assert.equal((await ranker(rankerInput())).candidateId, 'best-transfer');
    assert.equal((await ranker(rankerInput())).candidateId, 'best-transfer');
    assert.equal(calls, 1);
  });
});

test('createCachedRanker falls back when provider selects invalid candidate', async () => {
  await withTempDir(async cacheDir => {
    const ranker = createCachedRanker({
      cacheDir,
      provider: async () => ({ candidateId: 'missing', explanation: 'bad choice' }),
    });

    const result = await ranker(rankerInput());

    assert.equal(result.candidateId, 'best-transfer');
    assert.match(result.explanation, /fallback/i);
  });
});

test('createCachedRanker uses deterministic no-key fallback', async () => {
  await withTempDir(async cacheDir => {
    const ranker = createCachedRanker({ cacheDir });
    const result = await ranker(rankerInput());

    assert.equal(result.candidateId, 'best-transfer');
    assert.match(result.explanation, /no llm provider/i);
  });
});
