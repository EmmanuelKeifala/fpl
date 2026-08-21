import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Fixture, Player } from '../api/types.js';
import type { ExpectedPoints } from '../engine/optimizer.js';
import type { LiveSeasonConfig } from '../strategy/season.js';
import { fingerprintPlayerRoster, type LiveFeaturePlayer } from './live-features.js';

const directory = await mkdtemp(join(tmpdir(), 'fpl-ml-shadow-'));
process.env.FPL_DB_PATH = join(directory, 'shadow.db');

const { captureMlShadowForecasts } = await import('./shadow-forecasts.js');
const { getMlShadowForecastRuns } = await import('../db/client.js');

const FEATURE_NAMES = [
  'is_home',
  'gameweek_phase',
  'club_gw_match_count',
  'scoring_defensive_contributions',
  'position_gk',
  'position_def',
  'position_mid',
  'position_fwd',
];

const BASE_PLAYERS: LiveFeaturePlayer[] = [
  { id: 1, team: 1, element_type: 3 },
  { id: 2, team: 2, element_type: 2 },
];

function tree(value: number) {
  return {
    node_count: 1,
    children_left: [-1],
    children_right: [-1],
    feature_index: [-2],
    threshold: [-2],
    value: [value],
  };
}

function model(task: 'binary_classification' | 'regression', value: number) {
  return {
    task,
    link: task === 'binary_classification' ? 'sigmoid' : 'identity',
    base_score: 0,
    learning_rate: 1,
    trees: [tree(value)],
  };
}

function artifact() {
  return {
    model_version: 'player-fixture-v1',
    data_version: 'test-data-v1',
    schema_version: 'player-fixture-features-v1',
    reconstructed_not_strict: true,
    feature_names: FEATURE_NAMES,
    feature_count: FEATURE_NAMES.length,
    identity_fields_excluded: ['player_id', 'fixture_id'],
    blend_weights: { direct_weight: 0, conditional_weight: 1, selected_on: 'validation' },
    models: {
      appearance_classifier: model('binary_classification', 2),
      start_classifier: model('binary_classification', 1),
      conditional_minutes_regressor: model('regression', 80),
      conditional_points_regressor: model('regression', 5),
      direct_points_regressor: model('regression', 4),
    },
    known_limitations: ['synthetic test model'],
  };
}

function vector(home: boolean, position: 'GK' | 'DEF' | 'MID' | 'FWD'): number[] {
  return [
    Number(home),
    1 / 37,
    1,
    1,
    Number(position === 'GK'),
    Number(position === 'DEF'),
    Number(position === 'MID'),
    Number(position === 'FWD'),
  ];
}

function sidecar(players: readonly LiveFeaturePlayer[] = BASE_PLAYERS) {
  return {
    artifact_type: 'player-fixture-live-features',
    model_version: 'player-fixture-v1',
    feature_schema_version: 'player-fixture-features-v1',
    feature_builder_version: 'python-player-fixture-builder-v1',
    live_data_version: 'fpl-api-element-history-v1',
    season: '2025-2026',
    target_gameweek: 2,
    generated_at_utc: '2025-08-15T12:01:00Z',
    as_of_utc: '2025-08-15T12:00:00Z',
    deadline_utc: '2099-08-15T17:30:00Z',
    scoring_defensive_contributions: true,
    numeric_encoding: 'float64-rounded-10-significant-digits',
    feature_count: FEATURE_NAMES.length,
    feature_names: FEATURE_NAMES,
    latest_included_gameweek: 1,
    target_fixtures: [
      { id: 20, event: 2, kickoff_time: '2025-08-16T14:00:00Z', team_h: 1, team_a: 2 },
    ],
    fixture_schedule_sha256: 'a'.repeat(64),
    player_roster_sha256: fingerprintPlayerRoster(players),
    source_hashes: {
      bootstrap_static: 'b'.repeat(64),
      fixtures: 'c'.repeat(64),
      element_summaries: 'd'.repeat(64),
    },
    rows: players.map(player => {
      const position = ({ 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' } as const)[player.element_type as 1 | 2 | 3 | 4];
      return {
        fixture_id: 20,
        player_id: player.id,
        team_id: player.team,
        opponent_id: player.team === 1 ? 2 : 1,
        position,
        kickoff_time: '2025-08-16T14:00:00Z',
        features: vector(player.team === 1, position),
      };
    }),
  };
}

function fixture(): Fixture {
  return {
    code: 20,
    event: 2,
    finished: false,
    finished_provisional: false,
    id: 20,
    kickoff_time: '2025-08-16T14:00:00Z',
    minutes: 0,
    provisional_start_time: false,
    started: false,
    team_a: 2,
    team_a_score: null,
    team_h: 1,
    team_h_score: null,
    stats: [],
    team_h_difficulty: 3,
    team_a_difficulty: 3,
    pulse_id: 20,
  };
}

function heuristic(playerId: number): ExpectedPoints {
  return {
    playerId,
    playerName: `Player ${playerId}`,
    team: playerId === 1 ? 'A' : 'B',
    position: playerId === 1 ? 'MID' : 'DEF',
    nextGW: 4,
    next5GW: 4,
    confidence: 0.7,
    availability: { appearanceProbability: 0.9, startProbability: 0.8, zeroMinuteProbability: 0.1 },
    distribution: { p10: 0, p50: 4, p90: 7, haulProbability: 0.15 },
    breakdown: {
      formFactor: 1,
      fixtureFactor: 1,
      minutesFactor: 0.8,
      expectedMinutes: 72,
      rateReliability: 0.5,
      calibrationAdjustment: 0,
      setpieceFactor: 1,
      defensiveContribution: 0,
      newsMultiplier: 1,
      newsConfidence: 0,
    },
  };
}

test('ML shadow observer loads files, predicts, and persists without an execution interface', async () => {
  const modelPath = join(directory, 'model.json');
  const sidecarPath = join(directory, 'features.json');
  await writeFile(modelPath, JSON.stringify(artifact()));
  await writeFile(sidecarPath, JSON.stringify(sidecar()));
  process.env.FPL_ML_SHADOW_ENABLED = 'true';
  process.env.FPL_ML_MODEL_PATH = modelPath;
  process.env.FPL_ML_AUTO_FEATURES = 'false';
  process.env.FPL_ML_FEATURE_SIDECAR = sidecarPath;

  const players = BASE_PLAYERS as Player[];
  const engine = {
    getAllPlayers: () => players,
    getAllFixtures: () => [fixture()],
    getSeasonConfig: () => ({ season: '2025-2026' }) as LiveSeasonConfig,
    getNextDeadline: () => ({
      gameweek: 2,
      deadline: new Date('2099-08-15T17:30:00Z'),
      hoursRemaining: 5.5,
    }),
  };
  const result = await captureMlShadowForecasts({
    gameweek: 2,
    capturedAt: new Date('2025-08-15T12:05:00Z'),
    heuristicForecasts: [heuristic(1), heuristic(2)],
    engine,
  });

  assert.equal(result.status, 'completed');
  const [run] = await getMlShadowForecastRuns('2025-2026', 2);
  assert.equal(run?.status, 'completed');
  assert.equal(run?.playerCount, 2);
  assert.equal('execute' in result, false);
});

test('ML shadow auto mode regenerates a cached sidecar when player 588 is missing', async () => {
  const modelPath = join(directory, 'auto-model.json');
  const featureDirectory = join(directory, 'auto-features');
  const gameweekDirectory = join(featureDirectory, '2025-2026', 'gw-02');
  const cachedPath = join(gameweekDirectory, 'features.json');
  const generatorPath = join(directory, 'feature-generator.mjs');
  const players = [
    ...BASE_PLAYERS,
    { id: 588, team: 1, element_type: 3 },
  ] as Player[];
  const freshSidecar = sidecar(players);

  await mkdir(gameweekDirectory, { recursive: true });
  await writeFile(modelPath, JSON.stringify(artifact()));
  await writeFile(cachedPath, JSON.stringify(sidecar()));
  await writeFile(generatorPath, [
    "import { writeFile } from 'node:fs/promises';",
    "const outputIndex = process.argv.indexOf('--output');",
    "if (outputIndex < 0 || !process.argv[outputIndex + 1]) throw new Error('missing --output');",
    `await writeFile(process.argv[outputIndex + 1], ${JSON.stringify(JSON.stringify(freshSidecar))});`,
  ].join('\n'));

  const previous = new Map<string, string | undefined>();
  const env = {
    FPL_ML_SHADOW_ENABLED: 'true',
    FPL_ML_MODEL_PATH: modelPath,
    FPL_ML_AUTO_FEATURES: 'true',
    FPL_ML_FEATURE_SIDECAR: undefined,
    FPL_ML_FEATURE_DIRECTORY: featureDirectory,
    FPL_ML_PYTHON_BIN: process.execPath,
    FPL_ML_FEATURE_SCRIPT: generatorPath,
    FPL_ML_FEATURE_TIMEOUT_SECONDS: '60',
  } satisfies Record<string, string | undefined>;
  for (const [name, value] of Object.entries(env)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  try {
    const engine = {
      getAllPlayers: () => players,
      getAllFixtures: () => [fixture()],
      getSeasonConfig: () => ({ season: '2025-2026' }) as LiveSeasonConfig,
      getNextDeadline: () => ({
        gameweek: 2,
        deadline: new Date('2099-08-15T17:30:00Z'),
        hoursRemaining: 5.5,
      }),
    };
    const result = await captureMlShadowForecasts({
      gameweek: 2,
      capturedAt: new Date('2025-08-15T12:05:00Z'),
      heuristicForecasts: players.map(player => heuristic(player.id)),
      engine,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.status === 'completed' ? result.players : 0, 3);
    const regenerated = JSON.parse(await readFile(cachedPath, 'utf8')) as ReturnType<typeof sidecar>;
    assert.equal(regenerated.player_roster_sha256, fingerprintPlayerRoster(players));
    assert.ok(regenerated.rows.some(row => row.player_id === 588));
    const [run] = await getMlShadowForecastRuns('2025-2026', 2);
    assert.equal(run?.status, 'completed');
    assert.equal(run?.playerCount, 3);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
