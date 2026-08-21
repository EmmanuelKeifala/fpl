import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { Fixture } from '../api/types.js';
import {
  fingerprintPlayerRoster,
  predictLiveFeatureSidecar,
  validateLiveFeatureSidecar,
  type LiveFeaturePlayer,
  type LiveFeaturePredictor,
  type LiveFeatureRow,
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

const CURRENT_PLAYERS: LiveFeaturePlayer[] = [
  { id: 1, team: 1, element_type: 3 },
];

const predictor: LiveFeaturePredictor = {
  modelVersion: 'player-fixture-v1',
  schemaVersion: 'player-fixture-features-v1',
  featureNames: FEATURE_NAMES,
  predictVector(features) {
    const expectedPoints = features[0] === 1 ? 2 : 3;
    return {
      expectedPoints,
      appearanceProbability: 0.5,
      startProbability: 0.4,
      expectedMinutes: 40,
      directExpectedPoints: expectedPoints + 1,
      conditionalExpectedPoints: expectedPoints,
    };
  },
};

function vector(home: boolean, position: LiveFeatureRow['position'], fixtureCount = 2): number[] {
  return [
    Number(home),
    1 / 37,
    fixtureCount,
    1,
    Number(position === 'GK'),
    Number(position === 'DEF'),
    Number(position === 'MID'),
    Number(position === 'FWD'),
  ];
}

function sidecar(): LiveFeatureSidecar {
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
    deadline_utc: '2025-08-15T17:30:00Z',
    scoring_defensive_contributions: true,
    numeric_encoding: 'float64-rounded-10-significant-digits',
    feature_count: FEATURE_NAMES.length,
    feature_names: [...FEATURE_NAMES],
    latest_included_gameweek: 1,
    target_fixtures: [
      { id: 20, event: 2, kickoff_time: '2025-08-16T14:00:00Z', team_h: 1, team_a: 2 },
      { id: 21, event: 2, kickoff_time: '2025-08-18T19:00:00Z', team_h: 3, team_a: 1 },
    ],
    fixture_schedule_sha256: 'a'.repeat(64),
    player_roster_sha256: fingerprintPlayerRoster(CURRENT_PLAYERS),
    source_hashes: {
      bootstrap_static: 'b'.repeat(64),
      fixtures: 'c'.repeat(64),
      element_summaries: 'd'.repeat(64),
    },
    rows: [
      { fixture_id: 20, player_id: 1, team_id: 1, opponent_id: 2, position: 'MID', kickoff_time: '2025-08-16T14:00:00Z', features: vector(true, 'MID') },
      { fixture_id: 21, player_id: 1, team_id: 1, opponent_id: 3, position: 'MID', kickoff_time: '2025-08-18T19:00:00Z', features: vector(false, 'MID') },
    ],
  };
}

function fixtures(): Fixture[] {
  return sidecar().target_fixtures.map(fixture => ({
    code: fixture.id,
    event: fixture.event,
    finished: false,
    finished_provisional: false,
    id: fixture.id,
    kickoff_time: fixture.kickoff_time,
    minutes: 0,
    provisional_start_time: false,
    started: false,
    team_a: fixture.team_a,
    team_a_score: null,
    team_h: fixture.team_h,
    team_h_score: null,
    stats: [],
    team_h_difficulty: 3,
    team_a_difficulty: 3,
    pulse_id: fixture.id,
  }));
}

test('live sidecar validates schedule, feature ordering, frozen boundary, and DGW coverage', () => {
  const pythonSerialized = JSON.parse(JSON.stringify(sidecar(), (_key, value) => value)) as LiveFeatureSidecar;
  pythonSerialized.target_fixtures = pythonSerialized.target_fixtures.map(fixture => JSON.parse(
    `{"event":${fixture.event},"id":${fixture.id},"kickoff_time":"${fixture.kickoff_time}",` +
    `"team_a":${fixture.team_a},"team_h":${fixture.team_h}}`
  ) as LiveFeatureSidecar['target_fixtures'][number]);
  assert.doesNotThrow(() => validateLiveFeatureSidecar(pythonSerialized, predictor, {
    season: '2025-2026',
    gameweek: 2,
    fixtures: fixtures(),
    players: CURRENT_PLAYERS,
  }));
});

test('player roster fingerprint is order-independent and matches the Python canonical contract', () => {
  const players: LiveFeaturePlayer[] = [
    { id: 3, team: 1, element_type: 4 },
    { id: 1, team: 1, element_type: 3 },
    { id: 2, team: 2, element_type: 2 },
  ];
  assert.equal(
    fingerprintPlayerRoster(players),
    'f19e17d35c8c69334ad7600975b995ac3af36a3d20a4bfb72867f2a0e8c413bb'
  );
  assert.notEqual(
    fingerprintPlayerRoster(players),
    fingerprintPlayerRoster(players.map(player => player.id === 3 ? { ...player, team: 2 } : player))
  );
  assert.throws(
    () => fingerprintPlayerRoster([...players, players[0]!]),
    /invalid or duplicate player 3/
  );
});

test('live sidecar predictions aggregate fixture points, minutes, and appearance probabilities', () => {
  const prediction = predictLiveFeatureSidecar(sidecar(), predictor).get(1);

  assert.equal(prediction?.expectedPoints, 5);
  assert.equal(prediction?.expectedMinutes, 80);
  assert.equal(prediction?.appearanceProbability, 0.75);
  assert.equal(prediction?.startProbability, 0.64);
  assert.equal(prediction?.expectedAppearances, 1);
  assert.equal(prediction?.expectedStarts, 0.8);
  assert.equal(prediction?.fixtureCount, 2);
  assert.equal(prediction?.fixtures.length, 2);
});

test('live sidecar rejects post-deadline, schedule-drifted, and incomplete artifacts', () => {
  const late = sidecar();
  late.generated_at_utc = '2025-08-15T18:00:00Z';
  assert.throws(() => validateLiveFeatureSidecar(late, predictor), /generated after/);

  const driftedFixtures = fixtures();
  driftedFixtures[0]!.kickoff_time = '2025-08-17T14:00:00Z';
  assert.throws(() => validateLiveFeatureSidecar(sidecar(), predictor, {
    season: '2025-2026',
    gameweek: 2,
    fixtures: driftedFixtures,
    players: CURRENT_PLAYERS,
  }), /schedule differs/);

  const incomplete = sidecar();
  incomplete.rows.pop();
  assert.throws(() => validateLiveFeatureSidecar(incomplete, predictor), /does not cover every club fixture/);
});

test('live sidecar rejects roster fingerprint, missing, extra, club, and position drift', () => {
  const expandedPlayers: LiveFeaturePlayer[] = [
    ...CURRENT_PLAYERS,
    { id: 2, team: 2, element_type: 2 },
  ];
  assert.throws(() => validateLiveFeatureSidecar(sidecar(), predictor, {
    season: '2025-2026',
    gameweek: 2,
    fixtures: fixtures(),
    players: expandedPlayers,
  }), /roster fingerprint differs/);

  const missing = sidecar();
  missing.player_roster_sha256 = fingerprintPlayerRoster(expandedPlayers);
  assert.throws(() => validateLiveFeatureSidecar(missing, predictor, {
    season: '2025-2026',
    gameweek: 2,
    fixtures: fixtures(),
    players: expandedPlayers,
  }), /current-player coverage for player 2 is 0; expected 1/);

  const extra = sidecar();
  extra.rows.push({
    fixture_id: 20,
    player_id: 2,
    team_id: 2,
    opponent_id: 1,
    position: 'DEF',
    kickoff_time: '2025-08-16T14:00:00Z',
    features: vector(false, 'DEF', 1),
  });
  assert.throws(() => validateLiveFeatureSidecar(extra, predictor, {
    season: '2025-2026',
    gameweek: 2,
    fixtures: fixtures(),
    players: CURRENT_PLAYERS,
  }), /contains stale player 2/);

  const staleClub = sidecar();
  staleClub.rows[0]!.team_id = 2;
  assert.throws(() => validateLiveFeatureSidecar(staleClub, predictor, {
    season: '2025-2026',
    gameweek: 2,
    fixtures: fixtures(),
    players: CURRENT_PLAYERS,
  }), /stale club or position metadata/);

  const stalePosition = sidecar();
  stalePosition.rows[0]!.position = 'DEF';
  assert.throws(() => validateLiveFeatureSidecar(stalePosition, predictor, {
    season: '2025-2026',
    gameweek: 2,
    fixtures: fixtures(),
    players: CURRENT_PLAYERS,
  }), /stale club or position metadata/);
});
