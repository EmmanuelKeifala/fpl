import { randomBytes } from 'node:crypto';

export type ExperimentConfigId = 'balanced' | 'aggressive' | 'conservative' | 'differential' | 'news-sensitive';

export interface ExperimentConfig {
  id: ExperimentConfigId;
  promptBias: string;
  model: string;
  deterministicTemperature: number;
  stochasticTemperature: number;
  candidateCount: number;
  allowHits: boolean;
  hitThreshold: number;
  preferDifferentials: boolean;
  newsSensitivity: 'normal' | 'high';
}

export const EXPERIMENT_CONFIGS: ExperimentConfig[] = [
  {
    id: 'balanced',
    promptBias: 'Choose the candidate with the best balance of projected points, transfer discipline, and captaincy reliability.',
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    deterministicTemperature: 0,
    stochasticTemperature: 0.4,
    candidateCount: 6,
    allowHits: false,
    hitThreshold: 4.5,
    preferDifferentials: false,
    newsSensitivity: 'normal',
  },
  {
    id: 'aggressive',
    promptBias: 'Prefer upside. Accept calculated hits and bold captain choices when projected gain justifies the risk.',
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    deterministicTemperature: 0,
    stochasticTemperature: 0.7,
    candidateCount: 8,
    allowHits: true,
    hitThreshold: 3.5,
    preferDifferentials: false,
    newsSensitivity: 'normal',
  },
  {
    id: 'conservative',
    promptBias: 'Prefer robust choices. Avoid unnecessary transfers and never take hits unless explicitly unavailable in this config.',
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    deterministicTemperature: 0,
    stochasticTemperature: 0.2,
    candidateCount: 5,
    allowHits: false,
    hitThreshold: Number.POSITIVE_INFINITY,
    preferDifferentials: false,
    newsSensitivity: 'normal',
  },
  {
    id: 'differential',
    promptBias: 'Prefer high-upside lower-owned candidates when projected points are close. Do not sacrifice large expected value gaps.',
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    deterministicTemperature: 0,
    stochasticTemperature: 0.6,
    candidateCount: 8,
    allowHits: false,
    hitThreshold: 4.5,
    preferDifferentials: true,
    newsSensitivity: 'normal',
  },
  {
    id: 'news-sensitive',
    promptBias: 'Use credible news heavily when it affects minutes, injury risk, suspensions, or likely starts. If news is empty, behave like balanced.',
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    deterministicTemperature: 0,
    stochasticTemperature: 0.5,
    candidateCount: 6,
    allowHits: false,
    hitThreshold: 4.5,
    preferDifferentials: false,
    newsSensitivity: 'high',
  },
];

export function selectExperimentConfigs(maxConfigs: number): ExperimentConfig[] {
  if (!Number.isInteger(maxConfigs) || maxConfigs < 1) throw new Error('Invalid max configs');
  return EXPERIMENT_CONFIGS.slice(0, maxConfigs);
}

export function resolveTemperature(config: ExperimentConfig, stochastic: boolean): number {
  return stochastic ? config.stochasticTemperature : config.deterministicTemperature;
}

export function createRunId(): string {
  return randomBytes(4).toString('hex');
}
