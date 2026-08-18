import { strict as assert } from 'node:assert';
import test from 'node:test';
import { assessRunnerHealth, type RunnerHealth } from './health.js';

const health: RunnerHealth = {
  pid: 123,
  mode: 'shadow',
  status: 'idle',
  cycleCount: 2,
  startedAt: '2026-08-11T12:00:00Z',
  updatedAt: '2026-08-11T12:30:00Z',
  lastCycleStartedAt: '2026-08-11T12:29:00Z',
  lastCycleCompletedAt: '2026-08-11T12:30:00Z',
  lastError: null,
};

test('runner health requires a live process and fresh heartbeat', () => {
  assert.equal(assessRunnerHealth(health, Date.parse('2026-08-11T12:31:00Z'), 5 * 60_000, () => true).healthy, true);
  assert.match(
    assessRunnerHealth(health, Date.parse('2026-08-11T13:00:00Z'), 5 * 60_000, () => true).reason,
    /heartbeat/
  );
  assert.match(
    assessRunnerHealth(health, Date.parse('2026-08-11T12:31:00Z'), 5 * 60_000, () => false).reason,
    /not alive/
  );
});
