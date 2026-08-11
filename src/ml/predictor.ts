import { readFile, stat } from 'node:fs/promises';

interface SerializedTree {
  node_count: number;
  children_left: number[];
  children_right: number[];
  feature_index: number[];
  threshold: number[];
  value: number[];
}

interface SerializedModel {
  task: 'binary_classification' | 'regression';
  link: 'sigmoid' | 'identity';
  base_score: number;
  learning_rate: number;
  trees: SerializedTree[];
}

export interface PlayerFixtureModelArtifact {
  model_version: string;
  data_version: string;
  schema_version: string;
  reconstructed_not_strict: boolean;
  feature_names: string[];
  feature_count: number;
  identity_fields_excluded: string[];
  blend_weights: {
    direct_weight: number;
    conditional_weight: number;
    selected_on: string;
  };
  models: Record<string, SerializedModel>;
  self_check?: {
    passed: boolean;
    sample_rows: number;
    absolute_tolerance: number;
    maximum_absolute_error_by_model: Record<string, number>;
    parity_vectors?: Array<{
      features: number[];
      expected_outputs: Record<string, number>;
    }>;
  };
  known_limitations: string[];
}

export interface PlayerFixturePrediction {
  expectedPoints: number;
  appearanceProbability: number;
  startProbability: number;
  expectedMinutes: number;
  directExpectedPoints: number;
  conditionalExpectedPoints: number;
}

const REQUIRED_MODELS = [
  'appearance_classifier',
  'start_classifier',
  'conditional_minutes_regressor',
  'conditional_points_regressor',
  'direct_points_regressor',
] as const;

const FORBIDDEN_IDENTITY_FEATURES = new Set([
  'element',
  'element_id',
  'name',
  'web_name',
  'player_id',
  'player_name',
  'team',
  'team_id',
  'team_name',
  'opponent_id',
  'opponent_team',
  'fixture',
  'fixture_id',
  'kickoff_time',
]);

export class PlayerFixturePredictor {
  readonly modelVersion: string;
  readonly dataVersion: string;
  readonly schemaVersion: string;
  readonly featureNames: readonly string[];
  readonly knownLimitations: readonly string[];

  constructor(private readonly artifact: PlayerFixtureModelArtifact) {
    validateArtifact(artifact);
    this.modelVersion = artifact.model_version;
    this.dataVersion = artifact.data_version;
    this.schemaVersion = artifact.schema_version;
    this.featureNames = [...artifact.feature_names];
    this.knownLimitations = [...artifact.known_limitations];
  }

  predict(features: Readonly<Record<string, number>>): PlayerFixturePrediction {
    const vector = this.featureNames.map(name => {
      const value = features[name];
      if (!Number.isFinite(value)) throw new Error(`Missing or non-finite ML feature ${name}`);
      return value;
    });
    return this.predictVector(vector);
  }

  predictVector(features: readonly number[]): PlayerFixturePrediction {
    if (features.length !== this.featureNames.length) {
      throw new Error(`Expected ${this.featureNames.length} ML features, received ${features.length}`);
    }
    if (!features.every(Number.isFinite)) throw new Error('ML feature vector contains a non-finite value');

    const appearanceProbability = clampProbability(evaluateModel(this.model('appearance_classifier'), features));
    const startProbability = Math.min(
      appearanceProbability,
      clampProbability(evaluateModel(this.model('start_classifier'), features))
    );
    const conditionalMinutes = Math.max(
      1,
      Math.min(90, evaluateModel(this.model('conditional_minutes_regressor'), features))
    );
    const conditionalPoints = evaluateModel(this.model('conditional_points_regressor'), features);
    const directExpectedPoints = evaluateModel(this.model('direct_points_regressor'), features);
    const conditionalExpectedPoints = appearanceProbability * conditionalPoints;
    const rawExpectedPoints =
      this.artifact.blend_weights.direct_weight * directExpectedPoints +
      this.artifact.blend_weights.conditional_weight * conditionalExpectedPoints;

    return {
      expectedPoints: Math.max(0, rawExpectedPoints),
      appearanceProbability,
      startProbability,
      expectedMinutes: appearanceProbability * conditionalMinutes,
      directExpectedPoints,
      conditionalExpectedPoints,
    };
  }

  private model(name: typeof REQUIRED_MODELS[number]): SerializedModel {
    return this.artifact.models[name]!;
  }
}

export async function loadPlayerFixturePredictor(path: string): Promise<PlayerFixturePredictor> {
  const size = (await stat(path)).size;
  if (size > 16 * 1024 * 1024) throw new Error(`ML model artifact is too large: ${size} bytes`);
  const artifact = JSON.parse(await readFile(path, 'utf8')) as PlayerFixtureModelArtifact;
  return new PlayerFixturePredictor(artifact);
}

export function evaluateModel(model: SerializedModel, features: readonly number[]): number {
  let raw = model.base_score;
  for (const tree of model.trees) {
    let node = 0;
    let steps = 0;
    while (tree.children_left[node] !== -1) {
      if (steps++ >= tree.node_count) throw new Error('ML tree traversal did not reach a leaf');
      const featureIndex = tree.feature_index[node]!;
      node = features[featureIndex]! <= tree.threshold[node]!
        ? tree.children_left[node]!
        : tree.children_right[node]!;
    }
    raw += model.learning_rate * tree.value[node]!;
  }
  if (model.link === 'identity') return raw;
  if (raw >= 0) return 1 / (1 + Math.exp(-raw));
  const exp = Math.exp(raw);
  return exp / (1 + exp);
}

function validateArtifact(artifact: PlayerFixtureModelArtifact): void {
  if (!artifact.model_version || !artifact.data_version || !artifact.schema_version) {
    throw new Error('ML artifact is missing version metadata');
  }
  if (typeof artifact.reconstructed_not_strict !== 'boolean') {
    throw new Error('ML artifact must declare its historical integrity classification');
  }
  if (artifact.feature_count !== artifact.feature_names.length || artifact.feature_count === 0) {
    throw new Error('ML artifact feature count does not match its ordered feature names');
  }
  if (new Set(artifact.feature_names).size !== artifact.feature_names.length) {
    throw new Error('ML artifact contains duplicate feature names');
  }
  const leakedIdentity = artifact.identity_fields_excluded.filter(name => artifact.feature_names.includes(name));
  const codeOwnedIdentityLeaks = artifact.feature_names.filter(name => FORBIDDEN_IDENTITY_FEATURES.has(name));
  const identityLeaks = [...new Set([...leakedIdentity, ...codeOwnedIdentityLeaks])];
  if (identityLeaks.length > 0) {
    throw new Error(`ML artifact leaks identity features: ${identityLeaks.join(', ')}`);
  }
  const blendTotal = artifact.blend_weights.direct_weight + artifact.blend_weights.conditional_weight;
  if (!Number.isFinite(blendTotal) || Math.abs(blendTotal - 1) > 1e-9) {
    throw new Error('ML artifact blend weights must sum to one');
  }

  for (const name of REQUIRED_MODELS) {
    const model = artifact.models[name];
    if (!model) throw new Error(`ML artifact is missing model ${name}`);
    if (!Number.isFinite(model.base_score) || !Number.isFinite(model.learning_rate)) {
      throw new Error(`ML model ${name} contains non-finite parameters`);
    }
    if (model.trees.length === 0) throw new Error(`ML model ${name} has no trees`);
    for (const tree of model.trees) validateTree(name, tree, artifact.feature_count);
  }
  validateSelfCheck(artifact);
}

function validateSelfCheck(artifact: PlayerFixtureModelArtifact): void {
  const selfCheck = artifact.self_check;
  if (!selfCheck) return;
  if (!selfCheck.passed || !Number.isFinite(selfCheck.absolute_tolerance) || selfCheck.absolute_tolerance < 0) {
    throw new Error('ML artifact declares a failed or invalid exporter self-check');
  }
  for (const [index, vector] of (selfCheck.parity_vectors ?? []).entries()) {
    if (vector.features.length !== artifact.feature_count || !vector.features.every(Number.isFinite)) {
      throw new Error(`ML artifact parity vector ${index} has invalid features`);
    }
    for (const name of REQUIRED_MODELS) {
      const expected = vector.expected_outputs[name];
      if (!Number.isFinite(expected)) throw new Error(`ML artifact parity vector ${index} is missing ${name}`);
      const actual = evaluateModel(artifact.models[name]!, vector.features);
      if (Math.abs(actual - expected) > selfCheck.absolute_tolerance) {
        throw new Error(
          `ML artifact parity check failed for ${name} vector ${index}: ` +
          `${Math.abs(actual - expected)} > ${selfCheck.absolute_tolerance}`
        );
      }
    }
  }
}

function validateTree(modelName: string, tree: SerializedTree, featureCount: number): void {
  const arrays = [
    tree.children_left,
    tree.children_right,
    tree.feature_index,
    tree.threshold,
    tree.value,
  ];
  if (!Number.isInteger(tree.node_count) || tree.node_count <= 0 || arrays.some(values => values.length !== tree.node_count)) {
    throw new Error(`ML model ${modelName} contains an invalid tree shape`);
  }
  for (let node = 0; node < tree.node_count; node++) {
    const left = tree.children_left[node]!;
    const right = tree.children_right[node]!;
    if (!Number.isFinite(tree.threshold[node]) || !Number.isFinite(tree.value[node])) {
      throw new Error(`ML model ${modelName} tree contains non-finite values`);
    }
    if (left === -1 && right === -1) continue;
    if (left < 0 || right < 0 || left >= tree.node_count || right >= tree.node_count) {
      throw new Error(`ML model ${modelName} tree contains an invalid child index`);
    }
    const featureIndex = tree.feature_index[node]!;
    if (featureIndex < 0 || featureIndex >= featureCount) {
      throw new Error(`ML model ${modelName} tree contains an invalid feature index`);
    }
  }
  const state = new Uint8Array(tree.node_count);
  const visit = (node: number): void => {
    if (state[node] === 1) throw new Error(`ML model ${modelName} tree contains a cycle`);
    if (state[node] === 2) return;
    state[node] = 1;
    const left = tree.children_left[node]!;
    const right = tree.children_right[node]!;
    if (left !== -1) {
      visit(left);
      visit(right);
    }
    state[node] = 2;
  };
  visit(0);
  if (state.some(value => value === 0)) throw new Error(`ML model ${modelName} tree contains unreachable nodes`);
}

function clampProbability(value: number): number {
  return Math.max(0, Math.min(1, value));
}
