import 'dotenv/config';
import { assessRunnerHealth, readRunnerHealth } from './health.js';

try {
  const path = process.env.FPL_HEALTH_PATH?.trim() || 'data/runner-health.json';
  const health = readRunnerHealth(path);
  const assessment = assessRunnerHealth(health);
  console.log(JSON.stringify({ ...assessment, health }, null, 2));
  if (!assessment.healthy) process.exitCode = 1;
} catch (error) {
  console.error('[HEALTH]', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
