import { BacktestDataSource, getDefaultBacktestCacheDir } from './data-source.js';
import { BacktestEngine } from './engine.js';
import { buildBacktestReport, formatBacktestSummary } from './report.js';
import { FileSnapshotStore } from './snapshots.js';
import type { BacktestDecision } from './types.js';

const SEASON = '2024-2025';
const SOURCE_URLS = [
  'https://api.github.com/repos/vaastav/Fantasy-Premier-League/contents/data/2024-25?ref=master',
];

function cacheDir(): string {
  return process.env.FPL_BACKTEST_CACHE_DIR ?? getDefaultBacktestCacheDir(SEASON);
}

async function prepareData(): Promise<void> {
  const dataSource = new BacktestDataSource({ season: SEASON, cacheDir: cacheDir(), sourceUrls: SOURCE_URLS });
  await dataSource.prepare();
  console.log(`Prepared ${SEASON} backtest cache at ${cacheDir()}`);
}

function deterministicStrategy(): (context: { snapshot: { gameweek: number; knownBeforeDeadline: { players: { id: number; expectedPoints: number }[] } } }) => BacktestDecision {
  return ({ snapshot }) => {
    const ordered = [...snapshot.knownBeforeDeadline.players].sort((a, b) => b.expectedPoints - a.expectedPoints);
    const squad = ordered.slice(0, 15).map(player => player.id);
    const startingXi = squad.slice(0, 11);
    const bench = squad.slice(11);
    return {
      gameweek: snapshot.gameweek,
      squad: snapshot.gameweek === 1 ? squad : undefined,
      transfers: [],
      startingXi,
      bench,
      captain: startingXi[0],
      viceCaptain: startingXi[1],
      notes: ['Deterministic baseline strategy for replay plumbing'],
    };
  };
}

async function runSeason(): Promise<void> {
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

const command = process.argv[2];

if (command === 'prepare-data') {
  await prepareData();
} else if (command === 'run-season') {
  await runSeason();
} else {
  console.error('Usage: tsx src/backtest/index.ts <prepare-data|run-season>');
  process.exitCode = 1;
}
