import { buildCandidateDecisions, type CandidateDecision } from './candidates.js';
import type { ExperimentConfig } from './configs.js';
import type { BacktestDecision, BacktestStrategy, DecisionSnapshotInput, ManagerState } from '../types.js';

export interface HybridRankerInput {
  state: ManagerState;
  snapshot: DecisionSnapshotInput;
  candidates: CandidateDecision[];
  news: unknown[];
  mode: 'llm-news-strict' | 'llm-news-loose';
  configId: string;
  config: ExperimentConfig;
  temperature: number;
  stochastic: boolean;
  runId?: string;
}

export interface HybridRankerResult {
  candidateId: string;
  explanation: string;
}

export type HybridRanker = (input: HybridRankerInput) => Promise<HybridRankerResult>;

export interface HybridStrategyOptions {
  ranker: HybridRanker;
  config: ExperimentConfig;
  temperature: number;
  stochastic: boolean;
  runId?: string;
  mode?: 'llm-news-strict' | 'llm-news-loose';
  getNews?: (input: { state: ManagerState; snapshot: DecisionSnapshotInput; mode: 'llm-news-strict' | 'llm-news-loose' }) => Promise<unknown[]>;
}

export function createHybridStrategy(options: HybridStrategyOptions): BacktestStrategy {
  const mode = options.mode ?? 'llm-news-strict';
  const configId = options.config.id;
  return async ({ state, snapshot }) => {
    const candidates = buildCandidateDecisions({
      state,
      snapshot,
      maxCandidates: options.config.candidateCount,
      allowHits: options.config.allowHits,
      hitThreshold: options.config.hitThreshold,
    });
    const news = await (options.getNews?.({ state, snapshot, mode }) ?? Promise.resolve([]));
    const ranked = await options.ranker({
      state,
      snapshot,
      candidates,
      news,
      mode,
      configId,
      config: options.config,
      temperature: options.temperature,
      stochastic: options.stochastic,
      runId: options.runId,
    });
    const selected = candidates.find(candidate => candidate.id === ranked.candidateId) ?? candidates[0];
    return annotateDecision(selected.decision, selected.id, ranked.explanation);
  };
}

function annotateDecision(decision: BacktestDecision, candidateId: string, explanation: string): BacktestDecision {
  return {
    ...decision,
    notes: [...decision.notes, `LLM hybrid selected ${candidateId}: ${explanation}`],
  };
}
