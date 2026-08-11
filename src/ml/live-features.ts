import { readFile, stat } from 'node:fs/promises';
import type { Fixture } from '../api/types.js';
import type { PlayerFixturePrediction } from './predictor.js';

export interface LiveFeatureTargetFixture {
  id: number;
  event: number;
  kickoff_time: string;
  team_h: number;
  team_a: number;
}

export interface LiveFeatureRow {
  fixture_id: number;
  player_id: number;
  team_id: number;
  opponent_id: number;
  position: 'GK' | 'DEF' | 'MID' | 'FWD';
  kickoff_time: string;
  features: number[];
}

export interface LiveFeatureSidecar {
  artifact_type: 'player-fixture-live-features';
  model_version: string;
  feature_schema_version: string;
  feature_builder_version: string;
  live_data_version: string;
  season: string;
  target_gameweek: number;
  generated_at_utc: string;
  as_of_utc: string;
  deadline_utc: string;
  scoring_defensive_contributions: boolean;
  numeric_encoding: 'float64-rounded-10-significant-digits';
  feature_count: number;
  feature_names: string[];
  latest_included_gameweek: number;
  target_fixtures: LiveFeatureTargetFixture[];
  fixture_schedule_sha256: string;
  source_hashes: Record<string, string>;
  rows: LiveFeatureRow[];
}

export interface LiveFeaturePredictor {
  readonly modelVersion: string;
  readonly schemaVersion: string;
  readonly featureNames: readonly string[];
  predictVector(features: readonly number[]): PlayerFixturePrediction;
}

export interface LiveFixturePrediction extends PlayerFixturePrediction {
  fixtureId: number;
  playerId: number;
  teamId: number;
  opponentId: number;
  kickoffTime: string;
}

export interface LivePlayerPrediction extends PlayerFixturePrediction {
  playerId: number;
  fixtureCount: number;
  expectedAppearances: number;
  expectedStarts: number;
  fixtures: LiveFixturePrediction[];
}

const POSITIONS = ['GK', 'DEF', 'MID', 'FWD'] as const;
const REQUIRED_SOURCE_HASHES = ['bootstrap_static', 'fixtures', 'element_summaries'] as const;

export async function loadLiveFeatureSidecar(
  path: string,
  predictor: LiveFeaturePredictor,
  expected?: { season: string; gameweek: number; fixtures: readonly Fixture[] }
): Promise<LiveFeatureSidecar> {
  const size = (await stat(path)).size;
  if (size > 64 * 1024 * 1024) throw new Error(`Live ML feature sidecar is too large: ${size} bytes`);
  const sidecar = JSON.parse(await readFile(path, 'utf8')) as LiveFeatureSidecar;
  validateLiveFeatureSidecar(sidecar, predictor, expected);
  return sidecar;
}

export function validateLiveFeatureSidecar(
  sidecar: LiveFeatureSidecar,
  predictor: LiveFeaturePredictor,
  expected?: { season: string; gameweek: number; fixtures: readonly Fixture[] }
): void {
  if (sidecar.artifact_type !== 'player-fixture-live-features') {
    throw new Error(`Unsupported live ML artifact type ${sidecar.artifact_type}`);
  }
  if (sidecar.model_version !== predictor.modelVersion) {
    throw new Error(`Live ML model version ${sidecar.model_version} does not match ${predictor.modelVersion}`);
  }
  if (sidecar.feature_schema_version !== predictor.schemaVersion) {
    throw new Error(`Live ML feature schema ${sidecar.feature_schema_version} does not match ${predictor.schemaVersion}`);
  }
  if (sidecar.numeric_encoding !== 'float64-rounded-10-significant-digits') {
    throw new Error(`Unsupported live ML numeric encoding ${sidecar.numeric_encoding}`);
  }
  if (sidecar.feature_count !== predictor.featureNames.length || sidecar.feature_count !== sidecar.feature_names.length) {
    throw new Error('Live ML feature count does not match the model contract');
  }
  if (!sameArray(sidecar.feature_names, predictor.featureNames)) {
    throw new Error('Live ML feature names or ordering do not match the model contract');
  }
  if (!Number.isInteger(sidecar.target_gameweek) || sidecar.target_gameweek < 1 || sidecar.target_gameweek > 38) {
    throw new Error(`Invalid live ML target gameweek ${sidecar.target_gameweek}`);
  }
  if (
    !Number.isInteger(sidecar.latest_included_gameweek)
    || sidecar.latest_included_gameweek !== sidecar.target_gameweek - 1
  ) {
    throw new Error(`Live ML history reaches GW${sidecar.latest_included_gameweek} for target GW${sidecar.target_gameweek}`);
  }
  const generatedAt = timestamp(sidecar.generated_at_utc, 'generated_at_utc');
  const asOf = timestamp(sidecar.as_of_utc, 'as_of_utc');
  const deadline = timestamp(sidecar.deadline_utc, 'deadline_utc');
  if (asOf > deadline) throw new Error('Live ML source capture is after the target deadline');
  if (generatedAt > deadline) throw new Error('Live ML sidecar was generated after the target deadline');
  if (generatedAt < asOf) throw new Error('Live ML sidecar generation predates its source capture');
  if (!/^[a-f0-9]{64}$/.test(sidecar.fixture_schedule_sha256)) {
    throw new Error('Live ML fixture schedule hash is invalid');
  }
  for (const name of REQUIRED_SOURCE_HASHES) {
    if (!/^[a-f0-9]{64}$/.test(sidecar.source_hashes[name] ?? '')) {
      throw new Error(`Live ML source hash ${name} is invalid`);
    }
  }
  if (expected) {
    if (sidecar.season !== expected.season) throw new Error(`Live ML season ${sidecar.season} does not match ${expected.season}`);
    if (sidecar.target_gameweek !== expected.gameweek) {
      throw new Error(`Live ML target GW${sidecar.target_gameweek} does not match GW${expected.gameweek}`);
    }
    const current = normalizeFixtures(expected.fixtures, expected.gameweek);
    if (!sameFixtures(sidecar.target_fixtures, current)) {
      throw new Error('Live ML target fixture schedule differs from current public fixtures');
    }
  }

  validateTargetFixtures(sidecar);
  validateRows(sidecar, predictor.featureNames);
}

export function predictLiveFeatureSidecar(
  sidecar: LiveFeatureSidecar,
  predictor: LiveFeaturePredictor
): Map<number, LivePlayerPrediction> {
  validateLiveFeatureSidecar(sidecar, predictor);
  const predictions = new Map<number, LivePlayerPrediction>();
  for (const row of sidecar.rows) {
    const prediction = predictor.predictVector(row.features);
    const fixture: LiveFixturePrediction = {
      ...prediction,
      fixtureId: row.fixture_id,
      playerId: row.player_id,
      teamId: row.team_id,
      opponentId: row.opponent_id,
      kickoffTime: row.kickoff_time,
    };
    const current = predictions.get(row.player_id);
    if (!current) {
      predictions.set(row.player_id, {
        ...prediction,
        playerId: row.player_id,
        fixtureCount: 1,
        expectedAppearances: prediction.appearanceProbability,
        expectedStarts: prediction.startProbability,
        fixtures: [fixture],
      });
      continue;
    }
    current.expectedPoints += prediction.expectedPoints;
    current.expectedMinutes += prediction.expectedMinutes;
    current.directExpectedPoints += prediction.directExpectedPoints;
    current.conditionalExpectedPoints += prediction.conditionalExpectedPoints;
    current.appearanceProbability = 1 - (1 - current.appearanceProbability) * (1 - prediction.appearanceProbability);
    current.startProbability = 1 - (1 - current.startProbability) * (1 - prediction.startProbability);
    current.expectedAppearances += prediction.appearanceProbability;
    current.expectedStarts += prediction.startProbability;
    current.fixtureCount += 1;
    current.fixtures.push(fixture);
  }
  return predictions;
}

function validateTargetFixtures(sidecar: LiveFeatureSidecar): void {
  if (!Array.isArray(sidecar.target_fixtures) || sidecar.target_fixtures.length === 0) {
    throw new Error('Live ML sidecar has no target fixtures');
  }
  const ids = new Set<number>();
  for (const fixture of sidecar.target_fixtures) {
    if (!positiveInteger(fixture.id) || ids.has(fixture.id)) throw new Error(`Invalid or duplicate live ML fixture ${fixture.id}`);
    ids.add(fixture.id);
    if (fixture.event !== sidecar.target_gameweek) throw new Error(`Live ML fixture ${fixture.id} has wrong gameweek`);
    if (!positiveInteger(fixture.team_h) || !positiveInteger(fixture.team_a) || fixture.team_h === fixture.team_a) {
      throw new Error(`Live ML fixture ${fixture.id} has invalid clubs`);
    }
    timestamp(fixture.kickoff_time, `fixture ${fixture.id} kickoff_time`);
  }
}

function validateRows(sidecar: LiveFeatureSidecar, featureNames: readonly string[]): void {
  if (!Array.isArray(sidecar.rows) || sidecar.rows.length === 0) throw new Error('Live ML sidecar has no player-fixture rows');
  const fixtures = new Map(sidecar.target_fixtures.map(fixture => [fixture.id, fixture]));
  const fixturesByTeam = new Map<number, number[]>();
  for (const fixture of sidecar.target_fixtures) {
    fixturesByTeam.set(fixture.team_h, [...(fixturesByTeam.get(fixture.team_h) ?? []), fixture.id]);
    fixturesByTeam.set(fixture.team_a, [...(fixturesByTeam.get(fixture.team_a) ?? []), fixture.id]);
  }
  const rowsByPlayer = new Map<number, LiveFeatureRow[]>();
  const seen = new Set<string>();
  const featureIndex = new Map(featureNames.map((name, index) => [name, index]));
  for (const row of sidecar.rows) {
    if (!positiveInteger(row.player_id) || !positiveInteger(row.fixture_id) || !positiveInteger(row.team_id) || !positiveInteger(row.opponent_id)) {
      throw new Error('Live ML row contains invalid identity metadata');
    }
    if (!POSITIONS.includes(row.position)) throw new Error(`Live ML row has invalid position ${row.position}`);
    const key = `${row.fixture_id}:${row.player_id}`;
    if (seen.has(key)) throw new Error(`Duplicate live ML row ${key}`);
    seen.add(key);
    const fixture = fixtures.get(row.fixture_id);
    if (!fixture) throw new Error(`Live ML row references unknown fixture ${row.fixture_id}`);
    const expectedOpponent = fixture.team_h === row.team_id
      ? fixture.team_a
      : fixture.team_a === row.team_id
        ? fixture.team_h
        : undefined;
    if (expectedOpponent !== row.opponent_id) throw new Error(`Live ML row ${key} has inconsistent club metadata`);
    if (timestamp(row.kickoff_time, `row ${key} kickoff_time`) !== timestamp(fixture.kickoff_time, `fixture ${fixture.id} kickoff_time`)) {
      throw new Error(`Live ML row ${key} has inconsistent kickoff`);
    }
    if (!Array.isArray(row.features) || row.features.length !== sidecar.feature_count || !row.features.every(Number.isFinite)) {
      throw new Error(`Live ML row ${key} has an invalid feature vector`);
    }
    const values = (name: string) => row.features[featureIndex.get(name)!]!;
    const expectedPhase = (sidecar.target_gameweek - 1) / 37;
    if (Math.abs(values('gameweek_phase') - expectedPhase) > 1e-9) throw new Error(`Live ML row ${key} has wrong gameweek phase`);
    if (values('scoring_defensive_contributions') !== Number(sidecar.scoring_defensive_contributions)) {
      throw new Error(`Live ML row ${key} has wrong scoring-era flag`);
    }
    const oneHot = {
      GK: values('position_gk'),
      DEF: values('position_def'),
      MID: values('position_mid'),
      FWD: values('position_fwd'),
    };
    if (POSITIONS.some(position => oneHot[position] !== Number(position === row.position))) {
      throw new Error(`Live ML row ${key} has inconsistent position features`);
    }
    rowsByPlayer.set(row.player_id, [...(rowsByPlayer.get(row.player_id) ?? []), row]);
  }

  for (const [playerId, rows] of rowsByPlayer) {
    const expectedFixtureIds = [...(fixturesByTeam.get(rows[0]!.team_id) ?? [])].sort((a, b) => a - b);
    const actualFixtureIds = rows.map(row => row.fixture_id).sort((a, b) => a - b);
    if (!sameArray(actualFixtureIds, expectedFixtureIds)) {
      throw new Error(`Live ML player ${playerId} does not cover every club fixture`);
    }
    if (rows.some(row => row.team_id !== rows[0]!.team_id)) throw new Error(`Live ML player ${playerId} changes club within the target GW`);
    for (const row of rows) {
      if (row.features[featureIndex.get('club_gw_match_count')!] !== expectedFixtureIds.length) {
        throw new Error(`Live ML player ${playerId} has wrong club fixture count`);
      }
    }
  }
}

function normalizeFixtures(fixtures: readonly Fixture[], gameweek: number): LiveFeatureTargetFixture[] {
  return fixtures
    .filter(fixture => fixture.event === gameweek)
    .map(fixture => {
      if (!fixture.kickoff_time) throw new Error(`Current fixture ${fixture.id} has no kickoff time`);
      return {
        id: fixture.id,
        event: gameweek,
        kickoff_time: fixture.kickoff_time,
        team_h: fixture.team_h,
        team_a: fixture.team_a,
      };
    })
    .sort((a, b) => a.id - b.id);
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid live ML ${label}: ${value}`);
  return parsed;
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameFixtures(
  left: readonly LiveFeatureTargetFixture[],
  right: readonly LiveFeatureTargetFixture[]
): boolean {
  if (left.length !== right.length) return false;
  const orderedLeft = [...left].sort((a, b) => a.id - b.id);
  const orderedRight = [...right].sort((a, b) => a.id - b.id);
  return orderedLeft.every((fixture, index) => {
    const other = orderedRight[index];
    return other !== undefined
      && fixture.id === other.id
      && fixture.event === other.event
      && fixture.kickoff_time === other.kickoff_time
      && fixture.team_h === other.team_h
      && fixture.team_a === other.team_a;
  });
}
