import { readFile } from 'node:fs/promises';
import { parseCsv, requireColumns } from '../backtest/csv.js';
import type { GameweekSnapshot } from '../backtest/types.js';

export interface AggregatedReplayPrediction {
  teamId: number;
  position: 'GK' | 'DEF' | 'MID' | 'FWD';
  expectedPoints: number;
  appearanceProbability: number;
  startProbability: number;
  expectedMinutes: number;
  fixtureCount: number;
}

export type ReplayPredictionOverlay = Map<number, Map<number, AggregatedReplayPrediction>>;

const REQUIRED_COLUMNS = [
  'season',
  'target_gameweek',
  'fixture_id',
  'player_id',
  'team_id',
  'position',
  'expected_points',
  'appearance_probability',
  'start_probability',
  'expected_minutes',
];

export async function loadReplayPredictionOverlay(
  path: string,
  season: string,
  options: { exclusiveSeason?: boolean } = {}
): Promise<ReplayPredictionOverlay> {
  const rows = parseCsv(await readFile(path, 'utf8'));
  requireColumns(rows.length > 0 ? Object.keys(rows[0]!) : [], REQUIRED_COLUMNS, path);
  const fixturesByPlayer = new Map<string, Set<number>>();
  const overlay: ReplayPredictionOverlay = new Map();

  for (const row of rows) {
    if (options.exclusiveSeason && row.season !== season) {
      throw new Error(`ML prediction file for ${season} contains season ${row.season}`);
    }
    if (row.season !== season) continue;
    const gameweek = integer(row.target_gameweek, 'target_gameweek');
    const fixtureId = integer(row.fixture_id, 'fixture_id');
    const playerId = integer(row.player_id, 'player_id');
    const teamId = integer(row.team_id, 'team_id');
    const position = parsePosition(row.position);
    if (gameweek < 1 || gameweek > 38) throw new Error(`Invalid ML prediction gameweek ${gameweek}`);
    const expectedPoints = finite(row.expected_points, 'expected_points');
    const appearanceProbability = probability(row.appearance_probability, 'appearance_probability');
    const startProbability = probability(row.start_probability, 'start_probability');
    const expectedMinutes = finite(row.expected_minutes, 'expected_minutes');
    const key = `${gameweek}:${playerId}`;
    const fixtureIds = fixturesByPlayer.get(key) ?? new Set<number>();
    if (fixtureIds.has(fixtureId)) throw new Error(`Duplicate ML prediction for ${season} GW${gameweek} fixture ${fixtureId} player ${playerId}`);
    fixtureIds.add(fixtureId);
    fixturesByPlayer.set(key, fixtureIds);

    const gameweekPredictions = overlay.get(gameweek) ?? new Map<number, AggregatedReplayPrediction>();
    const current = gameweekPredictions.get(playerId) ?? {
      teamId,
      position,
      expectedPoints: 0,
      appearanceProbability: 0,
      startProbability: 0,
      expectedMinutes: 0,
      fixtureCount: 0,
    };
    if (current.teamId !== teamId || current.position !== position) {
      throw new Error(`ML prediction changes club or position within ${season} GW${gameweek} for player ${playerId}`);
    }
    gameweekPredictions.set(playerId, {
      teamId,
      position,
      expectedPoints: current.expectedPoints + Math.max(0, expectedPoints),
      appearanceProbability: 1 - (1 - current.appearanceProbability) * (1 - appearanceProbability),
      startProbability: 1 - (1 - current.startProbability) * (1 - startProbability),
      expectedMinutes: current.expectedMinutes + Math.max(0, expectedMinutes),
      fixtureCount: current.fixtureCount + 1,
    });
    overlay.set(gameweek, gameweekPredictions);
  }

  for (let gameweek = 1; gameweek <= 38; gameweek++) {
    if (!overlay.has(gameweek)) throw new Error(`ML predictions contain no ${season} rows for GW${gameweek}`);
  }
  return overlay;
}

export function applyReplayPredictionOverlay(
  snapshots: readonly GameweekSnapshot[],
  overlay: ReplayPredictionOverlay,
  modelVersion: string
): GameweekSnapshot[] {
  const limitation = `${modelVersion} uses reconstructed out-of-season player-fixture predictions`;
  return snapshots.map(snapshot => {
    const predictions = overlay.get(snapshot.gameweek);
    if (!predictions) throw new Error(`Missing ML prediction overlay for GW${snapshot.gameweek}`);
    const fixtureCountByTeam = new Map<number, number>();
    for (const fixture of snapshot.knownBeforeDeadline.fixtures) {
      fixtureCountByTeam.set(fixture.teamHome, (fixtureCountByTeam.get(fixture.teamHome) ?? 0) + 1);
      fixtureCountByTeam.set(fixture.teamAway, (fixtureCountByTeam.get(fixture.teamAway) ?? 0) + 1);
    }
    return {
      ...snapshot,
      knownBeforeDeadline: {
        ...snapshot.knownBeforeDeadline,
        players: snapshot.knownBeforeDeadline.players.map(player => {
          const candidate = predictions.get(player.id);
          const prediction = candidate
            && candidate.teamId === player.team
            && candidate.position === positionForElementType(player.elementType)
            && candidate.fixtureCount === (fixtureCountByTeam.get(player.team) ?? 0)
            ? candidate
            : undefined;
          return {
            ...player,
            expectedPoints: prediction?.expectedPoints ?? 0,
            mlPrediction: {
              modelVersion,
              appearanceProbability: prediction?.appearanceProbability ?? 0,
              startProbability: prediction?.startProbability ?? 0,
              expectedMinutes: prediction?.expectedMinutes ?? 0,
              fixtureCount: prediction?.fixtureCount ?? 0,
            },
            forecastProvenance: {
              sourceGameweek: snapshot.gameweek === 1 ? null : snapshot.gameweek - 1,
              availability: 'reconstructed' as const,
              source: prediction
                ? `${modelVersion} identity-independent out-of-season prediction`
                : `${modelVersion} current-club registry zero fallback`,
            },
          };
        }),
        unavailableFields: [...new Set([...snapshot.knownBeforeDeadline.unavailableFields, limitation])],
      },
      provenance: {
        ...snapshot.provenance,
        knownLimitations: [...new Set([...snapshot.provenance.knownLimitations, limitation])],
      },
    };
  });
}

function finite(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ML prediction ${label}: ${value}`);
  return parsed;
}

function integer(value: string | undefined, label: string): number {
  const parsed = finite(value, label);
  if (!Number.isInteger(parsed)) throw new Error(`Invalid ML prediction integer ${label}: ${value}`);
  return parsed;
}

function probability(value: string | undefined, label: string): number {
  const parsed = finite(value, label);
  if (parsed < 0 || parsed > 1) throw new Error(`Invalid ML prediction probability ${label}: ${value}`);
  return parsed;
}

function parsePosition(value: string | undefined): AggregatedReplayPrediction['position'] {
  if (value === 'GK' || value === 'DEF' || value === 'MID' || value === 'FWD') return value;
  throw new Error(`Invalid ML prediction position: ${value}`);
}

function positionForElementType(elementType: number): AggregatedReplayPrediction['position'] | undefined {
  return ({ 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' } as const)[elementType as 1 | 2 | 3 | 4];
}
