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
    config: {
      id: 'aggressive' as const,
      promptBias: 'Prefer upside.',
      model: 'test-model',
      deterministicTemperature: 0,
      stochasticTemperature: 0.7,
      candidateCount: 6,
      allowHits: true,
      hitThreshold: 3.5,
      preferDifferentials: false,
      newsSensitivity: 'normal' as const,
    },
    temperature: 0.7,
    stochastic: true,
    runId: 'abc12345',
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

test('createCachedRanker falls back when provider fails', async () => {
  await withTempDir(async cacheDir => {
    const ranker = createCachedRanker({
      cacheDir,
      provider: async () => { throw new Error('provider unavailable'); },
    });

    const result = await ranker(rankerInput());

    assert.equal(result.candidateId, 'best-transfer');
    assert.match(result.explanation, /provider failed/i);
  });
});

test('createCachedRanker constrains OpenAI output to candidate id schema', async () => {
  await withTempDir(async cacheDir => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.OPENAI_API_KEY;
    let requestBody: any;
    process.env.OPENAI_API_KEY = 'test-key';
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        output: [{ content: [{ text: JSON.stringify({ candidateId: 'best-transfer', explanation: 'schema choice' }) }] }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const ranker = createCachedRanker({ cacheDir });
      const result = await ranker(rankerInput());

      assert.equal(result.candidateId, 'best-transfer');
      assert.equal(requestBody.model, 'test-model');
      assert.equal(requestBody.temperature, 0.7);
      assert.match(requestBody.input[0].content, /Prefer upside/);
      assert.deepEqual(requestBody.text.format.schema.properties.candidateId.enum, ['hold', 'best-transfer']);
      assert.equal(requestBody.text.format.strict, true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
    }
  });
});

test('createCachedRanker includes stochastic run id in cache identity', async () => {
  await withTempDir(async cacheDir => {
    let calls = 0;
    const ranker = createCachedRanker({
      cacheDir,
      provider: async () => {
        calls++;
        return { candidateId: 'best-transfer', explanation: `choice ${calls}` };
      },
    });

    await ranker({ ...rankerInput(), runId: 'run-one' });
    await ranker({ ...rankerInput(), runId: 'run-two' });

    assert.equal(calls, 2);
  });
});
