import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BacktestDataSource, getDefaultBacktestCacheDir, type BacktestSourceDescriptor } from './data-source.js';
import { BacktestEngine } from './engine.js';
import { normalizeVaastavSnapshots } from './normalizer.js';
import { buildBacktestReport, formatBacktestSummary } from './report.js';
import type { BacktestStrategyName } from './report.js';
import { FileSnapshotStore } from './snapshots.js';
import { deterministicStrategy } from './strategies/baseline.js';
import { createFairStrategy } from './strategies/fair.js';
import { createOracleStrategy } from './strategies/oracle.js';
import { formatExperimentSummary, parseExperimentOptions, runExperimentMatrix } from './experiments/runner.js';

export { deterministicStrategy } from './strategies/baseline.js';

export interface RunOptions { strategy: BacktestStrategyName; season: string; }

export function parseRunOptions(args: string[]): RunOptions {
  const strategyArg = args.find(arg => arg.startsWith('--strategy='));
  const seasonArg = args.find(arg => arg.startsWith('--season='));
  const strategy = (strategyArg?.split('=')[1] ?? 'baseline') as BacktestStrategyName;
  if (!['baseline', 'fair', 'oracle'].includes(strategy)) throw new Error(`Unknown strategy ${strategy}`);
  return { strategy, season: parseSeason(seasonArg?.split('=')[1] ?? DEFAULT_SEASON) };
}

export type TopLevelCommand = 'prepare-data' | 'run-season' | 'run-experiment';

export function parseTopLevelCommand(command: string | undefined): TopLevelCommand | undefined {
  if (command === 'prepare-data' || command === 'run-season' || command === 'run-experiment') return command;
  return undefined;
}

interface PrepareDataDependencies {
  preparedCacheDir?: string;
  dataSource?: Pick<BacktestDataSource, 'prepare'>;
  normalizeSnapshots?: typeof normalizeVaastavSnapshots;
  now?: () => Date;
  log?: (message: string) => void;
}

const DEFAULT_SEASON = '2024-2025';

function parseSeason(value: string): string {
  const match = /^(\d{4})-(\d{4})$/.exec(value);
  if (!match) throw new Error(`Invalid season ${value}; expected YYYY-YYYY`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (end !== start + 1) throw new Error(`Invalid season ${value}; end year must follow start year`);
  return value;
}

function toVaastavSeasonPath(season: string): string {
  const [start, end] = season.split('-');
  return `${start}-${end.slice(2)}`;
}

function getVaastavSources(season: string): { sourceUrls: string[]; sourceDescriptors: BacktestSourceDescriptor[] } {
  const vaastavSeason = toVaastavSeasonPath(season);
  const base = `https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data/${vaastavSeason}`;
  const listing = `https://api.github.com/repos/vaastav/Fantasy-Premier-League/contents/data/${vaastavSeason}?ref=master`;
  const sourceUrls = [
    listing,
    `${base}/fixtures.csv`,
    `${base}/teams.csv`,
    ...Array.from({ length: 38 }, (_, index) => `${base}/gws/gw${index + 1}.csv`),
    ...Array.from({ length: 38 }, (_, index) => `${base}/gws/xP${index + 1}.csv`),
  ];

  return {
    sourceUrls,
    sourceDescriptors: [
      { url: sourceUrls[0], fileName: 'source-listing.json', format: 'json' },
      { url: `${base}/fixtures.csv`, fileName: 'fixtures.csv', format: 'text' },
      { url: `${base}/teams.csv`, fileName: 'teams.csv', format: 'text' },
      ...Array.from({ length: 38 }, (_, index) => ({
        url: `${base}/gws/gw${index + 1}.csv`,
        fileName: `gw-raw-${index + 1}.csv`,
        format: 'text' as const,
      })),
      ...Array.from({ length: 38 }, (_, index) => ({
        url: `${base}/gws/xP${index + 1}.csv`,
        fileName: `xp-raw-${index + 1}.csv`,
        format: 'text' as const,
        optional: true,
      })),
    ],
  };
}

function cacheDir(season: string): string {
  return process.env.FPL_BACKTEST_CACHE_DIR ?? getDefaultBacktestCacheDir(season);
}

export function formatPrepareDataMessage(preparedCacheDir: string, season = DEFAULT_SEASON): string {
  return `Prepared ${season} replay cache at ${preparedCacheDir} with gw-1.json through gw-38.json.`;
}

export async function prepareData(options: Pick<RunOptions, 'season'> = { season: DEFAULT_SEASON }): Promise<void> {
  await prepareDataWithDependencies({}, options);
}

export async function prepareDataWithDependencies(dependencies: PrepareDataDependencies = {}, options: Pick<RunOptions, 'season'> = { season: DEFAULT_SEASON }): Promise<void> {
  const season = parseSeason(options.season);
  const { sourceUrls, sourceDescriptors } = getVaastavSources(season);
  const preparedCacheDir = dependencies.preparedCacheDir ?? cacheDir(season);
  const downloadedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const dataSource =
    dependencies.dataSource ??
    new BacktestDataSource({
      season,
      cacheDir: preparedCacheDir,
      sourceUrls,
      sources: sourceDescriptors,
      now: () => new Date(downloadedAt),
    });
  await dataSource.prepare();
  try {
    await (dependencies.normalizeSnapshots ?? normalizeVaastavSnapshots)({
      season,
      cacheDir: preparedCacheDir,
      gameweeks: Array.from({ length: 38 }, (_, index) => index + 1),
      sourceUrls,
      downloadedAt,
      snapshotVersion: `${season}-v1`,
    });
  } catch (error) {
    await removeManifest(preparedCacheDir);
    throw error;
  }
  (dependencies.log ?? console.log)(formatPrepareDataMessage(preparedCacheDir, season));
}

async function removeManifest(preparedCacheDir: string): Promise<void> {
  try {
    await unlink(join(preparedCacheDir, 'manifest.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function runSeason(options: RunOptions = { strategy: 'baseline', season: DEFAULT_SEASON }): Promise<void> {
  const season = parseSeason(options.season);
  const store = new FileSnapshotStore(cacheDir(season));
  const firstSnapshot = await store.getSnapshot(1);
  const snapshots = options.strategy === 'oracle'
    ? await Promise.all(Array.from({ length: 38 }, (_, index) => store.getSnapshot(index + 1)))
    : [];
  const strategy = options.strategy === 'fair'
    ? createFairStrategy()
    : options.strategy === 'oracle'
      ? createOracleStrategy(snapshots)
      : deterministicStrategy();
  const engine = new BacktestEngine({
    season,
    gameweeks: Array.from({ length: 38 }, (_, index) => index + 1),
    getSnapshot: gameweek => store.getSnapshot(gameweek),
    strategy,
  });
  const state = await engine.run();
  const report = buildBacktestReport(state, firstSnapshot.provenance, options.strategy);
  console.log(formatBacktestSummary(report));
  console.log(JSON.stringify(report, null, 2));
}

async function main(): Promise<void> {
  const command = parseTopLevelCommand(process.argv[2]);

  if (command === 'prepare-data') {
    await prepareData(parseRunOptions(process.argv.slice(3)));
  } else if (command === 'run-season') {
    await runSeason(parseRunOptions(process.argv.slice(3)));
  } else if (command === 'run-experiment') {
    const summary = await runExperimentMatrix(parseExperimentOptions(process.argv.slice(3)));
    console.log(formatExperimentSummary(summary));
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.error('Usage: tsx src/backtest/index.ts <prepare-data|run-season|run-experiment>');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
