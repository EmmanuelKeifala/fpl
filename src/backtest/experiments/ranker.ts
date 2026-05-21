import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HybridRanker, HybridRankerInput, HybridRankerResult } from './hybrid-strategy.js';

export type RankerProvider = (input: HybridRankerInput) => Promise<HybridRankerResult>;

export interface CachedRankerOptions {
  cacheDir: string;
  model?: string;
  provider?: RankerProvider;
}

export function createCachedRanker(options: CachedRankerOptions): HybridRanker {
  const model = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  return async input => {
    const cachePath = rankerCachePath(options.cacheDir, model, input);
    try {
      return validateSelection(JSON.parse(await readFile(cachePath, 'utf8')) as HybridRankerResult, input);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Corrupt cache should not stop the experiment; regenerate below.
      }
    }

    const provider = options.provider ?? (process.env.OPENAI_API_KEY ? openAiProvider(model) : deterministicFallbackProvider);
    const result = validateSelection(await provider(input), input);
    await mkdir(join(options.cacheDir, 'ranker'), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  };
}

function validateSelection(result: HybridRankerResult, input: HybridRankerInput): HybridRankerResult {
  if (input.candidates.some(candidate => candidate.id === result.candidateId)) return result;
  const fallback = bestProjectedCandidate(input);
  return { candidateId: fallback.id, explanation: `Fallback selected ${fallback.label}; provider returned invalid candidate ${result.candidateId}.` };
}

function deterministicFallbackProvider(input: HybridRankerInput): Promise<HybridRankerResult> {
  const selected = bestProjectedCandidate(input);
  return Promise.resolve({ candidateId: selected.id, explanation: `No LLM provider configured; selected highest projected candidate ${selected.label}.` });
}

function bestProjectedCandidate(input: HybridRankerInput) {
  return [...input.candidates].sort((a, b) => b.projectedPoints - a.projectedPoints || a.id.localeCompare(b.id))[0]!;
}

function openAiProvider(model: string): RankerProvider {
  return async input => {
    const candidateIds = input.candidates.map(candidate => candidate.id);
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        input: [
          { role: 'system', content: 'You rank legal Fantasy Premier League backtest candidates. Return only JSON with candidateId and explanation.' },
          { role: 'user', content: JSON.stringify(compactRankerInput(input)) },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'fpl_candidate_ranking',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                candidateId: { type: 'string', enum: candidateIds },
                explanation: { type: 'string' },
              },
              required: ['candidateId', 'explanation'],
            },
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`OpenAI ranker failed with ${response.status}`);
    const body = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const text = body.output_text ?? body.output?.flatMap(item => item.content ?? []).map(item => item.text).find(Boolean);
    if (!text) throw new Error('OpenAI ranker returned no text');
    return JSON.parse(text) as HybridRankerResult;
  };
}

function compactRankerInput(input: HybridRankerInput) {
  return {
    season: input.snapshot.season,
    gameweek: input.snapshot.gameweek,
    mode: input.mode,
    configId: input.configId,
    candidates: input.candidates.map(candidate => ({
      id: candidate.id,
      label: candidate.label,
      projectedPoints: candidate.projectedPoints,
      transfers: candidate.decision.transfers,
      captain: candidate.decision.captain,
      chip: candidate.decision.chip,
    })),
    news: input.news,
  };
}

function rankerCachePath(cacheDir: string, model: string, input: HybridRankerInput): string {
  const hash = createHash('sha256').update(JSON.stringify({ model, input: compactRankerInput(input) })).digest('hex').slice(0, 24);
  return join(cacheDir, 'ranker', `${input.snapshot.season}-gw${input.snapshot.gameweek}-${input.mode}-${input.configId}-${hash}.json`);
}
