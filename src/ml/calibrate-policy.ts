import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BacktestEngine } from '../backtest/engine.js';
import { FileSnapshotStore } from '../backtest/snapshots.js';
import {
  createDeploymentReplayStrategy,
  type DeploymentReplayPolicy,
} from '../backtest/strategies/deployment.js';
import type { GameweekSnapshot } from '../backtest/types.js';
import { applyReplayPredictionOverlay, loadReplayPredictionOverlay } from './replay-predictions.js';

interface PolicyResult extends DeploymentReplayPolicy {
  totalPoints: number;
  grossPoints: number;
  transferHitCost: number;
  gameweeksAboveAverage: number;
  gameweeksLevelWithAverage: number;
  pointsAboveAverage: number;
}

const VALIDATION_SEASON = '2024-2025';
const HORIZONS = [1, 2, 3, 4, 6] as const;
const HIT_THRESHOLDS = [4, 8, 12, 16, 24] as const;
const MAX_CANDIDATES = 40;

export async function calibrateDeploymentPolicy(options: {
  snapshots: readonly GameweekSnapshot[];
  policies: readonly DeploymentReplayPolicy[];
}): Promise<PolicyResult[]> {
  const snapshotsByGameweek = new Map(options.snapshots.map(snapshot => [snapshot.gameweek, snapshot]));
  const averageTotal = options.snapshots.reduce(
    (total, snapshot) => total + snapshot.actualResults.averageEntryScore,
    0
  );
  const results: PolicyResult[] = [];

  for (const policy of options.policies) {
    const engine = new BacktestEngine({
      season: VALIDATION_SEASON,
      gameweeks: Array.from({ length: 38 }, (_, index) => index + 1),
      getSnapshot: async gameweek => {
        const snapshot = snapshotsByGameweek.get(gameweek);
        if (!snapshot) throw new Error(`Missing validation snapshot for GW${gameweek}`);
        return snapshot;
      },
      strategy: createDeploymentReplayStrategy(options.snapshots, policy),
    });
    const state = await engine.run();
    let above = 0;
    let level = 0;
    for (const weekly of state.weeklyResults) {
      const average = snapshotsByGameweek.get(weekly.gameweek)!.actualResults.averageEntryScore;
      if (weekly.points > average) above += 1;
      else if (weekly.points === average) level += 1;
    }
    const grossPoints = state.weeklyResults.reduce((total, weekly) => total + weekly.grossPoints, 0);
    const transferHitCost = state.weeklyResults.reduce((total, weekly) => total + weekly.transferCost, 0);
    results.push({
      ...policy,
      totalPoints: state.totalPoints,
      grossPoints,
      transferHitCost,
      gameweeksAboveAverage: above,
      gameweeksLevelWithAverage: level,
      pointsAboveAverage: state.totalPoints - averageTotal,
    });
  }

  return results.sort(comparePolicyResults);
}

function comparePolicyResults(a: PolicyResult, b: PolicyResult): number {
  return b.totalPoints - a.totalPoints
    || b.gameweeksAboveAverage - a.gameweeksAboveAverage
    || a.transferHitCost - b.transferHitCost
    || a.planningHorizonGameweeks - b.planningHorizonGameweeks
    || b.minXPGainForHit - a.minXPGainForHit;
}

async function main(): Promise<void> {
  const snapshotDirectory = process.env.FPL_ML_VALIDATION_SNAPSHOTS
    ?? join(process.cwd(), 'data/historical/2024-2025/reconstructed');
  const predictionPath = process.env.FPL_ML_REPLAY_PREDICTIONS
    ?? join(process.cwd(), 'data/ml/player-fixture-v1/validation-predictions.csv');
  const outputPath = process.env.FPL_ML_POLICY_CALIBRATION
    ?? join(process.cwd(), 'data/ml/player-fixture-v1/policy-calibration.json');
  const store = new FileSnapshotStore(snapshotDirectory, { season: VALIDATION_SEASON });
  const loaded = await Promise.all(Array.from({ length: 38 }, (_, index) => store.getSnapshot(index + 1)));
  const snapshots = applyReplayPredictionOverlay(
    loaded,
    await loadReplayPredictionOverlay(predictionPath, VALIDATION_SEASON, { exclusiveSeason: true }),
    'player-fixture-v1'
  );
  const policies = HORIZONS.flatMap(planningHorizonGameweeks => HIT_THRESHOLDS.map(minXPGainForHit => ({
    planningHorizonGameweeks,
    minXPGainForHit,
    maxCandidates: MAX_CANDIDATES,
  })));
  const results = await calibrateDeploymentPolicy({ snapshots, policies });
  const artifact = {
    protocol: {
      selected_on: VALIDATION_SEASON,
      test_season_not_loaded: '2025-2026',
      criterion: 'net season points, then gameweeks above average, then lower hit cost',
      reconstructed_not_strict: true,
    },
    grid: {
      planning_horizons: HORIZONS,
      hit_thresholds: HIT_THRESHOLDS,
      max_candidates: MAX_CANDIDATES,
    },
    selected: results[0],
    results,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({ selected: results[0], topFive: results.slice(0, 5), outputPath }, null, 2));
}

if (process.argv[1]?.endsWith('calibrate-policy.ts') || process.argv[1]?.endsWith('calibrate-policy.js')) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
