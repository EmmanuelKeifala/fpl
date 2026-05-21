import { buildCandidateDecisions, type CandidateDecision } from './candidates.js';
import type { BacktestDecision, BacktestStrategy, DecisionSnapshotInput, ManagerState } from '../types.js';

export interface HybridRankerInput {
  state: ManagerState;
  snapshot: DecisionSnapshotInput;
  candidates: CandidateDecision[];
  news: unknown[];
  mode: 'llm-news-strict' | 'llm-news-loose';
  configId: string;
}

export interface HybridRankerResult {
  candidateId: string;
  explanation: string;
}

export type HybridRanker = (input: HybridRankerInput) => Promise<HybridRankerResult>;

export interface HybridStrategyOptions {
  ranker: HybridRanker;
  mode?: 'llm-news-strict' | 'llm-news-loose';
  configId?: string;
  getNews?: (input: { state: ManagerState; snapshot: DecisionSnapshotInput; mode: 'llm-news-strict' | 'llm-news-loose' }) => Promise<unknown[]>;
}

export function createHybridStrategy(options: HybridStrategyOptions): BacktestStrategy {
  const mode = options.mode ?? 'llm-news-strict';
  const configId = options.configId ?? 'default';
  return async ({ state, snapshot }) => {
    const candidates = buildCandidateDecisions({ state, snapshot });
    const news = await (options.getNews?.({ state, snapshot, mode }) ?? Promise.resolve([]));
    const ranked = await options.ranker({ state, snapshot, candidates, news, mode, configId });
    const selected = candidates.find(candidate => candidate.id === ranked.candidateId) ?? candidates[0];
    return annotateDecision(selected.decision, ranked.explanation);
  };
}

function annotateDecision(decision: BacktestDecision, explanation: string): BacktestDecision {
  return {
    ...decision,
    notes: [...decision.notes, `LLM hybrid selected: ${explanation}`],
  };
}
