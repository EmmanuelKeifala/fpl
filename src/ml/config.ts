import { join } from 'node:path';

export interface MlShadowConfig {
  enabled: boolean;
  modelPath: string | null;
  featureSidecarPath: string | null;
  autoGenerateFeatures: boolean;
  featureDirectory: string | null;
  pythonBinary: string | null;
  featureScriptPath: string | null;
  generationTimeoutMs: number | null;
}

export function getMlShadowConfig(env: NodeJS.ProcessEnv = process.env): MlShadowConfig {
  const enabled = booleanValue(env, 'FPL_ML_SHADOW_ENABLED', false);
  if (!enabled) return {
    enabled: false,
    modelPath: null,
    featureSidecarPath: null,
    autoGenerateFeatures: false,
    featureDirectory: null,
    pythonBinary: null,
    featureScriptPath: null,
    generationTimeoutMs: null,
  };
  const autoGenerateFeatures = booleanValue(env, 'FPL_ML_AUTO_FEATURES', false);
  const featureSidecarPath = env.FPL_ML_FEATURE_SIDECAR?.trim();
  if (!autoGenerateFeatures && !featureSidecarPath) {
    throw new Error('FPL_ML_FEATURE_SIDECAR is required when ML shadow mode is enabled');
  }
  if (autoGenerateFeatures && featureSidecarPath) {
    throw new Error('Set either FPL_ML_AUTO_FEATURES=true or FPL_ML_FEATURE_SIDECAR, not both');
  }
  return {
    enabled: true,
    modelPath: env.FPL_ML_MODEL_PATH?.trim()
      || join(process.cwd(), 'artifacts/ml/player-fixture-v1/model.json'),
    featureSidecarPath: featureSidecarPath || null,
    autoGenerateFeatures,
    featureDirectory: autoGenerateFeatures
      ? env.FPL_ML_FEATURE_DIRECTORY?.trim()
        || join(process.cwd(), 'data/live/player-fixture-features-v1')
      : null,
    pythonBinary: autoGenerateFeatures ? env.FPL_ML_PYTHON_BIN?.trim() || 'python3' : null,
    featureScriptPath: autoGenerateFeatures
      ? env.FPL_ML_FEATURE_SCRIPT?.trim() || join(process.cwd(), 'scripts/ml/live_features.py')
      : null,
    generationTimeoutMs: autoGenerateFeatures
      ? integerValue(env, 'FPL_ML_FEATURE_TIMEOUT_SECONDS', 60, 900, 600) * 1000
      : null,
  };
}

function booleanValue(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = (env[name] ?? String(fallback)).trim().toLowerCase();
  if (raw !== 'true' && raw !== 'false') throw new Error(`${name} must be true or false`);
  return raw === 'true';
}

function integerValue(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  const raw = (env[name] ?? String(fallback)).trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}
