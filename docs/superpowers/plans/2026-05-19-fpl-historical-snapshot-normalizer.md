# FPL Historical Snapshot Normalizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm run backtest:prepare` download Vaastav 2024/25 historical data and generate validated `gw-1.json` through `gw-38.json` snapshots that `npm run backtest:run` can replay.

**Architecture:** Keep the existing snapshot replay contract unchanged. Add a small CSV parser, extend the data-source downloader to cache JSON and text files, then add a Vaastav normalizer that reads cached CSVs, validates all snapshots, and atomically replaces replay files only after the full season is valid.

**Tech Stack:** TypeScript ESM, Node built-in test runner, `node:fs/promises`, existing `GameweekSnapshot` types, existing `validateSnapshot` and `FileSnapshotStore`.

---

## File Structure

- Create `src/backtest/csv.ts`: local CSV parser for headers, quoted fields, escaped quotes, empty values, and row objects.
- Create `src/backtest/csv.test.ts`: unit tests for parser behavior and required-column validation.
- Modify `src/backtest/data-source.ts`: support named JSON/text source downloads while preserving existing constructor/test behavior.
- Modify `src/backtest/data-source.test.ts`: cover text downloads and manifest source URLs.
- Create `src/backtest/normalizer.ts`: read cached Vaastav files, normalize gameweeks into `GameweekSnapshot[]`, validate, and write `gw-N.json` files after all snapshots pass.
- Create `src/backtest/normalizer.test.ts`: cover successful tiny dataset normalization, duplicate-player failure, missing-column failure, and atomic preservation of existing snapshots.
- Modify `src/backtest/index.ts`: define Vaastav source descriptors, call `BacktestDataSource.prepare()`, run the normalizer, and update the prepare-data success message.
- Modify `src/backtest/index.test.ts`: update prepare message expectations for generated replay snapshots.

## Source Cache Contract

Raw source files in `data/historical/2024-2025/`:

- `source-listing.json`: GitHub API directory listing for `data/2024-25`.
- `fixtures.csv`: Vaastav fixture rows.
- `teams.csv`: Vaastav team rows.
- `gw-raw-1.csv` through `gw-raw-38.csv`: Vaastav `gws/gwN.csv` rows.
- `xp-raw-N.csv`: Vaastav `gws/xPN.csv` rows when available; missing xP files do not fail preparation.
- `manifest.json`: source metadata written after raw downloads succeed.
- `gw-1.json` through `gw-38.json`: normalized replay snapshots written only after every generated snapshot validates.

## Task 1: CSV Parser

**Files:**
- Create: `src/backtest/csv.ts`
- Create: `src/backtest/csv.test.ts`

- [ ] **Step 1: Write failing CSV parser tests**

Add `src/backtest/csv.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { parseCsv, requireColumns } from './csv.js';

test('parseCsv parses headers, quoted commas, escaped quotes, and empty fields', () => {
  const rows = parseCsv('id,name,note,value\n1,"Saka, Bukayo","He said ""go""",83\n2,Foden,,');

  assert.deepEqual(rows, [
    { id: '1', name: 'Saka, Bukayo', note: 'He said "go"', value: '83' },
    { id: '2', name: 'Foden', note: '', value: '' },
  ]);
});

test('parseCsv ignores a trailing blank line', () => {
  assert.deepEqual(parseCsv('id,name\n1,Alpha\n'), [{ id: '1', name: 'Alpha' }]);
});

test('parseCsv rejects rows with a different field count than the header', () => {
  assert.throws(() => parseCsv('id,name\n1,Alpha,extra'), /CSV row 2 has 3 fields; expected 2/);
});

test('requireColumns rejects missing headers', () => {
  assert.throws(() => requireColumns(['id', 'name'], ['id', 'value'], 'players'), /players is missing required columns: value/);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npx tsx --test src/backtest/csv.test.ts`

Expected: FAIL because `src/backtest/csv.ts` does not exist.

- [ ] **Step 3: Implement parser**

Create `src/backtest/csv.ts`:

```ts
export type CsvRow = Record<string, string>;

export function parseCsv(input: string): CsvRow[] {
  const records = parseRecords(input.replace(/^\uFEFF/, ''));
  if (records.length === 0) return [];

  const [headers, ...rows] = records;
  return rows
    .filter(row => row.length > 1 || row[0] !== '')
    .map((row, index) => {
      if (row.length !== headers.length) {
        throw new Error(`CSV row ${index + 2} has ${row.length} fields; expected ${headers.length}`);
      }

      return Object.fromEntries(headers.map((header, headerIndex) => [header, row[headerIndex] ?? '']));
    });
}

export function requireColumns(headers: string[], requiredColumns: string[], label: string): void {
  const missing = requiredColumns.filter(column => !headers.includes(column));
  if (missing.length > 0) throw new Error(`${label} is missing required columns: ${missing.join(', ')}`);
}

function parseRecords(input: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    const next = input[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        index++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      record.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') index++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (inQuotes) throw new Error('CSV input ended inside a quoted field');
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  return records;
}
```

- [ ] **Step 4: Run parser tests**

Run: `npx tsx --test src/backtest/csv.test.ts`

Expected: PASS for all CSV parser tests.

- [ ] **Step 5: Commit parser**

Run:

```bash
git add src/backtest/csv.ts src/backtest/csv.test.ts
git commit -m "Add backtest CSV parser"
```

## Task 2: Data Source Text Downloads

**Files:**
- Modify: `src/backtest/data-source.ts`
- Modify: `src/backtest/data-source.test.ts`

- [ ] **Step 1: Write failing text download test**

Append to `src/backtest/data-source.test.ts`:

```ts
test('BacktestDataSource writes named JSON and text sources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fpl-data-source-'));
  try {
    const dataSource = new BacktestDataSource({
      season: '2024-2025',
      cacheDir: dir,
      sourceUrls: [],
      sources: [
        { url: 'https://example.test/listing.json', fileName: 'source-listing.json', format: 'json' },
        { url: 'https://example.test/fixtures.csv', fileName: 'fixtures.csv', format: 'text' },
      ],
      fetchJson: async () => ({ ok: true }),
      fetchText: async () => 'id,event\n1,1\n',
      now: () => new Date('2026-05-19T00:00:00.000Z'),
    });

    await dataSource.prepare();

    assert.deepEqual(JSON.parse(await readFile(join(dir, 'source-listing.json'), 'utf8')), { ok: true });
    assert.equal(await readFile(join(dir, 'fixtures.csv'), 'utf8'), 'id,event\n1,1\n');
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')).sourceUrls, [
      'https://example.test/listing.json',
      'https://example.test/fixtures.csv',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test and verify it fails**

Run: `npx tsx --test src/backtest/data-source.test.ts`

Expected: FAIL because `sources` and `fetchText` are not recognized by `BacktestDataSourceOptions`.

- [ ] **Step 3: Extend data source implementation**

Modify `src/backtest/data-source.ts`:

```ts
export interface BacktestSourceDescriptor {
  url: string;
  fileName: string;
  format: 'json' | 'text';
  optional?: boolean;
}

export interface BacktestDataSourceOptions {
  season: string;
  cacheDir: string;
  sourceUrls: string[];
  sources?: BacktestSourceDescriptor[];
  fetchJson?: (url: string) => Promise<unknown>;
  fetchText?: (url: string) => Promise<string>;
  fetchImpl?: FetchImpl;
  fetchTimeoutMs?: number;
  now?: () => Date;
}
```

Add a `fetchText` property beside `fetchJson`:

```ts
private readonly fetchText: (url: string) => Promise<string>;
```

Initialize it in the constructor:

```ts
this.fetchText = options.fetchText ?? (async (url: string) => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  return response.text();
});
```

Replace the download loop in `prepare()` with:

```ts
const sources = this.options.sources ?? this.options.sourceUrls.map((url, index) => ({
  url,
  fileName: `source-${index + 1}.json`,
  format: 'json' as const,
}));

for (const source of sources) {
  try {
    if (source.format === 'json') {
      const data = await this.fetchJson(source.url);
      await writeFile(join(this.options.cacheDir, source.fileName), JSON.stringify(data, null, 2));
    } else {
      await writeFile(join(this.options.cacheDir, source.fileName), await this.fetchText(source.url));
    }
  } catch (error) {
    if (!source.optional) throw error;
  }
}

await this.writeManifest(sources.map(source => source.url));
```

- [ ] **Step 4: Run data-source tests**

Run: `npx tsx --test src/backtest/data-source.test.ts`

Expected: PASS for all data-source tests.

- [ ] **Step 5: Commit data-source changes**

Run:

```bash
git add src/backtest/data-source.ts src/backtest/data-source.test.ts
git commit -m "Support backtest text source downloads"
```

## Task 3: Snapshot Normalizer

**Files:**
- Create: `src/backtest/normalizer.ts`
- Create: `src/backtest/normalizer.test.ts`

- [ ] **Step 1: Write successful normalization test**

Create `src/backtest/normalizer.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeVaastavSnapshots } from './normalizer.js';
import { FileSnapshotStore } from './snapshots.js';

const fixtureCsv = 'id,event,kickoff_time,team_h,team_a,team_h_difficulty,team_a_difficulty\n10,1,2024-08-16T19:00:00Z,1,2,3,4\n20,2,2024-08-24T14:00:00Z,2,1,2,5\n';
const teamsCsv = 'id,name\n1,Arsenal\n2,Chelsea\n';

function gwCsv(round: number): string {
  return [
    'name,position,team,xP,element,value,selected,minutes,total_points,round,kickoff_time',
    `Raya,GK,Arsenal,4.5,1,55,1000000,90,6,${round},2024-08-16T19:00:00Z`,
    `Gabriel,DEF,Arsenal,4.0,2,60,900000,90,5,${round},2024-08-16T19:00:00Z`,
    `Saka,MID,Arsenal,6.5,3,100,2000000,90,8,${round},2024-08-16T19:00:00Z`,
    `Havertz,FWD,Arsenal,5.0,4,80,800000,70,4,${round},2024-08-16T19:00:00Z`,
  ].join('\n');
}

test('normalizeVaastavSnapshots writes validated replay snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fpl-normalizer-'));
  try {
    await writeFile(join(dir, 'fixtures.csv'), fixtureCsv);
    await writeFile(join(dir, 'teams.csv'), teamsCsv);
    await writeFile(join(dir, 'gw-raw-1.csv'), gwCsv(1));
    await writeFile(join(dir, 'gw-raw-2.csv'), gwCsv(2));

    await normalizeVaastavSnapshots({
      season: '2024-2025',
      cacheDir: dir,
      gameweeks: [1, 2],
      sourceUrls: ['https://example.test/fixtures.csv'],
      downloadedAt: '2026-05-19T00:00:00.000Z',
      snapshotVersion: '2024-2025-v1',
    });

    const snapshot = await new FileSnapshotStore(dir).getSnapshot(1);
    assert.equal(snapshot.gameweek, 1);
    assert.equal(snapshot.deadline, '2024-08-16T19:00:00Z');
    assert.deepEqual(snapshot.knownBeforeDeadline.players[0], {
      id: 1,
      webName: 'Raya',
      elementType: 1,
      team: 1,
      price: 55,
      status: 'a',
      selectedByPercent: 1000000,
      expectedPoints: 4.5,
    });
    assert.deepEqual(snapshot.actualResults.playerResults[2], { playerId: 3, minutes: 90, totalPoints: 8 });
    assert.match(snapshot.provenance.knownLimitations.join('\n'), /Exact historical FPL deadline times unavailable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Write optional xP overlay test**

Append to `src/backtest/normalizer.test.ts`:

```ts
test('normalizeVaastavSnapshots prefers optional xP CSV values when available', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fpl-normalizer-'));
  try {
    await writeFile(join(dir, 'fixtures.csv'), fixtureCsv);
    await writeFile(join(dir, 'teams.csv'), teamsCsv);
    await writeFile(join(dir, 'gw-raw-1.csv'), gwCsv(1));
    await writeFile(join(dir, 'xp-raw-1.csv'), 'element,xP\n1,7.25\n3,9.5\n');

    await normalizeVaastavSnapshots({
      season: '2024-2025',
      cacheDir: dir,
      gameweeks: [1],
      sourceUrls: ['https://example.test/xP1.csv'],
      downloadedAt: '2026-05-19T00:00:00.000Z',
      snapshotVersion: '2024-2025-v1',
    });

    const snapshot = await new FileSnapshotStore(dir).getSnapshot(1);
    const expectedPointsById = new Map(snapshot.knownBeforeDeadline.players.map(player => [player.id, player.expectedPoints]));
    assert.equal(expectedPointsById.get(1), 7.25);
    assert.equal(expectedPointsById.get(2), 4.0);
    assert.equal(expectedPointsById.get(3), 9.5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Write failure and atomicity tests**

Append to `src/backtest/normalizer.test.ts`:

```ts
test('normalizeVaastavSnapshots rejects duplicate player ids before writing snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fpl-normalizer-'));
  try {
    await writeFile(join(dir, 'fixtures.csv'), fixtureCsv);
    await writeFile(join(dir, 'teams.csv'), teamsCsv);
    await writeFile(join(dir, 'gw-raw-1.csv'), [
      'name,position,team,xP,element,value,selected,minutes,total_points,round,kickoff_time',
      'Raya,GK,Arsenal,4.5,1,55,1000000,90,6,1,2024-08-16T19:00:00Z',
      'Other,GK,Chelsea,3.0,1,45,1,0,0,1,2024-08-16T19:00:00Z',
    ].join('\n'));

    await assert.rejects(() => normalizeVaastavSnapshots({
      season: '2024-2025',
      cacheDir: dir,
      gameweeks: [1],
      sourceUrls: ['https://example.test'],
      downloadedAt: '2026-05-19T00:00:00.000Z',
      snapshotVersion: '2024-2025-v1',
    }), /Duplicate player id 1/);

    await assert.rejects(() => readFile(join(dir, 'gw-1.json'), 'utf8'), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('normalizeVaastavSnapshots rejects missing required columns and preserves existing snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fpl-normalizer-'));
  try {
    await writeFile(join(dir, 'fixtures.csv'), fixtureCsv);
    await writeFile(join(dir, 'teams.csv'), teamsCsv);
    await writeFile(join(dir, 'gw-1.json'), '{"existing":true}\n');
    await writeFile(join(dir, 'gw-raw-1.csv'), 'name,position,team\nRaya,GK,Arsenal\n');

    await assert.rejects(() => normalizeVaastavSnapshots({
      season: '2024-2025',
      cacheDir: dir,
      gameweeks: [1],
      sourceUrls: ['https://example.test'],
      downloadedAt: '2026-05-19T00:00:00.000Z',
      snapshotVersion: '2024-2025-v1',
    }), /gw-raw-1.csv is missing required columns/);

    assert.equal(await readFile(join(dir, 'gw-1.json'), 'utf8'), '{"existing":true}\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run tests and verify they fail**

Run: `npx tsx --test src/backtest/normalizer.test.ts`

Expected: FAIL because `src/backtest/normalizer.ts` does not exist.

- [ ] **Step 5: Implement normalizer**

Create `src/backtest/normalizer.ts`:

```ts
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCsv, requireColumns, type CsvRow } from './csv.js';
import { validateSnapshot } from './snapshots.js';
import type { BacktestFixture, BacktestPlayer, GameweekSnapshot, PlayerGameweekResult } from './types.js';

const REQUIRED_GW_COLUMNS = ['element', 'name', 'position', 'team', 'value', 'xP', 'minutes', 'total_points', 'round', 'kickoff_time'];
const REQUIRED_FIXTURE_COLUMNS = ['id', 'event', 'kickoff_time', 'team_h', 'team_a', 'team_h_difficulty', 'team_a_difficulty'];
const POSITION_TO_ELEMENT_TYPE: Record<string, number> = { GK: 1, DEF: 2, MID: 3, FWD: 4 };

export interface NormalizeVaastavSnapshotsOptions {
  season: string;
  cacheDir: string;
  gameweeks: number[];
  sourceUrls: string[];
  downloadedAt: string;
  snapshotVersion: string;
}

export async function normalizeVaastavSnapshots(options: NormalizeVaastavSnapshotsOptions): Promise<void> {
  const fixtureRows = await readRequiredCsv(join(options.cacheDir, 'fixtures.csv'), REQUIRED_FIXTURE_COLUMNS, 'fixtures.csv');
  const teamIdsByName = await readTeamIdsByName(options.cacheDir);
  const snapshots: GameweekSnapshot[] = [];

  for (const gameweek of options.gameweeks) {
    const rawName = `gw-raw-${gameweek}.csv`;
    const playerRows = await readRequiredCsv(join(options.cacheDir, rawName), REQUIRED_GW_COLUMNS, rawName);
    const expectedPointsByPlayerId = await readExpectedPointsByPlayerId(options.cacheDir, gameweek);
    snapshots.push(buildSnapshot(options, gameweek, playerRows, fixtureRows, teamIdsByName, expectedPointsByPlayerId));
  }

  for (const snapshot of snapshots) {
    const validation = validateSnapshot(snapshot);
    if (!validation.valid) throw new Error(`Invalid normalized snapshot for GW${snapshot.gameweek}: ${validation.errors.join('; ')}`);
  }

  for (const snapshot of snapshots) {
    const target = join(options.cacheDir, `gw-${snapshot.gameweek}.json`);
    const temp = `${target}.tmp`;
    await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`);
    await rename(temp, target);
  }
}

async function readRequiredCsv(path: string, requiredColumns: string[], label: string): Promise<CsvRow[]> {
  const rows = parseCsv(await readFile(path, 'utf8'));
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  requireColumns(headers, requiredColumns, label);
  return rows;
}

async function readTeamIdsByName(cacheDir: string): Promise<Map<string, number>> {
  try {
    const rows = parseCsv(await readFile(join(cacheDir, 'teams.csv'), 'utf8'));
    const result = new Map<string, number>();
    for (const row of rows) {
      const id = toNumber(row.id, 'teams.csv id');
      if (row.name) result.set(row.name, id);
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
}

async function readExpectedPointsByPlayerId(cacheDir: string, gameweek: number): Promise<Map<number, number>> {
  try {
    const rows = await readRequiredCsv(join(cacheDir, `xp-raw-${gameweek}.csv`), ['element', 'xP'], `xp-raw-${gameweek}.csv`);
    return new Map(rows.map(row => [toNumber(row.element, 'xP element'), toNumber(row.xP || '0', 'xP')]))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
}

function buildSnapshot(
  options: NormalizeVaastavSnapshotsOptions,
  gameweek: number,
  playerRows: CsvRow[],
  fixtureRows: CsvRow[],
  teamIdsByName: Map<string, number>,
  expectedPointsByPlayerId: Map<number, number>,
): GameweekSnapshot {
  const fixtures = fixtureRows.filter(row => toNumber(row.event, 'fixture event') === gameweek).map(mapFixture);
  if (fixtures.length === 0) throw new Error(`Missing fixture rows for GW${gameweek}`);

  const players = playerRows.map(row => mapPlayer(row, teamIdsByName, expectedPointsByPlayerId));
  const playerResults = playerRows.map(mapResult);
  const deadline = earliestIso(playerRows.map(row => row.kickoff_time).filter(Boolean));

  return {
    season: options.season,
    gameweek,
    deadline,
    knownBeforeDeadline: {
      players,
      fixtures,
      unavailableFields: unavailableFields(),
    },
    actualResults: {
      playerResults,
      averageEntryScore: 0,
      highestScore: 0,
    },
    provenance: {
      sourceUrls: options.sourceUrls,
      downloadedAt: options.downloadedAt,
      snapshotVersion: options.snapshotVersion,
      knownLimitations: unavailableFields(),
    },
  };
}

function mapPlayer(row: CsvRow, teamIdsByName: Map<string, number>, expectedPointsByPlayerId: Map<number, number>): BacktestPlayer {
  const id = toNumber(row.element, 'player element');
  const elementType = POSITION_TO_ELEMENT_TYPE[row.position];
  if (!elementType) throw new Error(`Invalid position ${row.position} for player ${row.element}`);
  return {
    id,
    webName: row.name,
    elementType,
    team: teamIdsByName.get(row.team) ?? stableFallbackTeamId(row.team),
    price: toNumber(row.value, 'player value'),
    status: 'a',
    selectedByPercent: toNumber(row.selected || '0', 'selected'),
    expectedPoints: expectedPointsByPlayerId.get(id) ?? toNumber(row.xP || '0', 'xP'),
  };
}

function mapResult(row: CsvRow): PlayerGameweekResult {
  return {
    playerId: toNumber(row.element, 'result element'),
    minutes: toNumber(row.minutes, 'minutes'),
    totalPoints: toNumber(row.total_points, 'total_points'),
  };
}

function mapFixture(row: CsvRow): BacktestFixture {
  return {
    id: toNumber(row.id, 'fixture id'),
    event: toNumber(row.event, 'fixture event'),
    kickoffTime: row.kickoff_time,
    teamHome: toNumber(row.team_h, 'team_h'),
    teamAway: toNumber(row.team_a, 'team_a'),
    teamHomeDifficulty: toNumber(row.team_h_difficulty, 'team_h_difficulty'),
    teamAwayDifficulty: toNumber(row.team_a_difficulty, 'team_a_difficulty'),
  };
}

function earliestIso(values: string[]): string {
  if (values.length === 0) throw new Error('Cannot derive deadline without kickoff_time values');
  return values.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
}

function toNumber(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid numeric ${label}: ${value}`);
  return number;
}

function stableFallbackTeamId(teamName: string): number {
  let hash = 0;
  for (const char of teamName) hash = (hash * 31 + char.charCodeAt(0)) % 10_000;
  return 1_000 + hash;
}

function unavailableFields(): string[] {
  return [
    'Injury/news history unavailable in Vaastav GW CSV data',
    'Exact pre-deadline player status unavailable; status defaults to available',
    'Exact historical FPL deadline times unavailable; earliest kickoff used',
    'Ownership timing approximated from available selected column',
    'Rank distribution unavailable; average and highest scores default to 0',
  ];
}
```

- [ ] **Step 6: Run normalizer tests**

Run: `npx tsx --test src/backtest/normalizer.test.ts`

Expected: PASS for all normalizer tests.

- [ ] **Step 7: Commit normalizer**

Run:

```bash
git add src/backtest/normalizer.ts src/backtest/normalizer.test.ts
git commit -m "Normalize historical backtest snapshots"
```

## Task 4: Wire Prepare CLI

**Files:**
- Modify: `src/backtest/index.ts`
- Modify: `src/backtest/index.test.ts`

- [ ] **Step 1: Update prepare message test**

Replace the `formatPrepareDataMessage` test in `src/backtest/index.test.ts` with:

```ts
test('formatPrepareDataMessage says replay snapshots are prepared', () => {
  const message = formatPrepareDataMessage('data/historical/2024-2025');

  assert.match(message, /Prepared 2024-2025 replay cache/i);
  assert.match(message, /gw-1\.json through gw-38\.json/i);
  assert.doesNotMatch(message, /run-season requires gw-N\.json snapshots/i);
});
```

- [ ] **Step 2: Run index tests and verify they fail**

Run: `npx tsx --test src/backtest/index.test.ts`

Expected: FAIL because `formatPrepareDataMessage` still says snapshots are not generated.

- [ ] **Step 3: Define Vaastav source descriptors and call normalizer**

Modify imports in `src/backtest/index.ts`:

```ts
import { BacktestDataSource, getDefaultBacktestCacheDir, type BacktestSourceDescriptor } from './data-source.js';
import { normalizeVaastavSnapshots } from './normalizer.js';
```

Replace `SOURCE_URLS` with:

```ts
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
```

Replace `formatPrepareDataMessage` with:

```ts
export function formatPrepareDataMessage(preparedCacheDir: string): string {
  return `Prepared ${SEASON} replay cache at ${preparedCacheDir} with gw-1.json through gw-38.json.`;
}
```

Replace `prepareData()` with:

```ts
export async function prepareData(): Promise<void> {
  const preparedCacheDir = cacheDir();
  const dataSource = new BacktestDataSource({
    season: SEASON,
    cacheDir: preparedCacheDir,
    sourceUrls: SOURCE_URLS,
    sources: SOURCE_DESCRIPTORS,
  });
  await dataSource.prepare();
  await normalizeVaastavSnapshots({
    season: SEASON,
    cacheDir: preparedCacheDir,
    gameweeks: Array.from({ length: 38 }, (_, index) => index + 1),
    sourceUrls: SOURCE_URLS,
    downloadedAt: new Date().toISOString(),
    snapshotVersion: `${SEASON}-v1`,
  });
  console.log(formatPrepareDataMessage(preparedCacheDir));
}
```

- [ ] **Step 4: Run index tests**

Run: `npx tsx --test src/backtest/index.test.ts`

Expected: PASS for index tests.

- [ ] **Step 5: Commit CLI wiring**

Run:

```bash
git add src/backtest/index.ts src/backtest/index.test.ts
git commit -m "Prepare runnable historical snapshots"
```

## Task 5: Verification And Full Replay

**Files:**
- Inspect generated files under: `data/historical/2024-2025/`

- [ ] **Step 1: Run full unit test suite**

Run: `npm test`

Expected: PASS for all tests.

- [ ] **Step 2: Run TypeScript build**

Run: `npm run build`

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Prepare historical replay cache**

Run: `npm run backtest:prepare`

Expected: command exits 0 and prints `Prepared 2024-2025 replay cache at data/historical/2024-2025 with gw-1.json through gw-38.json.`

- [ ] **Step 4: Run historical replay**

Run: `npm run backtest:run`

Expected: command exits 0, prints a backtest summary, and no longer fails with `ENOENT` for `gw-1.json`.

- [ ] **Step 5: Inspect generated snapshot sample**

Run: `node -e "const fs=require('fs'); const s=JSON.parse(fs.readFileSync('data/historical/2024-2025/gw-1.json','utf8')); console.log(s.gameweek, s.knownBeforeDeadline.players.length, s.knownBeforeDeadline.fixtures.length, s.provenance.knownLimitations.length)"`

Expected: output starts with `1`, player count is greater than `0`, fixture count is greater than `0`, and limitations count is greater than `0`.

- [ ] **Step 6: Commit generated-code verification fixes only**

If verification required code fixes, commit only source/test changes:

```bash
git status --short
git add src/backtest docs/superpowers/plans/2026-05-19-fpl-historical-snapshot-normalizer.md package.json
git commit -m "Verify historical snapshot preparation"
```

Do not commit downloaded `data/historical/2024-2025/*.csv` or generated `gw-N.json` unless the repository already tracks historical data and the user explicitly approves adding these cache artifacts.

## Self-Review Notes

- Spec coverage: fetch phase, normalize phase, validation, limitations, CSV parser, text source downloads, CLI wiring, and full verification are covered.
- Atomicity: normalizer tests and implementation generate all snapshots before replacing `gw-N.json`; missing columns and duplicate IDs preserve existing snapshots.
- Known limitations: injury/news status, exact deadline, ownership timing, rank distribution, and default scores are explicitly written to snapshots.
- Deferred work remains deferred: exact FPL deadlines, exact historical status, rank distribution, stronger expected-points model, and checksums.
