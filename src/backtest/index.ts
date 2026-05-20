import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FPL_RULES, POSITION_BY_ELEMENT_TYPE, type PositionKey } from '../strategy/rules.js';
import { BacktestDataSource, getDefaultBacktestCacheDir, type BacktestSourceDescriptor } from './data-source.js';
import { BacktestEngine } from './engine.js';
import { normalizeVaastavSnapshots } from './normalizer.js';
import { buildBacktestReport, formatBacktestSummary } from './report.js';
import { FileSnapshotStore } from './snapshots.js';
import type { BacktestPlayer, BacktestStrategy } from './types.js';

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

export function deterministicStrategy(): BacktestStrategy {
  return ({ state, snapshot }) => {
    const playersById = new Map(snapshot.knownBeforeDeadline.players.map(player => [player.id, player]));
    const squad = snapshot.gameweek === 1 ? buildInitialSquad(snapshot.knownBeforeDeadline.players) : undefined;
    const lineupPool = squad ?? state.squad.map(pick => pick.playerId);
    const startingXi = selectStartingXi(lineupPool, playersById);
    const startingIds = new Set(startingXi);
    const bench = rankPlayerIds(
      lineupPool.filter(playerId => !startingIds.has(playerId)),
      playersById
    );

    return {
      gameweek: snapshot.gameweek,
      squad,
      transfers: [],
      startingXi,
      bench,
      captain: startingXi[0],
      viceCaptain: startingXi[1],
      notes: ['Deterministic baseline strategy for replay plumbing'],
    };
  };
}

function selectStartingXi(playerIds: number[], playersById: Map<number, BacktestPlayer>): number[] {
  const players = playerIds.map(playerId => {
    const player = playersById.get(playerId);
    if (!player) throw new Error(`Player ${playerId} is missing from gameweek snapshot`);
    return player;
  });
  const rankedByPosition = new Map<PositionKey, BacktestPlayer[]>();
  for (const position of Object.keys(FPL_RULES.squadComposition) as PositionKey[]) {
    rankedByPosition.set(
      position,
      rankPlayers(players.filter(player => POSITION_BY_ELEMENT_TYPE[player.elementType] === position))
    );
  }

  let bestStartingXi: BacktestPlayer[] | undefined;
  let bestScore = -Infinity;
  const goalkeeperCount = FPL_RULES.formation.goalkeeper.min;

  for (let defenderCount = FPL_RULES.formation.defender.min; defenderCount <= FPL_RULES.formation.defender.max; defenderCount++) {
    for (let midfielderCount = FPL_RULES.formation.midfielder.min; midfielderCount <= FPL_RULES.formation.midfielder.max; midfielderCount++) {
      const forwardCount = FPL_RULES.startingSize - goalkeeperCount - defenderCount - midfielderCount;
      if (forwardCount < FPL_RULES.formation.forward.min || forwardCount > FPL_RULES.formation.forward.max) continue;

      const candidate = [
        ...topRanked(rankedByPosition, 'goalkeeper', goalkeeperCount),
        ...topRanked(rankedByPosition, 'defender', defenderCount),
        ...topRanked(rankedByPosition, 'midfielder', midfielderCount),
        ...topRanked(rankedByPosition, 'forward', forwardCount),
      ];
      if (candidate.length !== FPL_RULES.startingSize) continue;

      const orderedCandidate = rankPlayers(candidate);
      const score = orderedCandidate.reduce((total, player) => total + player.expectedPoints, 0);
      if (!bestStartingXi || score > bestScore || (score === bestScore && comparePlayerLists(orderedCandidate, bestStartingXi) < 0)) {
        bestStartingXi = orderedCandidate;
        bestScore = score;
      }
    }
  }

  if (!bestStartingXi) throw new Error('No deterministic starting XI satisfies formation rules');
  return bestStartingXi.map(player => player.id);
}

function topRanked(rankedByPosition: Map<PositionKey, BacktestPlayer[]>, position: PositionKey, count: number): BacktestPlayer[] {
  const players = rankedByPosition.get(position) ?? [];
  return players.length >= count ? players.slice(0, count) : [];
}

function comparePlayerLists(left: BacktestPlayer[], right: BacktestPlayer[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index]!.id !== right[index]!.id) return left[index]!.id - right[index]!.id;
  }
  return left.length - right.length;
}

function buildInitialSquad(players: BacktestPlayer[]): number[] {
  const ranked = rankPlayers(players);
  const selected: BacktestPlayer[] = [];
  let spent = 0;

  while (selected.length < FPL_RULES.squadSize) {
    const remaining = ranked.filter(player => !selected.some(selectedPlayer => selectedPlayer.id === player.id));
    const candidate = remaining.find(player => {
      const minimumRemainingCost = minimumCostToCompleteSquad([...selected, player], remaining.filter(otherPlayer => otherPlayer.id !== player.id));
      if (minimumRemainingCost === undefined) return false;
      return spent + player.price + minimumRemainingCost <= FPL_RULES.initialBudget;
    });

    if (!candidate) {
      throw new Error(`No deterministic ${FPL_RULES.squadSize}-player squad fits the ${FPL_RULES.initialBudget} budget`);
    }

    selected.push(candidate);
    spent += candidate.price;
  }

  return selected.map(player => player.id);
}

function minimumCostToCompleteSquad(selected: BacktestPlayer[], remaining: BacktestPlayer[]): number | undefined {
  const selectedPositionCounts = countSelectedByPosition(selected);
  const selectedTeamCounts = countSelectedByTeam(selected);
  for (const [position, expected] of Object.entries(FPL_RULES.squadComposition)) {
    if (selectedPositionCounts[position as PositionKey] > expected) return undefined;
  }
  if ([...selectedTeamCounts.values()].some(count => count > FPL_RULES.maxPlayersPerClub)) return undefined;

  let cost = 0;
  const teamCounts = new Map(selectedTeamCounts);

  for (const [position, expected] of Object.entries(FPL_RULES.squadComposition)) {
    const positionKey = position as PositionKey;
    const required = expected - selectedPositionCounts[positionKey];
    const cheapest = remaining
      .filter(player => POSITION_BY_ELEMENT_TYPE[player.elementType] === positionKey)
      .sort((a, b) => a.price - b.price || a.id - b.id);

    for (let index = 0; index < required; index++) {
      const player = cheapest.find(candidate => (teamCounts.get(candidate.team) ?? 0) < FPL_RULES.maxPlayersPerClub);
      if (!player) return undefined;
      cost += player.price;
      teamCounts.set(player.team, (teamCounts.get(player.team) ?? 0) + 1);
      cheapest.splice(cheapest.indexOf(player), 1);
    }
  }

  return cost;
}

function countSelectedByPosition(players: BacktestPlayer[]): Record<PositionKey, number> {
  const counts: Record<PositionKey, number> = { goalkeeper: 0, defender: 0, midfielder: 0, forward: 0 };
  for (const player of players) {
    const position = POSITION_BY_ELEMENT_TYPE[player.elementType];
    if (position) counts[position]++;
  }
  return counts;
}

function countSelectedByTeam(players: BacktestPlayer[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const player of players) {
    counts.set(player.team, (counts.get(player.team) ?? 0) + 1);
  }
  return counts;
}

function rankPlayerIds(playerIds: number[], playersById: Map<number, BacktestPlayer>): number[] {
  return [...playerIds].sort((a, b) => {
    const playerA = playersById.get(a);
    const playerB = playersById.get(b);
    if (!playerA) throw new Error(`Player ${a} is missing from gameweek snapshot`);
    if (!playerB) throw new Error(`Player ${b} is missing from gameweek snapshot`);

    return playerB.expectedPoints - playerA.expectedPoints || a - b;
  });
}

function rankPlayers(players: BacktestPlayer[]): BacktestPlayer[] {
  return [...players].sort((a, b) => b.expectedPoints - a.expectedPoints || a.id - b.id);
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
