import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BacktestEngine } from '../engine.js';
import { buildBacktestReport } from '../report.js';
import { FileSnapshotStore } from '../snapshots.js';
import { createFairStrategy } from '../strategies/fair.js';
import { getDefaultBacktestCacheDir } from '../data-source.js';
import { createRunId, resolveTemperature, selectExperimentConfigs, type ExperimentConfig } from './configs.js';
import { createHybridStrategy } from './hybrid-strategy.js';
import { getNewsContext, type NewsMode } from './news.js';
import { createCachedRanker } from './ranker.js';

export type ExperimentMode = 'fair' | NewsMode;

export interface ExperimentOptions {
  seasons: string[];
  allowLlmNews: boolean;
  liveNews: boolean;
  cacheDir: string;
  maxConfigs: number;
  stochastic: boolean;
  runId?: string;
}

export interface ExperimentRow {
  season: string;
  mode: ExperimentMode;
  configId: string;
  totalPoints: number;
  transfers: number;
  chips: number;
  captainPointsTotal: number;
  benchPointsTotal: number;
  warnings: string[];
  model: string;
  temperature: number;
  stochastic: boolean;
  runId?: string;
  choiceCounts: Record<string, number>;
  fallbackCount: number;
  deltaVsFair?: number;
}

export interface ExperimentSummary {
  rows: ExperimentRow[];
  configs: Array<{ configId: string; mode: ExperimentMode; averagePoints: number }>;
}

const DEFAULT_SEASONS = ['2021-2022', '2022-2023', '2023-2024', '2024-2025'];

export function parseExperimentOptions(args: string[]): ExperimentOptions {
  const seasonsArg = args.find(arg => arg.startsWith('--seasons='));
  const cacheArg = args.find(arg => arg.startsWith('--cache-dir='));
  const maxConfigsArg = args.find(arg => arg.startsWith('--max-configs='));
  const runIdArg = args.find(arg => arg.startsWith('--run-id='));
  const maxConfigs = Number(maxConfigsArg?.split('=')[1] ?? 3);
  const stochastic = args.includes('--stochastic');
  if (!Number.isInteger(maxConfigs) || maxConfigs < 1) throw new Error('Invalid max configs');
  return {
    seasons: seasonsArg ? seasonsArg.split('=')[1]!.split(',').filter(Boolean) : DEFAULT_SEASONS,
    allowLlmNews: args.includes('--allow-llm-news'),
    liveNews: args.includes('--live-news'),
    cacheDir: cacheArg?.split('=')[1] ?? 'data/experiments',
    maxConfigs,
    stochastic,
    runId: runIdArg?.split('=')[1] ?? (stochastic ? createRunId() : undefined),
  };
}

export function buildExperimentSummary(rows: ExperimentRow[]): ExperimentSummary {
  const fairBySeason = new Map(rows.filter(row => row.mode === 'fair').map(row => [row.season, row.totalPoints]));
  const rowsWithDelta = rows.map(row => ({
    ...row,
    deltaVsFair: row.mode === 'fair' ? 0 : row.totalPoints - (fairBySeason.get(row.season) ?? row.totalPoints),
  }));
  const configKeys = new Map<string, ExperimentRow[]>();
  for (const row of rowsWithDelta) {
    const key = `${row.mode}:${row.configId}`;
    configKeys.set(key, [...(configKeys.get(key) ?? []), row]);
  }
  const configs = [...configKeys.values()].map(configRows => ({
    configId: configRows[0]!.configId,
    mode: configRows[0]!.mode,
    averagePoints: configRows.reduce((total, row) => total + row.totalPoints, 0) / configRows.length,
  }));
  return { rows: rowsWithDelta, configs };
}

export async function runExperimentMatrix(options: ExperimentOptions): Promise<ExperimentSummary> {
  const llmModes: NewsMode[] = options.allowLlmNews ? ['llm-news-strict', 'llm-news-loose'] : [];
  const configs = selectExperimentConfigs(options.maxConfigs);
  const rows: ExperimentRow[] = [];
  for (const season of options.seasons) {
    rows.push(await runExperimentSeason(season, 'fair', undefined, options));
    for (const mode of llmModes) {
      for (const config of configs) {
        rows.push(await runExperimentSeason(season, mode, config, options));
      }
    }
  }
  const summary = buildExperimentSummary(rows);
  await mkdir(options.cacheDir, { recursive: true });
  await writeFile(join(options.cacheDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function runExperimentSeason(season: string, mode: ExperimentMode, config: ExperimentConfig | undefined, options: ExperimentOptions): Promise<ExperimentRow> {
  const snapshotStore = new FileSnapshotStore(getDefaultBacktestCacheDir(season));
  const firstSnapshot = await snapshotStore.getSnapshot(1);
  const warnings: string[] = [];
  const temperature = config ? resolveTemperature(config, options.stochastic) : 0;
  const strategy = mode === 'fair' || !config
    ? createFairStrategy()
    : createHybridStrategy({
      mode,
      config,
      temperature,
      stochastic: options.stochastic,
      runId: options.runId,
      ranker: createCachedRanker({ cacheDir: options.cacheDir }),
      getNews: async ({ snapshot }) => {
        if (!options.liveNews) {
          warnings.push(`${season} GW${snapshot.gameweek}: Live news disabled; run with --live-news to fetch historical articles.`);
          return [];
        }
        const context = await getNewsContext({ cacheDir: join(options.cacheDir, 'news'), season, gameweek: snapshot.gameweek, deadline: snapshot.deadline, mode });
        warnings.push(...context.warnings.map(warning => `${season} GW${snapshot.gameweek}: ${warning}`));
        return context.items;
      },
    });

  const engine = new BacktestEngine({
    season,
    gameweeks: Array.from({ length: 38 }, (_, index) => index + 1),
    getSnapshot: gameweek => snapshotStore.getSnapshot(gameweek),
    strategy,
  });
  const state = await engine.run();
  const report = buildBacktestReport(state, firstSnapshot.provenance, mode === 'fair' ? 'fair' : 'fair');
  const telemetry = summarizeExperimentDecisionTelemetry(state.decisions);
  return {
    season,
    mode,
    configId: mode === 'fair' ? 'fair-default' : config!.id,
    model: config?.model ?? 'deterministic-fair',
    temperature,
    stochastic: options.stochastic,
    runId: options.runId,
    totalPoints: report.totalPoints,
    transfers: report.transfers.length,
    chips: report.chips.length,
    captainPointsTotal: report.captainPointsTotal,
    benchPointsTotal: report.benchPointsTotal,
    warnings,
    choiceCounts: telemetry.choiceCounts,
    fallbackCount: telemetry.fallbackCount,
  };
}

export function formatExperimentSummary(summary: ExperimentSummary): string {
  const runIds = [...new Set(summary.rows.map(row => row.runId).filter(Boolean))];
  return [
    'Experiment summary',
    ...runIds.map(runId => `stochastic run id: ${runId}`),
    ...summary.configs.map(config => `${config.mode}/${config.configId}: ${config.averagePoints.toFixed(1)} avg points`),
  ].join('\n');
}

export function summarizeExperimentDecisionTelemetry(decisions: Array<{ notes: string[] }>): { choiceCounts: Record<string, number>; fallbackCount: number } {
  return {
    choiceCounts: summarizeChoiceCounts(decisions),
    fallbackCount: countFallbacks(decisions),
  };
}

function summarizeChoiceCounts(decisions: Array<{ notes: string[] }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const decision of decisions) {
    const note = decision.notes.find(value => value.startsWith('LLM hybrid selected '));
    if (!note) continue;
    const candidateId = note.slice('LLM hybrid selected '.length).split(':')[0] ?? 'unknown';
    const prefix = candidateId.split('-')[0] ?? candidateId;
    counts[prefix] = (counts[prefix] ?? 0) + 1;
  }
  return counts;
}

function countFallbacks(decisions: Array<{ notes: string[] }>): number {
  return decisions.flatMap(decision => decision.notes).filter(note => /fallback|no llm provider|provider failed|invalid candidate/i.test(note)).length;
}
