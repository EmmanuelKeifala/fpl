import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCsv, requireColumns, type CsvRow } from './csv.js';
import { validateSnapshot } from './snapshots.js';
import type { BacktestFixture, BacktestPlayer, GameweekSnapshot, PlayerGameweekResult } from './types.js';

export interface NormalizeVaastavSnapshotsOptions {
  season: string;
  cacheDir: string;
  gameweeks: number[];
  sourceUrls: string[];
  downloadedAt: string;
  snapshotVersion: string;
}

const GW_COLUMNS = ['element', 'name', 'position', 'team', 'value', 'xP', 'minutes', 'total_points', 'round', 'kickoff_time'];
const FIXTURE_COLUMNS = ['id', 'event', 'kickoff_time', 'team_h', 'team_a', 'team_h_difficulty', 'team_a_difficulty'];
const XP_COLUMNS = ['element', 'xP'];

const POSITION_BY_NAME: Record<string, number> = {
  GK: 1,
  DEF: 2,
  MID: 3,
  FWD: 4,
};

const UNAVAILABLE_FIELDS = [
  'injury/news history unavailable',
  'exact pre-deadline status unavailable',
  'exact historical deadline times unavailable; earliest kickoff used',
  'historical ownership percentage unavailable; raw selected counts are not used as percentages',
  'rank distribution unavailable/default scores',
];

export async function normalizeVaastavSnapshots(options: NormalizeVaastavSnapshotsOptions): Promise<void> {
  const fixtureRows = await readOptionalCsv(join(options.cacheDir, 'fixtures.csv'), 'fixtures.csv', FIXTURE_COLUMNS);
  const teamRows = await readOptionalCsv(join(options.cacheDir, 'teams.csv'), 'teams.csv');
  const teamsByName = buildTeamsByName(teamRows);
  const fixturesByGameweek = groupFixturesByGameweek(fixtureRows);
  const snapshots: GameweekSnapshot[] = [];

  for (const gameweek of options.gameweeks) {
    const gwFileName = `gw-raw-${gameweek}.csv`;
    const gwRows = await readRequiredCsv(join(options.cacheDir, gwFileName), gwFileName, GW_COLUMNS);
    const xpRows = await readOptionalCsv(join(options.cacheDir, `xp-raw-${gameweek}.csv`), `xp-raw-${gameweek}.csv`, XP_COLUMNS);
    const xpByElement = new Map(xpRows.map(row => [parseNumber(row.element, 'element'), parseNumber(row.xP, 'xP')]));
    const fixtures = fixturesByGameweek.get(gameweek) ?? [];

    if (fixtures.length === 0) throw new Error(`Missing fixture rows for GW${gameweek}`);

    const snapshot = buildSnapshot({
      options,
      gameweek,
      gwRows,
      fixtures,
      teamsByName,
      xpByElement,
    });
    const validation = validateSnapshot(snapshot);
    if (!validation.valid) throw new Error(`Invalid snapshot for GW${gameweek}: ${validation.errors.join('; ')}`);
    snapshots.push(snapshot);
  }

  for (const snapshot of snapshots) {
    const target = join(options.cacheDir, `gw-${snapshot.gameweek}.json`);
    const temp = join(options.cacheDir, `gw-${snapshot.gameweek}.json.tmp`);
    await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`);
    await rename(temp, target);
  }
}

async function readRequiredCsv(path: string, label: string, requiredColumns: string[]): Promise<CsvRow[]> {
  const text = await readFile(path, 'utf8');
  return parseAndRequireColumns(text, label, requiredColumns);
}

async function readOptionalCsv(path: string, label: string, requiredColumns: string[] = []): Promise<CsvRow[]> {
  try {
    const text = await readFile(path, 'utf8');
    return parseAndRequireColumns(text, label, requiredColumns);
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
}

function parseAndRequireColumns(text: string, label: string, requiredColumns: string[]): CsvRow[] {
  const rows = parseCsv(text);
  const headers = rows.length > 0 ? Object.keys(rows[0]) : parseHeaderLine(text);
  requireColumns(headers, requiredColumns, label);
  return rows;
}

function parseHeaderLine(text: string): string[] {
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  return firstLine === '' ? [] : firstLine.split(',');
}

function buildTeamsByName(rows: CsvRow[]): Map<string, number> {
  const teams = new Map<string, number>();
  for (const row of rows) {
    if (row.name && row.id) teams.set(row.name, parseNumber(row.id, 'id'));
  }
  return teams;
}

function groupFixturesByGameweek(rows: CsvRow[]): Map<number, BacktestFixture[]> {
  const fixtures = new Map<number, BacktestFixture[]>();
  for (const row of rows) {
    const event = parseNumber(row.event, 'event');
    const fixture: BacktestFixture = {
      id: parseNumber(row.id, 'id'),
      event,
      kickoffTime: row.kickoff_time,
      teamHome: parseNumber(row.team_h, 'team_h'),
      teamAway: parseNumber(row.team_a, 'team_a'),
      teamHomeDifficulty: parseNumber(row.team_h_difficulty, 'team_h_difficulty'),
      teamAwayDifficulty: parseNumber(row.team_a_difficulty, 'team_a_difficulty'),
    };
    fixtures.set(event, [...(fixtures.get(event) ?? []), fixture]);
  }
  return fixtures;
}

function buildSnapshot(input: {
  options: NormalizeVaastavSnapshotsOptions;
  gameweek: number;
  gwRows: CsvRow[];
  fixtures: BacktestFixture[];
  teamsByName: Map<string, number>;
  xpByElement: Map<number, number>;
}): GameweekSnapshot {
  const players: BacktestPlayer[] = [];
  const playerResults: PlayerGameweekResult[] = [];
  const playerResultsById = new Map<number, PlayerGameweekResult>();
  const kickoffTimes: string[] = [];

  for (const row of input.gwRows) {
    const elementType = POSITION_BY_NAME[row.position];
    if (elementType === undefined) continue;

    const playerId = parseNumber(row.element, 'element');
    if (!playerResultsById.has(playerId)) {
      players.push({
        id: playerId,
        webName: row.name,
        elementType,
        team: input.teamsByName.get(row.team) ?? fallbackTeamId(row.team),
        price: parseNumber(row.value, 'value'),
        status: 'a',
        selectedByPercent: 0,
        expectedPoints: input.xpByElement.get(playerId) ?? parseNumber(row.xP, 'xP'),
      });
      playerResultsById.set(playerId, { playerId, minutes: 0, totalPoints: 0 });
    }

    const playerResult = playerResultsById.get(playerId)!;
    playerResult.minutes += parseNumber(row.minutes, 'minutes');
    playerResult.totalPoints += parseNumber(row.total_points, 'total_points');
    kickoffTimes.push(row.kickoff_time);
  }
  playerResults.push(...playerResultsById.values());

  return {
    season: input.options.season,
    gameweek: input.gameweek,
    deadline: earliestIsoTime(kickoffTimes),
    knownBeforeDeadline: {
      players,
      fixtures: input.fixtures,
      unavailableFields: UNAVAILABLE_FIELDS,
    },
    actualResults: {
      playerResults,
      averageEntryScore: 0,
      highestScore: 0,
    },
    provenance: {
      sourceUrls: input.options.sourceUrls,
      downloadedAt: input.options.downloadedAt,
      snapshotVersion: input.options.snapshotVersion,
      knownLimitations: UNAVAILABLE_FIELDS,
    },
  };
}

function parseNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number for ${label}: ${value}`);
  return parsed;
}

function earliestIsoTime(values: string[]): string {
  if (values.length === 0) throw new Error('Cannot determine deadline without player kickoff times');
  return values.reduce((earliest, value) => (Date.parse(value) < Date.parse(earliest) ? value : earliest));
}

function fallbackTeamId(teamName: string): number {
  let hash = 0;
  for (const char of teamName) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return 1000 + hash;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
