import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import test from 'node:test';
import { getMlShadowConfig } from './config.js';

test('ML shadow mode is disabled by default and exposes no artifact paths', () => {
  assert.deepEqual(getMlShadowConfig({}), {
    enabled: false,
    modelPath: null,
    featureSidecarPath: null,
    autoGenerateFeatures: false,
    featureDirectory: null,
    pythonBinary: null,
    featureScriptPath: null,
    generationTimeoutMs: null,
  });
});

test('ML shadow mode requires an explicit sidecar and has no execution mode', () => {
  assert.throws(
    () => getMlShadowConfig({ FPL_ML_SHADOW_ENABLED: 'true' }),
    /FPL_ML_FEATURE_SIDECAR/
  );
  const config = getMlShadowConfig({
    FPL_ML_SHADOW_ENABLED: 'true',
    FPL_ML_MODEL_PATH: '/models/model.json',
    FPL_ML_FEATURE_SIDECAR: '/features/gw-1.json',
  });
  assert.deepEqual(config, {
    enabled: true,
    modelPath: '/models/model.json',
    featureSidecarPath: '/features/gw-1.json',
    autoGenerateFeatures: false,
    featureDirectory: null,
    pythonBinary: null,
    featureScriptPath: null,
    generationTimeoutMs: null,
  });
  assert.equal('mode' in config, false);
});

test('ML shadow mode can automatically generate deadline-safe gameweek features', () => {
  const config = getMlShadowConfig({
    FPL_ML_SHADOW_ENABLED: 'true',
    FPL_ML_AUTO_FEATURES: 'true',
    FPL_ML_FEATURE_DIRECTORY: '/data/features',
    FPL_ML_PYTHON_BIN: '/usr/bin/python3',
    FPL_ML_FEATURE_SCRIPT: '/app/scripts/live_features.py',
    FPL_ML_FEATURE_TIMEOUT_SECONDS: '120',
  });
  assert.deepEqual(config, {
    enabled: true,
    modelPath: join(process.cwd(), 'artifacts/ml/player-fixture-v1/model.json'),
    featureSidecarPath: null,
    autoGenerateFeatures: true,
    featureDirectory: '/data/features',
    pythonBinary: '/usr/bin/python3',
    featureScriptPath: '/app/scripts/live_features.py',
    generationTimeoutMs: 120_000,
  });
  assert.throws(() => getMlShadowConfig({
    FPL_ML_SHADOW_ENABLED: 'true',
    FPL_ML_AUTO_FEATURES: 'true',
    FPL_ML_FEATURE_SIDECAR: '/features/gw-1.json',
  }), /either.*AUTO_FEATURES.*FEATURE_SIDECAR/i);
});

test('ML shadow enablement rejects ambiguous boolean values', () => {
  assert.throws(() => getMlShadowConfig({ FPL_ML_SHADOW_ENABLED: '1' }), /true or false/);
  assert.throws(() => getMlShadowConfig({
    FPL_ML_SHADOW_ENABLED: 'true',
    FPL_ML_AUTO_FEATURES: 'yes',
  }), /true or false/);
});
