import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BacktestEngine } from '../engine.js';
import { buildBacktestReport } from '../report.js';
import { FileSnapshotStore } from '../snapshots.js';
import { createFairStrategy } from '../strategies/fair.js';
import { getDefaultBacktestCacheDir } from '../data-source.js';
import { EXPERIMENT_CONFIGS, resolveTemperature } from './configs.js';
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
  const maxConfigs = Number(maxConfigsArg?.split('=')[1] ?? 3);
  if (!Number.isInteger(maxConfigs) || maxConfigs < 1) throw new Error('Invalid max configs');
  return {
    seasons: seasonsArg ? seasonsArg.split('=')[1]!.split(',').filter(Boolean) : DEFAULT_SEASONS,
    allowLlmNews: args.includes('--allow-llm-news'),
    liveNews: args.includes('--live-news'),
    cacheDir: cacheArg?.split('=')[1] ?? 'data/experiments',
    maxConfigs,
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
  const modes: ExperimentMode[] = options.allowLlmNews ? ['fair', 'llm-news-strict', 'llm-news-loose'] : ['fair'];
  const rows: ExperimentRow[] = [];
  for (const season of options.seasons) {
    for (const mode of modes.slice(0, options.maxConfigs)) {
      rows.push(await runExperimentSeason(season, mode, options.cacheDir, options.liveNews));
    }
  }
  const summary = buildExperimentSummary(rows);
  await mkdir(options.cacheDir, { recursive: true });
  await writeFile(join(options.cacheDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function runExperimentSeason(season: string, mode: ExperimentMode, cacheDir: string, liveNews: boolean): Promise<ExperimentRow> {
  const snapshotStore = new FileSnapshotStore(getDefaultBacktestCacheDir(season));
  const firstSnapshot = await snapshotStore.getSnapshot(1);
  const warnings: string[] = [];
  const smokeConfig = EXPERIMENT_CONFIGS[0]!;
  const strategy = mode === 'fair'
    ? createFairStrategy()
    : createHybridStrategy({
      mode,
      config: smokeConfig,
      temperature: resolveTemperature(smokeConfig, false),
      stochastic: false,
      ranker: createCachedRanker({ cacheDir }),
      getNews: async ({ snapshot }) => {
        if (!liveNews) {
          warnings.push(`${season} GW${snapshot.gameweek}: Live news disabled; run with --live-news to fetch historical articles.`);
          return [];
        }
        const context = await getNewsContext({ cacheDir: join(cacheDir, 'news'), season, gameweek: snapshot.gameweek, deadline: snapshot.deadline, mode });
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
  return {
    season,
    mode,
    configId: mode === 'fair' ? 'fair-default' : smokeConfig.id,
    totalPoints: report.totalPoints,
    transfers: report.transfers.length,
    chips: report.chips.length,
    captainPointsTotal: report.captainPointsTotal,
    benchPointsTotal: report.benchPointsTotal,
    warnings,
  };
}

export function formatExperimentSummary(summary: ExperimentSummary): string {
  return [
    'Experiment summary',
    ...summary.configs.map(config => `${config.mode}/${config.configId}: ${config.averagePoints.toFixed(1)} avg points`),
  ].join('\n');
}
