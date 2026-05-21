import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createRunId, selectExperimentConfigs } from './configs.js';
import { buildExperimentSummary, formatExperimentSummary, parseExperimentOptions } from './runner.js';

test('buildExperimentSummary aggregates averages and fair deltas', () => {
  const summary = buildExperimentSummary([
    row('2023-2024', 'fair', 'fair-default', 2000),
    row('2023-2024', 'llm-news-strict', 'smoke', 2025),
    row('2024-2025', 'fair', 'fair-default', 2100),
    row('2024-2025', 'llm-news-strict', 'smoke', 2080),
  ]);

  assert.equal(summary.configs.find(config => config.configId === 'fair-default')?.averagePoints, 2050);
  assert.equal(summary.rows.find(result => result.season === '2023-2024' && result.mode === 'llm-news-strict')?.deltaVsFair, 25);
  assert.equal(summary.rows.find(result => result.season === '2024-2025' && result.mode === 'llm-news-strict')?.deltaVsFair, -20);
  assert.deepEqual(summary.rows[0]?.choiceCounts, {});
});

test('parseExperimentOptions defaults to dry safe smoke matrix', () => {
  assert.deepEqual(parseExperimentOptions([]), {
    seasons: ['2021-2022', '2022-2023', '2023-2024', '2024-2025'],
    allowLlmNews: false,
    liveNews: false,
    cacheDir: 'data/experiments',
    maxConfigs: 3,
    stochastic: false,
    runId: undefined,
  });
});

test('parseExperimentOptions accepts season list and LLM news opt in', () => {
  assert.deepEqual(parseExperimentOptions(['--seasons=2023-2024,2024-2025', '--allow-llm-news', '--live-news', '--cache-dir=/tmp/fpl-exp', '--max-configs=1']), {
    seasons: ['2023-2024', '2024-2025'],
    allowLlmNews: true,
    liveNews: true,
    cacheDir: '/tmp/fpl-exp',
    maxConfigs: 1,
    stochastic: false,
    runId: undefined,
  });
});

test('parseExperimentOptions accepts stochastic run id', () => {
  assert.deepEqual(parseExperimentOptions(['--stochastic', '--run-id=abc12345', '--max-configs=2']), {
    seasons: ['2021-2022', '2022-2023', '2023-2024', '2024-2025'],
    allowLlmNews: false,
    liveNews: false,
    cacheDir: 'data/experiments',
    maxConfigs: 2,
    stochastic: true,
    runId: 'abc12345',
  });
});

test('parseExperimentOptions keeps LLM modes enabled when limiting configs', () => {
  assert.deepEqual(parseExperimentOptions(['--allow-llm-news', '--max-configs=1']), {
    seasons: ['2021-2022', '2022-2023', '2023-2024', '2024-2025'],
    allowLlmNews: true,
    liveNews: false,
    cacheDir: 'data/experiments',
    maxConfigs: 1,
    stochastic: false,
    runId: undefined,
  });
});

test('formatExperimentSummary includes stochastic run id', () => {
  const summary = buildExperimentSummary([
    { ...row('2023-2024', 'fair', 'fair-default', 2000), runId: 'abc12345' },
  ]);

  assert.match(formatExperimentSummary(summary), /stochastic run id: abc12345/);
});

test('selectExperimentConfigs returns stable default config order', () => {
  assert.deepEqual(selectExperimentConfigs(3).map(config => config.id), ['balanced', 'aggressive', 'conservative']);
});

test('selectExperimentConfigs rejects invalid max config counts', () => {
  assert.throws(() => selectExperimentConfigs(0), /Invalid max configs/);
});

test('createRunId returns a short lowercase id', () => {
  assert.match(createRunId(), /^[a-z0-9]{8}$/);
});

function row(season: string, mode: 'fair' | 'llm-news-strict' | 'llm-news-loose', configId: string, totalPoints: number) {
  return {
    season,
    mode,
    configId,
    totalPoints,
    transfers: 0,
    chips: 0,
    captainPointsTotal: 0,
    benchPointsTotal: 0,
    warnings: [],
    model: 'test-model',
    temperature: 0,
    stochastic: false,
    choiceCounts: {},
    fallbackCount: 0,
  };
}
