import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  PlayerFixturePredictor,
  type PlayerFixtureModelArtifact,
} from './predictor.js';

function tree(featureIndex: number | null, leftValue: number, rightValue = leftValue) {
  return featureIndex === null
    ? {
      node_count: 1,
      children_left: [-1],
      children_right: [-1],
      feature_index: [-2],
      threshold: [-2],
      value: [leftValue],
    }
    : {
      node_count: 3,
      children_left: [1, -1, -1],
      children_right: [2, -1, -1],
      feature_index: [featureIndex, -2, -2],
      threshold: [1, -2, -2],
      value: [0, leftValue, rightValue],
    };
}

function model(
  task: 'binary_classification' | 'regression',
  value: number,
  options: { featureIndex?: number; rightValue?: number } = {}
) {
  return {
    task,
    link: task === 'binary_classification' ? 'sigmoid' as const : 'identity' as const,
    base_score: 0,
    learning_rate: 1,
    trees: [tree(options.featureIndex ?? null, value, options.rightValue)],
  };
}

function artifact(): PlayerFixtureModelArtifact {
  return {
    model_version: 'test-v1',
    data_version: 'test-data-v1',
    schema_version: 'test-features-v1',
    reconstructed_not_strict: true,
    feature_names: ['form', 'price'],
    feature_count: 2,
    identity_fields_excluded: ['player_id', 'player_name'],
    blend_weights: {
      direct_weight: 0,
      conditional_weight: 1,
      selected_on: 'validation',
    },
    models: {
      appearance_classifier: model('binary_classification', 2, { featureIndex: 0, rightValue: -2 }),
      start_classifier: model('binary_classification', 4),
      conditional_minutes_regressor: model('regression', 100),
      conditional_points_regressor: model('regression', 5),
      direct_points_regressor: model('regression', 9),
    },
    known_limitations: ['synthetic fixture'],
  };
}

test('PlayerFixturePredictor follows ordered tree features and composes model outputs', () => {
  const predictor = new PlayerFixturePredictor(artifact());
  const prediction = predictor.predict({ price: 99, form: 0 });
  const appearance = 1 / (1 + Math.exp(-2));

  assert.ok(Math.abs(prediction.appearanceProbability - appearance) < 1e-12);
  assert.equal(prediction.startProbability, prediction.appearanceProbability);
  assert.ok(Math.abs(prediction.expectedMinutes - 90 * appearance) < 1e-12);
  assert.ok(Math.abs(prediction.conditionalExpectedPoints - 5 * appearance) < 1e-12);
  assert.equal(prediction.expectedPoints, prediction.conditionalExpectedPoints);
  assert.equal(prediction.directExpectedPoints, 9);

  const rightBranch = predictor.predictVector([2, 99]);
  assert.ok(rightBranch.appearanceProbability < 0.12);
});

test('PlayerFixturePredictor rejects missing and non-finite features', () => {
  const predictor = new PlayerFixturePredictor(artifact());

  assert.throws(() => predictor.predict({ form: 1 }), /price/);
  assert.throws(() => predictor.predictVector([1, Number.NaN]), /non-finite/);
});

test('PlayerFixturePredictor rejects fitted identity features', () => {
  const invalid = artifact();
  invalid.feature_names = ['form', 'player_id'];

  assert.throws(() => new PlayerFixturePredictor(invalid), /leaks identity features: player_id/);

  invalid.identity_fields_excluded = [];
  assert.throws(() => new PlayerFixturePredictor(invalid), /leaks identity features: player_id/);
});

test('PlayerFixturePredictor enforces exported Python parity vectors', () => {
  const valid = artifact();
  valid.self_check = {
    passed: true,
    sample_rows: 1,
    absolute_tolerance: 1e-12,
    maximum_absolute_error_by_model: {},
    parity_vectors: [{
      features: [0, 99],
      expected_outputs: {
        appearance_classifier: 1 / (1 + Math.exp(-2)),
        start_classifier: 1 / (1 + Math.exp(-4)),
        conditional_minutes_regressor: 100,
        conditional_points_regressor: 5,
        direct_points_regressor: 9,
      },
    }],
  };
  assert.doesNotThrow(() => new PlayerFixturePredictor(valid));

  valid.self_check.parity_vectors![0]!.expected_outputs.direct_points_regressor = 8;
  assert.throws(() => new PlayerFixturePredictor(valid), /parity check failed/);
});

test('PlayerFixturePredictor rejects cyclic serialized trees', () => {
  const invalid = artifact();
  invalid.models.appearance_classifier!.trees[0] = {
    node_count: 3,
    children_left: [1, 0, -1],
    children_right: [2, 2, -1],
    feature_index: [0, 1, -2],
    threshold: [1, 1, -2],
    value: [0, 0, 1],
  };

  assert.throws(() => new PlayerFixturePredictor(invalid), /contains a cycle/);
});
