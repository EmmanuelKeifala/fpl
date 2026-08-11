import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BacktestDataSource,
  getDefaultBacktestCacheDir,
  type BacktestManifest,
  type BacktestSourceDescriptor,
} from './data-source.js';
import { BacktestEngine } from './engine.js';
import { normalizeVaastavSnapshots } from './normalizer.js';
import { buildBacktestReport, formatBacktestSummary } from './report.js';
import type { BacktestStrategyName } from './report.js';
import { FileSnapshotStore } from './snapshots.js';
import { deterministicStrategy } from './strategies/baseline.js';
import { createFairStrategy } from './strategies/fair.js';
import { createAutonomousReplayStrategy } from './strategies/autonomous.js';
import {
  createDeploymentReplayStrategy,
  DEPLOYMENT_REPLAY_PROFILE,
  ML_DEPLOYMENT_REPLAY_POLICY,
  ML_DEPLOYMENT_REPLAY_PROFILE,
} from './strategies/deployment.js';
import { applyReplayPredictionOverlay, loadReplayPredictionOverlay } from '../ml/replay-predictions.js';
import { createOracleStrategy } from './strategies/oracle.js';
import { formatExperimentSummary, parseExperimentOptions, runExperimentMatrix } from './experiments/runner.js';
import { getSeasonRules } from './season-rules.js';
import type { ReplayDataMode } from './types.js';

export { deterministicStrategy } from './strategies/baseline.js';

export interface RunOptions { strategy: BacktestStrategyName; season: string; dataMode?: ReplayDataMode; top10kCutoff?: number; }

export function parseRunOptions(args: string[]): RunOptions {
  const strategyArg = args.find(arg => arg.startsWith('--strategy='));
  const seasonArg = args.find(arg => arg.startsWith('--season='));
  const top10kArg = args.find(arg => arg.startsWith('--top10k-cutoff='));
  const dataModeArg = args.find(arg => arg.startsWith('--data-mode='));
  const strategy = (strategyArg?.split('=')[1] ?? 'baseline') as BacktestStrategyName;
  if (!['baseline', 'fair', 'autonomous', 'deployment', 'deployment-ml', 'oracle'].includes(strategy)) throw new Error(`Unknown strategy ${strategy}`);
  const top10kCutoff = top10kArg ? Number(top10kArg.split('=')[1]) : undefined;
  if (top10kCutoff !== undefined && (!Number.isInteger(top10kCutoff) || top10kCutoff <= 0)) {
    throw new Error('Top-10k cutoff must be a positive integer');
  }
  const dataMode = dataModeArg?.split('=')[1] as ReplayDataMode | undefined;
  if (dataMode !== undefined && !['legacy', 'reconstructed', 'strict'].includes(dataMode)) {
    throw new Error(`Unknown data mode ${dataMode}`);
  }
  return {
    strategy,
    season: parseSeason(seasonArg?.split('=')[1] ?? DEFAULT_SEASON),
    ...(dataMode !== undefined ? { dataMode } : {}),
    ...(top10kCutoff !== undefined ? { top10kCutoff } : {}),
  };
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

function getVaastavSources(season: string, dataMode: ReplayDataMode): { sourceUrls: string[]; sourceDescriptors: BacktestSourceDescriptor[] } {
  const vaastavSeason = toVaastavSeasonPath(season);
  const base = `https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data/${vaastavSeason}`;
  const listing = `https://api.github.com/repos/vaastav/Fantasy-Premier-League/contents/data/${vaastavSeason}?ref=master`;
  const archivedBootstrap = {
    '2024-2025': 'https://web.archive.org/web/20250625000001id_/https://fantasy.premierleague.com/api/bootstrap-static/',
    '2025-2026': 'https://web.archive.org/web/20260624000027id_/https://fantasy.premierleague.com/api/bootstrap-static/',
  }[season];
  const sourceUrls = [
    listing,
    `${base}/fixtures.csv`,
    `${base}/teams.csv`,
    ...Array.from({ length: 38 }, (_, index) => `${base}/gws/gw${index + 1}.csv`),
    ...(dataMode === 'legacy' ? Array.from({ length: 38 }, (_, index) => `${base}/gws/xP${index + 1}.csv`) : []),
    ...(archivedBootstrap ? [archivedBootstrap] : []),
  ];

  return {
    sourceUrls,
    sourceDescriptors: [
      { url: sourceUrls[0], fileName: 'source-listing.json', format: 'json' },
      { url: `${base}/fixtures.csv`, fileName: 'fixtures.csv', format: 'text' },
      { url: `${base}/teams.csv`, fileName: 'teams.csv', format: 'text' },
      ...(archivedBootstrap
        ? [{ url: archivedBootstrap, fileName: 'season-bootstrap.json', format: 'json' as const }]
        : []),
      ...Array.from({ length: 38 }, (_, index) => ({
        url: `${base}/gws/gw${index + 1}.csv`,
        fileName: `gw-raw-${index + 1}.csv`,
        format: 'text' as const,
      })),
      ...(dataMode === 'legacy' ? Array.from({ length: 38 }, (_, index) => ({
        url: `${base}/gws/xP${index + 1}.csv`,
        fileName: `xp-raw-${index + 1}.csv`,
        format: 'text' as const,
        optional: true,
      })) : []),
    ],
  };
}

function cacheDir(season: string, dataMode: ReplayDataMode): string {
  return process.env.FPL_BACKTEST_CACHE_DIR ?? getDefaultBacktestCacheDir(season, dataMode);
}

export function formatPrepareDataMessage(preparedCacheDir: string, season = DEFAULT_SEASON): string {
  return `Prepared ${season} replay cache at ${preparedCacheDir} with gw-1.json through gw-38.json.`;
}

export async function prepareData(options: Pick<RunOptions, 'season' | 'dataMode'> = { season: DEFAULT_SEASON }): Promise<void> {
  await prepareDataWithDependencies({}, options);
}

export async function prepareDataWithDependencies(dependencies: PrepareDataDependencies = {}, options: Pick<RunOptions, 'season' | 'dataMode'> = { season: DEFAULT_SEASON }): Promise<void> {
  const season = parseSeason(options.season);
  const dataMode = options.dataMode ?? 'reconstructed';
  if (dataMode === 'strict') throw new Error('Strict mode requires point-in-time fixture snapshots');
  const rules = getSeasonRules(season);
  const { sourceUrls, sourceDescriptors } = getVaastavSources(season, dataMode);
  const preparedCacheDir = dependencies.preparedCacheDir ?? cacheDir(season, dataMode);
  const downloadedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const dataSource =
    dependencies.dataSource ??
    new BacktestDataSource({
      season,
      dataMode,
      rulesVersion: rules.version,
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
      snapshotVersion: `${season}-${dataMode}-v2`,
      dataMode,
      rulesVersion: rules.version,
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
  const dataMode = options.dataMode ?? 'reconstructed';
  const rules = getSeasonRules(season);
  const preparedCacheDir = cacheDir(season, dataMode);
  const manifest = await loadReplayManifest(preparedCacheDir, season, dataMode, rules.version);
  const store = new FileSnapshotStore(preparedCacheDir, {
    season,
    dataMode,
    rulesVersion: rules.version,
    snapshotVersion: manifest.snapshotVersion,
  });
  const loadedSnapshots = await Promise.all(Array.from({ length: 38 }, (_, index) => store.getSnapshot(index + 1)));
  const snapshots = options.strategy === 'deployment-ml'
    ? applyReplayPredictionOverlay(
      loadedSnapshots,
      await loadReplayPredictionOverlay(
        process.env.FPL_ML_REPLAY_PREDICTIONS
          ?? join(process.cwd(), 'data/ml/player-fixture-v1/out-of-season-predictions.csv'),
        season
      ),
      'player-fixture-v1'
    )
    : loadedSnapshots;
  const firstSnapshot = snapshots[0]!;
  const snapshotsByGameweek = new Map(snapshots.map(snapshot => [snapshot.gameweek, snapshot]));
  const strategy = options.strategy === 'fair'
    ? createFairStrategy()
    : options.strategy === 'deployment' || options.strategy === 'deployment-ml'
      ? createDeploymentReplayStrategy(
        snapshots,
        options.strategy === 'deployment-ml' ? ML_DEPLOYMENT_REPLAY_POLICY : undefined
      )
    : options.strategy === 'autonomous'
      ? createAutonomousReplayStrategy()
    : options.strategy === 'oracle'
      ? createOracleStrategy(snapshots)
      : deterministicStrategy();
  const engine = new BacktestEngine({
    season,
    gameweeks: Array.from({ length: 38 }, (_, index) => index + 1),
    getSnapshot: async gameweek => {
      const snapshot = snapshotsByGameweek.get(gameweek);
      if (!snapshot) throw new Error(`Missing loaded snapshot for GW${gameweek}`);
      return snapshot;
    },
    strategy,
  });
  const state = await engine.run();
  const report = buildBacktestReport(
    state,
    firstSnapshot.provenance,
    options.strategy,
    snapshots,
    options.top10kCutoff,
    options.strategy === 'deployment'
      ? DEPLOYMENT_REPLAY_PROFILE
      : options.strategy === 'deployment-ml'
        ? ML_DEPLOYMENT_REPLAY_PROFILE
        : undefined
  );
  const reportPath = join(cacheDir(season, dataMode), `report-${options.strategy}-${dataMode}.json`);
  const weeklyPath = join(cacheDir(season, dataMode), `report-${options.strategy}-${dataMode}-weekly.csv`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(weeklyPath, [
    'gameweek,points,average,difference,cumulative_points,cumulative_average,cumulative_difference',
    ...report.weeklyBenchmark.map(row => [
      row.gameweek,
      row.points,
      row.averageEntryScore,
      row.difference,
      row.cumulativePoints,
      row.cumulativeAverage,
      row.cumulativeDifference,
    ].join(',')),
  ].join('\n') + '\n');
  console.log(formatBacktestSummary(report));
  console.log(`Report: ${reportPath}`);
  console.log(`Weekly CSV: ${weeklyPath}`);
  console.log(JSON.stringify(report, null, 2));
}

async function loadReplayManifest(
  directory: string,
  season: string,
  dataMode: ReplayDataMode,
  rulesVersion: string
): Promise<BacktestManifest> {
  let manifest: BacktestManifest;
  try {
    manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as BacktestManifest;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Replay cache at ${directory} is not prepared: ${detail}`);
  }
  if (manifest.season !== season) throw new Error(`Replay manifest season ${manifest.season} does not match ${season}`);
  if (manifest.dataMode !== dataMode) throw new Error(`Replay manifest mode ${manifest.dataMode} does not match ${dataMode}`);
  if (manifest.rulesVersion !== rulesVersion) {
    throw new Error(`Replay manifest rules ${manifest.rulesVersion} do not match ${rulesVersion}`);
  }
  if (!manifest.snapshotVersion) throw new Error('Replay manifest snapshot version is missing');
  return manifest;
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
