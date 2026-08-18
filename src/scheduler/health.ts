import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type RunnerHealthStatus = 'starting' | 'running' | 'idle' | 'stopping' | 'error';

export interface RunnerHealth {
  pid: number;
  mode: 'shadow' | 'live';
  status: RunnerHealthStatus;
  cycleCount: number;
  startedAt: string;
  updatedAt: string;
  lastCycleStartedAt: string | null;
  lastCycleCompletedAt: string | null;
  lastError: string | null;
}

export function writeRunnerHealth(path: string, health: RunnerHealth): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(health, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function readRunnerHealth(path: string): RunnerHealth {
  const value = JSON.parse(readFileSync(path, 'utf8')) as RunnerHealth;
  if (!Number.isInteger(value.pid) || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error('Runner health file is invalid');
  }
  return value;
}

export function assessRunnerHealth(
  health: RunnerHealth,
  now = Date.now(),
  maximumAgeMs = 65 * 60_000,
  processAlive: (pid: number) => boolean = defaultProcessAlive
): { healthy: boolean; reason: string } {
  if (!processAlive(health.pid)) return { healthy: false, reason: `Runner process ${health.pid} is not alive` };
  const age = now - Date.parse(health.updatedAt);
  if (age < 0 || age > maximumAgeMs) return { healthy: false, reason: `Runner heartbeat is ${Math.round(age / 60_000)} minutes old` };
  if (health.status === 'error') return { healthy: false, reason: health.lastError ?? 'Runner reported an error' };
  if (health.status === 'stopping') return { healthy: false, reason: 'Runner is stopping' };
  return { healthy: true, reason: `Runner is ${health.status}` };
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
