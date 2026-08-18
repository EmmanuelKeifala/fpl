import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { Fixture, Player } from '../api/types.js';
import {
  saveMlShadowForecastRun,
  type MlShadowPlayerForecastInput,
} from '../db/client.js';
import type { ExpectedPoints } from '../engine/optimizer.js';
import type { LiveSeasonConfig } from '../strategy/season.js';
import { ensureAutomaticFeatureSidecar } from './auto-features.js';
import { getMlShadowConfig } from './config.js';
import {
  predictLiveFeatureSidecar,
  validateLiveFeatureSidecar,
  type LiveFeatureSidecar,
} from './live-features.js';
import { PlayerFixturePredictor, type PlayerFixtureModelArtifact } from './predictor.js';

interface MlShadowEngineView {
  getAllPlayers(): Player[];
  getAllFixtures(): Fixture[];
  getSeasonConfig(): LiveSeasonConfig;
  getNextDeadline(): { gameweek: number; deadline: Date; hoursRemaining: number } | null;
}

export interface MlShadowCaptureInput {
  gameweek: number;
  capturedAt: Date;
  heuristicForecasts: ExpectedPoints[];
  engine: MlShadowEngineView;
}

export type MlShadowCaptureResult =
  | { status: 'disabled' }
  | { status: 'completed'; runId: number; players: number }
  | { status: 'failed'; runId: number | null; error: string };

const HEURISTIC_VERSION = 'optimizer-heuristic-v1';

export async function captureMlShadowForecasts(input: MlShadowCaptureInput): Promise<MlShadowCaptureResult> {
  const season = input.engine.getSeasonConfig().season;
  const deadline = input.engine.getNextDeadline();
  let config;
  try {
    config = getMlShadowConfig();
    if (!config.enabled) return { status: 'disabled' };
    if (!deadline || deadline.gameweek !== input.gameweek) {
      throw new Error(`No matching future deadline for ML shadow GW${input.gameweek}`);
    }
    if (input.capturedAt > deadline.deadline) throw new Error('ML shadow heuristic capture is after the deadline');

    const modelRaw = await readUtf8WithinLimit(config.modelPath!, 16 * 1024 * 1024, 'model artifact');
    const artifact = JSON.parse(modelRaw) as PlayerFixtureModelArtifact;
    const predictor = new PlayerFixturePredictor(artifact);
    const sidecarSource = config.autoGenerateFeatures
      ? await ensureAutomaticFeatureSidecar(config, predictor, {
        season,
        gameweek: input.gameweek,
        fixtures: input.engine.getAllFixtures(),
      })
      : {
        path: config.featureSidecarPath!,
        raw: await readUtf8WithinLimit(config.featureSidecarPath!, 64 * 1024 * 1024, 'feature sidecar'),
        generated: false,
      };
    const sidecarRaw = sidecarSource.raw;
    const sidecar = JSON.parse(sidecarRaw) as LiveFeatureSidecar;
    validateLiveFeatureSidecar(sidecar, predictor, {
      season,
      gameweek: input.gameweek,
      fixtures: input.engine.getAllFixtures(),
    });
    if (Date.parse(sidecar.deadline_utc) !== deadline.deadline.getTime()) {
      throw new Error('Live ML sidecar deadline differs from the optimizer deadline');
    }

    const predictions = predictLiveFeatureSidecar(sidecar, predictor);
    const playersById = new Map(input.engine.getAllPlayers().map(player => [player.id, player]));
    const targetFixtureCountByTeam = new Map<number, number>();
    for (const fixture of input.engine.getAllFixtures().filter(fixture => fixture.event === input.gameweek)) {
      targetFixtureCountByTeam.set(fixture.team_h, (targetFixtureCountByTeam.get(fixture.team_h) ?? 0) + 1);
      targetFixtureCountByTeam.set(fixture.team_a, (targetFixtureCountByTeam.get(fixture.team_a) ?? 0) + 1);
    }
    const rowsByPlayer = new Map<number, LiveFeatureSidecar['rows']>();
    for (const row of sidecar.rows) {
      rowsByPlayer.set(row.player_id, [...(rowsByPlayer.get(row.player_id) ?? []), row]);
    }
    const heuristicIds = new Set(input.heuristicForecasts.map(forecast => forecast.playerId));
    for (const playerId of predictions.keys()) {
      if (!heuristicIds.has(playerId)) throw new Error(`ML sidecar contains unknown current player ${playerId}`);
    }

    const forecasts: MlShadowPlayerForecastInput[] = input.heuristicForecasts.map(heuristic => {
      const player = playersById.get(heuristic.playerId);
      if (!player) throw new Error(`Heuristic forecast references unknown player ${heuristic.playerId}`);
      const expectedFixtureCount = targetFixtureCountByTeam.get(player.team) ?? 0;
      const prediction = predictions.get(heuristic.playerId);
      const featureRows = rowsByPlayer.get(heuristic.playerId) ?? [];
      const expectedPosition = ({ 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' } as const)[player.element_type as 1 | 2 | 3 | 4];
      if (featureRows.some(row => row.team_id !== player.team || row.position !== expectedPosition)) {
        throw new Error(`ML sidecar club or position is stale for player ${heuristic.playerId}`);
      }
      if ((prediction?.fixtureCount ?? 0) !== expectedFixtureCount) {
        throw new Error(
          `ML fixture coverage for player ${heuristic.playerId} is ${prediction?.fixtureCount ?? 0}; expected ${expectedFixtureCount}`
        );
      }
      if (!prediction) {
        return {
          playerId: heuristic.playerId,
          fixtureCount: 0,
          coverage: 'no-fixture',
          heuristicPoints: heuristic.nextGW,
          heuristicMinutesPerFixture: heuristic.breakdown.expectedMinutes,
          heuristicMinutesGameweek: 0,
          heuristicConfidence: heuristic.confidence,
          mlPoints: null,
          mlExpectedMinutes: null,
          mlAppearanceProbability: null,
          mlStartProbability: null,
          mlDirectPoints: null,
          mlConditionalPoints: null,
          mlExpectedAppearances: null,
          mlExpectedStarts: null,
          featurePayloadJson: null,
        };
      }
      return {
        playerId: heuristic.playerId,
        fixtureCount: prediction.fixtureCount,
        coverage: 'predicted',
        heuristicPoints: heuristic.nextGW,
        heuristicMinutesPerFixture: heuristic.breakdown.expectedMinutes,
        heuristicMinutesGameweek: heuristic.breakdown.expectedMinutes * prediction.fixtureCount,
        heuristicConfidence: heuristic.confidence,
        mlPoints: prediction.expectedPoints,
        mlExpectedMinutes: prediction.expectedMinutes,
        mlAppearanceProbability: prediction.appearanceProbability,
        mlStartProbability: prediction.startProbability,
        mlDirectPoints: prediction.directExpectedPoints,
        mlConditionalPoints: prediction.conditionalExpectedPoints,
        mlExpectedAppearances: prediction.expectedAppearances,
        mlExpectedStarts: prediction.expectedStarts,
        featurePayloadJson: null,
      };
    });
    const completedAt = new Date();
    if (completedAt > deadline.deadline) throw new Error('ML shadow inference completed after the deadline');
    const runId = await saveMlShadowForecastRun({
      season,
      gameweek: input.gameweek,
      deadlineAt: deadline.deadline,
      capturedAt: input.capturedAt,
      completedAt,
      horizon: 1,
      status: 'completed',
      heuristicVersion: HEURISTIC_VERSION,
      modelVersion: predictor.modelVersion,
      dataVersion: predictor.dataVersion,
      schemaVersion: predictor.schemaVersion,
      artifactSha256: sha256(modelRaw),
      featureSidecarSha256: sha256(sidecarRaw),
      featureSidecarPath: sidecarSource.path,
      featureCutoffGameweek: sidecar.latest_included_gameweek,
      error: null,
      forecasts,
    });
    console.log(`[ML SHADOW] Stored paired heuristic/ML forecasts for ${forecasts.length} players (run ${runId}).`);
    return { status: 'completed', runId, players: forecasts.length };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    console.error(`[ML SHADOW] Forecast capture failed: ${message}`);
    let runId: number | null = null;
    if (deadline && deadline.gameweek === input.gameweek && input.capturedAt <= deadline.deadline) {
      try {
        runId = await saveMlShadowForecastRun({
          season,
          gameweek: input.gameweek,
          deadlineAt: deadline.deadline,
          capturedAt: input.capturedAt,
          completedAt: new Date(),
          horizon: 1,
          status: 'failed',
          heuristicVersion: HEURISTIC_VERSION,
          modelVersion: null,
          dataVersion: null,
          schemaVersion: null,
          artifactSha256: null,
          featureSidecarSha256: null,
          featureSidecarPath: null,
          featureCutoffGameweek: null,
          error: message,
          forecasts: [],
        });
      } catch (persistenceError) {
        console.error('[ML SHADOW] Failed to persist capture error:', persistenceError);
      }
    }
    return { status: 'failed', runId, error: message };
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readUtf8WithinLimit(path: string, maxBytes: number, label: string): Promise<string> {
  const size = (await stat(path)).size;
  if (size > maxBytes) throw new Error(`ML ${label} is too large: ${size} bytes`);
  return readFile(path, 'utf8');
}
