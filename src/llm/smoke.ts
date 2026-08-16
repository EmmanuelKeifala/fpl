import 'dotenv/config';
import { reviewDecisionWithLlm } from './decision-reviewer.js';

export async function runLlmSmokeCheck(): Promise<void> {
  const review = await reviewDecisionWithLlm({
    season: '2026-2027',
    gameweek: 1,
    deadline: '2099-08-21T17:30:00Z',
    kind: 'gameweek-plan',
    phase: 'plan',
    deterministicOptionId: 'monitor-only',
    options: [{
      id: 'monitor-only',
      label: 'No-op monitoring canary',
      expectedPoints: 0,
      expectedGain: 0,
      confidence: 1,
      hitCost: 0,
      details: { mutation: false, purpose: 'structured output connectivity test' },
    }],
    teamAlerts: [],
    trustedNews: [],
    safetyConstraints: { mutationsAllowed: false, syntheticCanary: true },
  });
  console.log(JSON.stringify({
    status: review.status,
    model: review.model,
    cached: review.cached,
    verdict: review.output?.verdict ?? null,
    confidence: review.output?.confidence ?? null,
    error: review.error,
  }, null, 2));
  if (review.status !== 'completed') process.exitCode = 1;
}

if (process.argv[1]?.endsWith('smoke.ts') || process.argv[1]?.endsWith('smoke.js')) {
  runLlmSmokeCheck().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
