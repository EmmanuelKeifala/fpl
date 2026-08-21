import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Fixture } from '../api/types.js';
import type { MlShadowConfig } from './config.js';
import { ensureAutomaticFeatureSidecar } from './auto-features.js';
import {
  fingerprintPlayerRoster,
  type LiveFeaturePlayer,
  type LiveFeaturePredictor,
  type LiveFeatureSidecar,
} from './live-features.js';

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
const CURRENT_PLAYERS: LiveFeaturePlayer[] = [
  ...BASE_PLAYERS,
  { id: 3, team: 1, element_type: 4 },
];

const predictor: LiveFeaturePredictor = {
  modelVersion: 'player-fixture-v1',
  schemaVersion: 'player-fixture-features-v1',
  featureNames: FEATURE_NAMES,
  predictVector: () => ({
    expectedPoints: 3,
    appearanceProbability: 0.8,
    startProbability: 0.7,
    expectedMinutes: 60,
    directExpectedPoints: 3,
    conditionalExpectedPoints: 3,
  }),
};

function fixture(kickoff = '2025-08-16T14:00:00Z'): Fixture {
  return {
    code: 20,
    event: 2,
    finished: false,
    finished_provisional: false,
    id: 20,
    kickoff_time: kickoff,
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

function vector(home: boolean, position: 'DEF' | 'MID'): number[] {
  return [Number(home), 1 / 37, 1, 1, 0, Number(position === 'DEF'), Number(position === 'MID'), 0];
}

function sidecar(
  kickoff = '2025-08-16T14:00:00Z',
  players: readonly LiveFeaturePlayer[] = BASE_PLAYERS
): LiveFeatureSidecar {
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
    target_fixtures: [{ id: 20, event: 2, kickoff_time: kickoff, team_h: 1, team_a: 2 }],
    fixture_schedule_sha256: 'a'.repeat(64),
    player_roster_sha256: fingerprintPlayerRoster(players),
    source_hashes: {
      bootstrap_static: 'b'.repeat(64),
      fixtures: 'c'.repeat(64),
      element_summaries: 'd'.repeat(64),
    },
    rows: [
      { fixture_id: 20, player_id: 1, team_id: 1, opponent_id: 2, position: 'MID', kickoff_time: kickoff, features: vector(true, 'MID') },
      { fixture_id: 20, player_id: 2, team_id: 2, opponent_id: 1, position: 'DEF', kickoff_time: kickoff, features: vector(false, 'DEF') },
    ],
  };
}

function config(featureDirectory: string): MlShadowConfig {
  return {
    enabled: true,
    modelPath: '/model.json',
    featureSidecarPath: null,
    autoGenerateFeatures: true,
    featureDirectory,
    pythonBinary: 'python3',
    featureScriptPath: '/scripts/live_features.py',
    generationTimeoutMs: 60_000,
  };
}

test('automatic ML features are reused only while the fixture schedule and player roster match', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fpl-auto-features-'));
  let generated = 0;
  let generatedKickoff = '2025-08-16T14:00:00Z';
  let includeNewPlayer = false;
  const generate = async ({ outputPath }: { outputPath: string }) => {
    generated++;
    const generatedSidecar = sidecar(
      generatedKickoff,
      includeNewPlayer ? CURRENT_PLAYERS : BASE_PLAYERS
    );
    if (includeNewPlayer) {
      generatedSidecar.rows.push({
        fixture_id: 20,
        player_id: 3,
        team_id: 1,
        opponent_id: 2,
        position: 'FWD',
        kickoff_time: generatedKickoff,
        features: [1, 1 / 37, 1, 1, 0, 0, 0, 1],
      });
    }
    await writeFile(outputPath, JSON.stringify(generatedSidecar));
  };

  const first = await ensureAutomaticFeatureSidecar(
    config(directory),
    predictor,
    { season: '2025-2026', gameweek: 2, fixtures: [fixture()], players: BASE_PLAYERS },
    generate
  );
  assert.equal(first.generated, true);
  assert.equal(generated, 1);

  const reused = await ensureAutomaticFeatureSidecar(
    config(directory),
    predictor,
    { season: '2025-2026', gameweek: 2, fixtures: [fixture()], players: BASE_PLAYERS },
    async () => assert.fail('valid cached feature sidecar should be reused')
  );
  assert.equal(reused.generated, false);

  includeNewPlayer = true;
  const refreshedForRosterDrift = await ensureAutomaticFeatureSidecar(
    config(directory),
    predictor,
    { season: '2025-2026', gameweek: 2, fixtures: [fixture()], players: CURRENT_PLAYERS },
    generate
  );
  assert.equal(refreshedForRosterDrift.generated, true);
  assert.equal(generated, 2);

  generatedKickoff = '2025-08-17T14:00:00Z';
  const refreshed = await ensureAutomaticFeatureSidecar(
    config(directory),
    predictor,
    {
      season: '2025-2026',
      gameweek: 2,
      fixtures: [fixture(generatedKickoff)],
      players: CURRENT_PLAYERS,
    },
    generate
  );
  assert.equal(refreshed.generated, true);
  assert.equal(generated, 3);
  assert.match(refreshed.raw, /2025-08-17T14:00:00Z/);
});

test('automatic ML features fail closed when the generated artifact is invalid', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fpl-auto-features-invalid-'));
  await assert.rejects(
    ensureAutomaticFeatureSidecar(
      config(directory),
      predictor,
      { season: '2025-2026', gameweek: 2, fixtures: [fixture()], players: BASE_PLAYERS },
      async ({ outputPath }) => writeFile(outputPath, '{"invalid":true}')
    ),
    /Unsupported live ML artifact type/
  );
});
