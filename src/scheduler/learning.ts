import { getFPLClient } from '../api/client.js';
import {
  isForecastSnapshotDue,
  getForecastAccuracy,
  getMlShadowForecastAccuracy,
  reconcileMlShadowForecastOutcomes,
  reconcileForecastOutcomes,
  saveForecastSnapshot,
  saveIntelligenceObservations,
} from '../db/client.js';
import { getOptimizationEngine } from '../engine/optimizer.js';
import type { MlShadowCaptureInput } from '../ml/shadow-forecasts.js';

export async function captureLearningSnapshot(
  gameweek: number,
  forceForecast: boolean
): Promise<MlShadowCaptureInput | null> {
  const engine = await getOptimizationEngine();
  const season = engine.getSeasonConfig().season;
  const observed = await saveIntelligenceObservations(
    season,
    gameweek,
    engine.getAllPlayers(),
    engine.getAllFixtures()
  );

  if (observed.players > 0 || observed.fixtures > 0) {
    console.log(`[LEARNING] Stored ${observed.players} player and ${observed.fixtures} fixture changes.`);
  }

  const capturedAt = new Date();
  if (!await isForecastSnapshotDue(season, gameweek, 1, forceForecast, capturedAt)) return null;
  const forecasts = engine.getAllPlayers().map(player => engine.calculateExpectedPoints(player.id, 1));
  const saved = await saveForecastSnapshot(season, gameweek, 1, forecasts, forceForecast, capturedAt);
  if (saved > 0) {
    console.log(`[LEARNING] Stored ${saved} pre-deadline player forecasts for GW${gameweek}.`);
    return { gameweek, capturedAt, heuristicForecasts: forecasts, engine };
  }
  return null;
}

export async function reconcileFinishedGameweek(gameweek: number): Promise<void> {
  const live = await getFPLClient().getLiveGameweek(gameweek);
  const engine = await getOptimizationEngine();
  const season = engine.getSeasonConfig().season;
  const actualPoints = new Map(live.elements.map(element => [element.id, element.stats.total_points]));
  const updated = await reconcileForecastOutcomes(season, gameweek, actualPoints);
  console.log(`[LEARNING] Reconciled GW${gameweek} outcomes for ${updated} players.`);
  const accuracy = await getForecastAccuracy(season, gameweek);
  if (accuracy.samples > 0) {
    console.log(
      `[LEARNING] GW${gameweek} forecast MAE ${accuracy.meanAbsoluteError.toFixed(2)}, ` +
      `bias ${accuracy.bias.toFixed(2)}, RMSE ${accuracy.rootMeanSquaredError.toFixed(2)} (${accuracy.samples} players).`
    );
  }
  const actuals = new Map(live.elements.map(element => [element.id, {
    points: element.stats.total_points,
    minutes: element.stats.minutes,
    starts: element.stats.starts,
  }]));
  const mlUpdated = await reconcileMlShadowForecastOutcomes(
    season,
    gameweek,
    actuals
  );
  if (mlUpdated > 0) {
    const mlAccuracy = await getMlShadowForecastAccuracy(season, gameweek);
    console.log(
      `[ML SHADOW] GW${gameweek} ML MAE ${mlAccuracy.mlMeanAbsoluteError.toFixed(2)} vs ` +
      `heuristic ${mlAccuracy.heuristicMeanAbsoluteError.toFixed(2)} ` +
      `(${mlAccuracy.mlWins}W-${mlAccuracy.ties}D-${mlAccuracy.heuristicWins}L, ${mlAccuracy.samples} players).`
    );
  }
}
