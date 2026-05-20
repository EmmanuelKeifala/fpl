import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BacktestDataSource, getDefaultBacktestCacheDir, type BacktestSourceDescriptor } from './data-source.js';
import { BacktestEngine } from './engine.js';
import { normalizeVaastavSnapshots } from './normalizer.js';
import { buildBacktestReport, formatBacktestSummary } from './report.js';
import { FileSnapshotStore } from './snapshots.js';
import { deterministicStrategy } from './strategies/baseline.js';

export { deterministicStrategy } from './strategies/baseline.js';

interface PrepareDataDependencies {
  preparedCacheDir?: string;
  dataSource?: Pick<BacktestDataSource, 'prepare'>;
  normalizeSnapshots?: typeof normalizeVaastavSnapshots;
  now?: () => Date;
  log?: (message: string) => void;
}

const SEASON = '2024-2025';
const VAASTAV_BASE = 'https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data/2024-25';
const SOURCE_URLS = [
  'https://api.github.com/repos/vaastav/Fantasy-Premier-League/contents/data/2024-25?ref=master',
  `${VAASTAV_BASE}/fixtures.csv`,
  `${VAASTAV_BASE}/teams.csv`,
  ...Array.from({ length: 38 }, (_, index) => `${VAASTAV_BASE}/gws/gw${index + 1}.csv`),
  ...Array.from({ length: 38 }, (_, index) => `${VAASTAV_BASE}/gws/xP${index + 1}.csv`),
];

const SOURCE_DESCRIPTORS: BacktestSourceDescriptor[] = [
  { url: SOURCE_URLS[0], fileName: 'source-listing.json', format: 'json' },
  { url: `${VAASTAV_BASE}/fixtures.csv`, fileName: 'fixtures.csv', format: 'text' },
  { url: `${VAASTAV_BASE}/teams.csv`, fileName: 'teams.csv', format: 'text' },
  ...Array.from({ length: 38 }, (_, index) => ({
    url: `${VAASTAV_BASE}/gws/gw${index + 1}.csv`,
    fileName: `gw-raw-${index + 1}.csv`,
    format: 'text' as const,
  })),
  ...Array.from({ length: 38 }, (_, index) => ({
    url: `${VAASTAV_BASE}/gws/xP${index + 1}.csv`,
    fileName: `xp-raw-${index + 1}.csv`,
    format: 'text' as const,
    optional: true,
  })),
];

function cacheDir(): string {
  return process.env.FPL_BACKTEST_CACHE_DIR ?? getDefaultBacktestCacheDir(SEASON);
}

export function formatPrepareDataMessage(preparedCacheDir: string): string {
  return `Prepared ${SEASON} replay cache at ${preparedCacheDir} with gw-1.json through gw-38.json.`;
}

export async function prepareData(): Promise<void> {
  await prepareDataWithDependencies();
}

export async function prepareDataWithDependencies(dependencies: PrepareDataDependencies = {}): Promise<void> {
  const preparedCacheDir = dependencies.preparedCacheDir ?? cacheDir();
  const downloadedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const dataSource =
    dependencies.dataSource ??
    new BacktestDataSource({
      season: SEASON,
      cacheDir: preparedCacheDir,
      sourceUrls: SOURCE_URLS,
      sources: SOURCE_DESCRIPTORS,
      now: () => new Date(downloadedAt),
    });
  await dataSource.prepare();
  try {
    await (dependencies.normalizeSnapshots ?? normalizeVaastavSnapshots)({
      season: SEASON,
      cacheDir: preparedCacheDir,
      gameweeks: Array.from({ length: 38 }, (_, index) => index + 1),
      sourceUrls: SOURCE_URLS,
      downloadedAt,
      snapshotVersion: `${SEASON}-v1`,
    });
  } catch (error) {
    await removeManifest(preparedCacheDir);
    throw error;
  }
  (dependencies.log ?? console.log)(formatPrepareDataMessage(preparedCacheDir));
}

async function removeManifest(preparedCacheDir: string): Promise<void> {
  try {
    await unlink(join(preparedCacheDir, 'manifest.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function runSeason(): Promise<void> {
  const store = new FileSnapshotStore(cacheDir());
  const firstSnapshot = await store.getSnapshot(1);
  const engine = new BacktestEngine({
    season: SEASON,
    gameweeks: Array.from({ length: 38 }, (_, index) => index + 1),
    getSnapshot: gameweek => store.getSnapshot(gameweek),
    strategy: deterministicStrategy(),
  });
  const state = await engine.run();
  const report = buildBacktestReport(state, firstSnapshot.provenance);
  console.log(formatBacktestSummary(report));
  console.log(JSON.stringify(report, null, 2));
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === 'prepare-data') {
    await prepareData();
  } else if (command === 'run-season') {
    await runSeason();
  } else {
    console.error('Usage: tsx src/backtest/index.ts <prepare-data|run-season>');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
