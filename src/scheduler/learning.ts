import { getFPLClient } from '../api/client.js';
import {
  isForecastSnapshotDue,
  getForecastAccuracy,
  reconcileForecastOutcomes,
  saveForecastSnapshot,
  saveIntelligenceObservations,
} from '../db/client.js';
import { getOptimizationEngine } from '../engine/optimizer.js';

export async function captureLearningSnapshot(gameweek: number, forceForecast: boolean): Promise<void> {
  const engine = await getOptimizationEngine();
  const observed = await saveIntelligenceObservations(
    gameweek,
    engine.getAllPlayers(),
    engine.getAllFixtures()
  );

  if (observed.players > 0 || observed.fixtures > 0) {
    console.log(`[LEARNING] Stored ${observed.players} player and ${observed.fixtures} fixture changes.`);
  }

  if (!await isForecastSnapshotDue(gameweek, 1, forceForecast)) return;
  const forecasts = engine.getAllPlayers().map(player => engine.calculateExpectedPoints(player.id, 1));
  const saved = await saveForecastSnapshot(gameweek, 1, forecasts, forceForecast);
  if (saved > 0) console.log(`[LEARNING] Stored ${saved} pre-deadline player forecasts for GW${gameweek}.`);
}

export async function reconcileFinishedGameweek(gameweek: number): Promise<void> {
  const live = await getFPLClient().getLiveGameweek(gameweek);
  const actualPoints = new Map(live.elements.map(element => [element.id, element.stats.total_points]));
  const updated = await reconcileForecastOutcomes(gameweek, actualPoints);
  console.log(`[LEARNING] Reconciled GW${gameweek} outcomes for ${updated} players.`);
  const accuracy = await getForecastAccuracy(gameweek);
  if (accuracy.samples > 0) {
    console.log(
      `[LEARNING] GW${gameweek} forecast MAE ${accuracy.meanAbsoluteError.toFixed(2)}, ` +
      `bias ${accuracy.bias.toFixed(2)}, RMSE ${accuracy.rootMeanSquaredError.toFixed(2)} (${accuracy.samples} players).`
    );
  }
}
