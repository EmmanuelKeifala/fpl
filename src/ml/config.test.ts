import { strict as assert } from 'node:assert';
import test from 'node:test';
import { getMlShadowConfig } from './config.js';

test('ML shadow mode is disabled by default and exposes no artifact paths', () => {
  assert.deepEqual(getMlShadowConfig({}), {
    enabled: false,
    modelPath: null,
    featureSidecarPath: null,
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
  });
  assert.equal('mode' in config, false);
});

test('ML shadow enablement rejects ambiguous boolean values', () => {
  assert.throws(() => getMlShadowConfig({ FPL_ML_SHADOW_ENABLED: '1' }), /true or false/);
});
