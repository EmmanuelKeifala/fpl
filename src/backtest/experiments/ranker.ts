import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HybridRanker, HybridRankerInput, HybridRankerResult } from './hybrid-strategy.js';

export type RankerProvider = (input: HybridRankerInput) => Promise<HybridRankerResult>;

export interface CachedRankerOptions {
  cacheDir: string;
  provider?: RankerProvider;
}

export function createCachedRanker(options: CachedRankerOptions): HybridRanker {
  return async input => {
    const cachePath = rankerCachePath(options.cacheDir, input);
    try {
      return validateSelection(JSON.parse(await readFile(cachePath, 'utf8')) as HybridRankerResult, input);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Corrupt cache should not stop the experiment; regenerate below.
      }
    }

    const provider = options.provider ?? (process.env.OPENAI_API_KEY ? openAiProvider() : deterministicFallbackProvider);
    const result = await selectWithFallback(provider, input);
    await mkdir(join(options.cacheDir, 'ranker'), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  };
}

async function selectWithFallback(provider: RankerProvider, input: HybridRankerInput): Promise<HybridRankerResult> {
  try {
    return validateSelection(await provider(input), input);
  } catch (error) {
    const fallback = bestProjectedCandidate(input);
    return {
      candidateId: fallback.id,
      explanation: `Fallback selected ${fallback.label}; provider failed: ${formatProviderError(error)}.`,
    };
  }
}

function validateSelection(result: HybridRankerResult, input: HybridRankerInput): HybridRankerResult {
  if (input.candidates.some(candidate => candidate.id === result.candidateId)) return result;
  const fallback = bestProjectedCandidate(input);
  return { candidateId: fallback.id, explanation: `Fallback selected ${fallback.label}; provider returned invalid candidate ${result.candidateId}.` };
}

function formatProviderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deterministicFallbackProvider(input: HybridRankerInput): Promise<HybridRankerResult> {
  const selected = bestProjectedCandidate(input);
  return Promise.resolve({ candidateId: selected.id, explanation: `No LLM provider configured; selected highest projected candidate ${selected.label}.` });
}

function bestProjectedCandidate(input: HybridRankerInput) {
  return [...input.candidates].sort((a, b) => b.projectedPoints - a.projectedPoints || a.id.localeCompare(b.id))[0]!;
}

function openAiProvider(): RankerProvider {
  return async input => {
    const candidateIds = input.candidates.map(candidate => candidate.id);
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: input.config.model,
        temperature: input.temperature,
        input: [
          { role: 'system', content: `You rank legal Fantasy Premier League backtest candidates. Return only JSON with candidateId and explanation. Strategy bias: ${input.config.promptBias}` },
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
    config: {
      id: input.config.id,
      promptBias: input.config.promptBias,
      preferDifferentials: input.config.preferDifferentials,
      newsSensitivity: input.config.newsSensitivity,
    },
    stochastic: input.stochastic,
    runId: input.runId,
    candidates: input.candidates.map(candidate => ({
      id: candidate.id,
      label: candidate.label,
      projectedPoints: candidate.projectedPoints,
      transfers: candidate.decision.transfers,
      captain: candidate.decision.captain,
      chip: candidate.decision.chip,
      selectedByPercent: candidate.decision.startingXi
        .map(playerId => input.snapshot.knownBeforeDeadline.players.find(player => player.id === playerId)?.selectedByPercent ?? 0)
        .reduce((total, value) => total + value, 0),
    })),
    news: input.news,
  };
}

function rankerCachePath(cacheDir: string, input: HybridRankerInput): string {
  const hash = createHash('sha256').update(JSON.stringify({ model: input.config.model, temperature: input.temperature, input: compactRankerInput(input) })).digest('hex').slice(0, 24);
  return join(cacheDir, 'ranker', `${input.snapshot.season}-gw${input.snapshot.gameweek}-${input.mode}-${input.configId}-${hash}.json`);
}
