import { join } from 'node:path';

export interface MlShadowConfig {
  enabled: boolean;
  modelPath: string | null;
  featureSidecarPath: string | null;
}

export function getMlShadowConfig(env: NodeJS.ProcessEnv = process.env): MlShadowConfig {
  const raw = (env.FPL_ML_SHADOW_ENABLED ?? 'false').trim().toLowerCase();
  if (raw !== 'true' && raw !== 'false') {
    throw new Error('FPL_ML_SHADOW_ENABLED must be true or false');
  }
  if (raw === 'false') return { enabled: false, modelPath: null, featureSidecarPath: null };
  const featureSidecarPath = env.FPL_ML_FEATURE_SIDECAR?.trim();
  if (!featureSidecarPath) {
    throw new Error('FPL_ML_FEATURE_SIDECAR is required when ML shadow mode is enabled');
  }
  return {
    enabled: true,
    modelPath: env.FPL_ML_MODEL_PATH?.trim()
      || join(process.cwd(), 'artifacts/ml/player-fixture-v1/model.json'),
    featureSidecarPath,
  };
}
