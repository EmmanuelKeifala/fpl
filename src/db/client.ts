// Database Client using sql.js (pure JavaScript SQLite - works on Android/Termux)
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import type { Decision, NewDecision, GameweekSnapshot, NewGameweekSnapshot } from './schema.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import type { Fixture, Player } from '../api/types.js';
import type { ExpectedPoints } from '../engine/optimizer.js';
import type { PlayerNewsSignal } from '../scheduler/news-signals.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env.FPL_DB_PATH || join(__dirname, '../../data/fpl.db');

const decisionColumns = {
  id: 'id',
  gameweek: 'gameweek',
  decisionType: 'decision_type',
  action: 'action',
  reasoning: 'reasoning',
  expectedPoints: 'expected_points',
  actualPoints: 'actual_points',
  rankBefore: 'rank_before',
  rankAfter: 'rank_after',
  hitsTaken: 'hits_taken',
  createdAt: 'created_at',
} as const;

const snapshotColumns = {
  id: 'id',
  gameweek: 'gameweek',
  totalPoints: 'total_points',
  overallRank: 'overall_rank',
  gameweekPoints: 'gameweek_points',
  gameweekRank: 'gameweek_rank',
  teamValue: 'team_value',
  bank: 'bank',
  chipsUsed: 'chips_used',
  transfersMade: 'transfers_made',
  transfersCost: 'transfers_cost',
  pointsOnBench: 'points_on_bench',
  captainId: 'captain_id',
  captainPoints: 'captain_points',
  createdAt: 'created_at',
} as const;

function toDbRow(
  values: Record<string, unknown>,
  columns: Record<string, string>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [columns[key] ?? key, value])
  );
}

function fromDbRow(
  columns: string[],
  row: unknown[],
  columnMap: Record<string, string>
): Record<string, unknown> {
  const reverseMap = Object.fromEntries(
    Object.entries(columnMap).map(([camel, snake]) => [snake, camel])
  );
  const obj: Record<string, unknown> = {};
  columns.forEach((col: string, i: number) => {
    obj[reverseMap[col] ?? col] = row[i];
  });
  return obj;
}

// Ensure data directory exists
try {
  mkdirSync(join(__dirname, '../../data'), { recursive: true });
} catch {
  // Directory exists
}

// Database instance
let sqlDb: SqlJsDatabase | null = null;
let dbReady = false;

async function initDatabase(): Promise<SqlJsDatabase> {
  if (sqlDb && dbReady) {
    return sqlDb;
  }
  
  const SQL = await initSqlJs();
  
  // Load existing database or create new one
  if (existsSync(DB_PATH)) {
    const buffer = readFileSync(DB_PATH);
    sqlDb = new SQL.Database(buffer);
  } else {
    sqlDb = new SQL.Database();
  }
  
  // Create tables
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gameweek INTEGER NOT NULL,
      decision_type TEXT NOT NULL,
      action TEXT NOT NULL,
      reasoning TEXT,
      expected_points REAL,
      actual_points REAL,
      rank_before INTEGER,
      rank_after INTEGER,
      hits_taken INTEGER DEFAULT 0,
      created_at INTEGER
    )
  `);
  
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS gameweek_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gameweek INTEGER NOT NULL UNIQUE,
      total_points INTEGER,
      overall_rank INTEGER,
      gameweek_points INTEGER,
      gameweek_rank INTEGER,
      team_value REAL,
      bank REAL,
      chips_used TEXT,
      transfers_made INTEGER,
      transfers_cost INTEGER,
      points_on_bench INTEGER,
      captain_id INTEGER,
      captain_points INTEGER,
      created_at INTEGER
    )
  `);
  
  sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_decisions_gameweek ON decisions(gameweek)`);
  sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_decisions_type ON decisions(decision_type)`);

  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS player_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gameweek INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,
      state_json TEXT NOT NULL
    )
  `);
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS fixture_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gameweek INTEGER NOT NULL,
      fixture_id INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,
      state_json TEXT NOT NULL
    )
  `);
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS player_forecasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gameweek INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      horizon INTEGER NOT NULL,
      predicted_points REAL NOT NULL,
      confidence REAL NOT NULL,
      expected_minutes REAL NOT NULL,
      actual_points INTEGER,
      captured_at INTEGER NOT NULL
    )
  `);
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS player_news_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gameweek INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      signal_type TEXT NOT NULL,
      source TEXT NOT NULL,
      source_tier INTEGER NOT NULL,
      confidence REAL NOT NULL,
      minutes_multiplier REAL NOT NULL,
      published_at INTEGER,
      retrieved_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      evidence TEXT NOT NULL,
      timestamp_verified INTEGER NOT NULL
    )
  `);
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS ml_shadow_forecast_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season TEXT NOT NULL,
      gameweek INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL,
      captured_at INTEGER NOT NULL,
      completed_at INTEGER,
      horizon INTEGER NOT NULL,
      status TEXT NOT NULL,
      heuristic_version TEXT NOT NULL,
      model_version TEXT,
      data_version TEXT,
      schema_version TEXT,
      artifact_sha256 TEXT,
      feature_sidecar_sha256 TEXT,
      feature_sidecar_path TEXT,
      feature_cutoff_gameweek INTEGER,
      error TEXT
    )
  `);
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS ml_shadow_player_forecasts (
      run_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      fixture_count INTEGER NOT NULL,
      coverage TEXT NOT NULL,
      heuristic_points REAL NOT NULL,
      heuristic_minutes_per_fixture REAL NOT NULL,
      heuristic_minutes_gameweek REAL NOT NULL,
      heuristic_confidence REAL NOT NULL,
      ml_points REAL,
      ml_expected_minutes REAL,
      ml_appearance_probability REAL,
      ml_start_probability REAL,
      ml_direct_points REAL,
      ml_conditional_points REAL,
      ml_expected_appearances REAL,
      ml_expected_starts REAL,
      feature_payload_json TEXT,
      actual_points INTEGER,
      actual_minutes INTEGER,
      actual_starts INTEGER,
      PRIMARY KEY (run_id, player_id),
      FOREIGN KEY (run_id) REFERENCES ml_shadow_forecast_runs(id)
    )
  `);
  ensureColumn(sqlDb, 'ml_shadow_forecast_runs', 'completed_at', 'INTEGER');
  ensureColumn(sqlDb, 'ml_shadow_forecast_runs', 'feature_sidecar_path', 'TEXT');
  ensureColumn(sqlDb, 'ml_shadow_player_forecasts', 'ml_expected_appearances', 'REAL');
  ensureColumn(sqlDb, 'ml_shadow_player_forecasts', 'ml_expected_starts', 'REAL');
  sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_player_observations_lookup ON player_observations(player_id, id)`);
  sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_fixture_observations_lookup ON fixture_observations(fixture_id, id)`);
  sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_player_forecasts_gameweek ON player_forecasts(gameweek, player_id, horizon)`);
  sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_player_news_signals_gameweek ON player_news_signals(gameweek, player_id)`);
  sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_ml_shadow_runs_lookup ON ml_shadow_forecast_runs(season, gameweek, deadline_at, captured_at)`);
  sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_ml_shadow_forecasts_player ON ml_shadow_player_forecasts(player_id, run_id)`);
  
  dbReady = true;
  saveDatabase();
  
  return sqlDb;
}

export async function savePlayerNewsSignals(signals: PlayerNewsSignal[]): Promise<number> {
  if (signals.length === 0) return 0;
  const db = await initDatabase();
  const statement = db.prepare(`
    INSERT INTO player_news_signals (
      gameweek, player_id, signal_type, source, source_tier, confidence,
      minutes_multiplier, published_at, retrieved_at, expires_at, evidence, timestamp_verified
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  try {
    for (const signal of signals) {
      statement.run([
        signal.gameweek,
        signal.playerId,
        signal.type,
        signal.source,
        signal.sourceTier,
        signal.confidence,
        signal.minutesMultiplier,
        signal.publishedAt?.getTime() ?? null,
        signal.retrievedAt.getTime(),
        signal.expiresAt.getTime(),
        signal.evidence,
        signal.timestampVerified ? 1 : 0,
      ]);
    }
  } finally {
    statement.free();
  }
  saveDatabase();
  return signals.length;
}

function saveDatabase(): void {
  if (sqlDb) {
    const data = sqlDb.export();
    const buffer = Buffer.from(data);
    const temporary = `${DB_PATH}.tmp`;
    try {
      writeFileSync(temporary, buffer);
      renameSync(temporary, DB_PATH);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}

function ensureColumn(db: SqlJsDatabase, table: string, column: string, definition: string): void {
  const columns = db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? [];
  if (columns.some(row => row[1] === column)) return;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Decision CRUD operations
export async function logDecision(decision: NewDecision): Promise<Decision> {
  const db = await initDatabase();
  
  // Convert Date to timestamp if needed
  const values = { ...decision };
  if (values.createdAt instanceof Date) {
    (values as Record<string, unknown>).createdAt = values.createdAt.getTime();
  }
  
  const dbValues = toDbRow(values as Record<string, unknown>, decisionColumns);
  const cols = Object.keys(dbValues).join(', ');
  const placeholders = Object.keys(dbValues).map(() => '?').join(', ');
  const vals = Object.values(dbValues);
  
  db.run(`INSERT INTO decisions (${cols}) VALUES (${placeholders})`, vals as (string | number | null)[]);
  saveDatabase();
  
  const result = db.exec('SELECT id FROM decisions ORDER BY id DESC LIMIT 1');
  const id = result[0]?.values[0]?.[0] as number;
  
  return { ...decision, id } as Decision;
}

export async function updateDecisionOutcome(
  id: number,
  actualPoints: number,
  rankAfter: number
): Promise<void> {
  const db = await initDatabase();
  db.run(
    `UPDATE decisions SET actual_points = ?, rank_after = ? WHERE id = ?`,
    [actualPoints, rankAfter, id]
  );
  saveDatabase();
}

export async function getDecisions(gameweek?: number): Promise<Decision[]> {
  const db = await initDatabase();
  let sql = 'SELECT * FROM decisions';
  const params: number[] = [];
  
  if (gameweek) {
    sql += ' WHERE gameweek = ?';
    params.push(gameweek);
  }
  
  sql += ' ORDER BY created_at DESC LIMIT 50';
  
  const result = db.exec(sql, params);
  if (!result[0]) return [];
  
  return result[0].values.map((row: unknown[]) =>
    fromDbRow(result[0].columns, row, decisionColumns) as unknown as Decision
  );
}

export async function getDecisionsByType(type: string): Promise<Decision[]> {
  const db = await initDatabase();
  const result = db.exec(
    `SELECT * FROM decisions WHERE decision_type = ? ORDER BY created_at DESC LIMIT 50`,
    [type]
  );
  
  if (!result[0]) return [];
  
  return result[0].values.map((row: unknown[]) =>
    fromDbRow(result[0].columns, row, decisionColumns) as unknown as Decision
  );
}

// Gameweek Snapshot CRUD
export async function saveGameweekSnapshot(snapshot: NewGameweekSnapshot): Promise<GameweekSnapshot> {
  const db = await initDatabase();
  
  // Convert Date to timestamp if needed
  const values = { ...snapshot };
  if (values.createdAt instanceof Date) {
    (values as Record<string, unknown>).createdAt = values.createdAt.getTime();
  }
  
  // Check if exists
  const existing = db.exec(`SELECT id FROM gameweek_snapshots WHERE gameweek = ${snapshot.gameweek}`);
  
  if (existing[0]?.values?.length > 0) {
    // Update
    const dbValues = toDbRow(values as Record<string, unknown>, snapshotColumns);
    const entries = Object.entries(dbValues).filter(([k]) => k !== 'id' && k !== 'gameweek');
    const setClause = entries
      .map(([k]) => `${k} = ?`)
      .join(', ');
    const vals = entries.map(([, value]) => value) as (string | number | null)[];
    db.run(`UPDATE gameweek_snapshots SET ${setClause} WHERE gameweek = ?`, [...vals, snapshot.gameweek]);
  } else {
    // Insert
    const dbValues = toDbRow(values as Record<string, unknown>, snapshotColumns);
    const cols = Object.keys(dbValues).join(', ');
    const placeholders = Object.keys(dbValues).map(() => '?').join(', ');
    db.run(`INSERT INTO gameweek_snapshots (${cols}) VALUES (${placeholders})`, Object.values(dbValues) as (string | number | null)[]);
  }
  
  saveDatabase();
  return snapshot as GameweekSnapshot;
}

export async function getGameweekSnapshot(gameweek: number): Promise<GameweekSnapshot | undefined> {
  const db = await initDatabase();
  const result = db.exec(`SELECT * FROM gameweek_snapshots WHERE gameweek = ${gameweek}`);
  
  if (!result[0] || !result[0].values[0]) return undefined;
  
  const row = result[0].values[0];
  return fromDbRow(result[0].columns, row, snapshotColumns) as unknown as GameweekSnapshot;
}

export async function getRecentSnapshots(limit = 10): Promise<GameweekSnapshot[]> {
  const db = await initDatabase();
  const result = db.exec(`SELECT * FROM gameweek_snapshots ORDER BY gameweek DESC LIMIT ${limit}`);
  
  if (!result[0]) return [];
  
  return result[0].values.map((row: unknown[]) =>
    fromDbRow(result[0].columns, row, snapshotColumns) as unknown as GameweekSnapshot
  );
}

export async function saveIntelligenceObservations(
  gameweek: number,
  players: Player[],
  fixtures: Fixture[],
  observedAt: Date = new Date()
): Promise<{ players: number; fixtures: number }> {
  const db = await initDatabase();
  const latestPlayerStates = latestStates(db, 'player_observations', 'player_id');
  const latestFixtureStates = latestStates(db, 'fixture_observations', 'fixture_id');
  let playerChanges = 0;
  let fixtureChanges = 0;
  db.run('BEGIN TRANSACTION');
  try {
    for (const player of players) {
      const state = JSON.stringify({
        team: player.team,
        position: player.element_type,
        price: player.now_cost,
        status: player.status,
        chance: player.chance_of_playing_next_round,
        news: player.news,
        minutes: player.minutes,
        starts: player.starts,
        form: player.form,
        expectedGoals: player.expected_goals,
        expectedAssists: player.expected_assists,
        expectedGoalsConceded: player.expected_goals_conceded,
        selectedByPercent: player.selected_by_percent,
        transfersInEvent: player.transfers_in_event,
        transfersOutEvent: player.transfers_out_event,
      });
      if (latestPlayerStates.get(player.id) === state) continue;
      db.run(
        'INSERT INTO player_observations (gameweek, player_id, observed_at, state_json) VALUES (?, ?, ?, ?)',
        [gameweek, player.id, observedAt.getTime(), state]
      );
      playerChanges++;
    }

    for (const fixture of fixtures) {
      const state = JSON.stringify({
        event: fixture.event,
        kickoffTime: fixture.kickoff_time,
        started: fixture.started,
        finished: fixture.finished,
        homeTeam: fixture.team_h,
        awayTeam: fixture.team_a,
        homeDifficulty: fixture.team_h_difficulty,
        awayDifficulty: fixture.team_a_difficulty,
        homeScore: fixture.team_h_score,
        awayScore: fixture.team_a_score,
      });
      if (latestFixtureStates.get(fixture.id) === state) continue;
      db.run(
        'INSERT INTO fixture_observations (gameweek, fixture_id, observed_at, state_json) VALUES (?, ?, ?, ?)',
        [gameweek, fixture.id, observedAt.getTime(), state]
      );
      fixtureChanges++;
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
  if (playerChanges > 0 || fixtureChanges > 0) saveDatabase();
  return { players: playerChanges, fixtures: fixtureChanges };
}

export async function saveForecastSnapshot(
  gameweek: number,
  horizon: number,
  forecasts: ExpectedPoints[],
  force: boolean = false,
  capturedAt: Date = new Date()
): Promise<number> {
  const db = await initDatabase();
  const intervalHours = force ? 1 : Math.max(1, parseInt(process.env.FORECAST_SNAPSHOT_HOURS || '6'));
  const latest = db.exec(
    'SELECT MAX(captured_at) FROM player_forecasts WHERE gameweek = ? AND horizon = ?',
    [gameweek, horizon]
  )[0]?.values[0]?.[0];
  if (typeof latest === 'number' && capturedAt.getTime() - latest < intervalHours * 60 * 60 * 1000) return 0;

  db.run('BEGIN TRANSACTION');
  try {
    for (const forecast of forecasts) {
      db.run(
        `INSERT INTO player_forecasts
          (gameweek, player_id, horizon, predicted_points, confidence, expected_minutes, captured_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [gameweek, forecast.playerId, horizon, forecast.nextGW, forecast.confidence, forecast.breakdown.expectedMinutes, capturedAt.getTime()]
      );
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
  saveDatabase();
  return forecasts.length;
}

export async function isForecastSnapshotDue(
  gameweek: number,
  horizon: number,
  force: boolean = false,
  now: Date = new Date()
): Promise<boolean> {
  const db = await initDatabase();
  const intervalHours = force ? 1 : Math.max(1, parseInt(process.env.FORECAST_SNAPSHOT_HOURS || '6'));
  const latest = db.exec(
    'SELECT MAX(captured_at) FROM player_forecasts WHERE gameweek = ? AND horizon = ?',
    [gameweek, horizon]
  )[0]?.values[0]?.[0];
  return typeof latest !== 'number' || now.getTime() - latest >= intervalHours * 60 * 60 * 1000;
}

export async function reconcileForecastOutcomes(gameweek: number, actualPoints: Map<number, number>): Promise<number> {
  const db = await initDatabase();
  let updated = 0;
  db.run('BEGIN TRANSACTION');
  try {
    for (const [playerId, points] of actualPoints) {
      db.run(
        'UPDATE player_forecasts SET actual_points = ? WHERE gameweek = ? AND player_id = ? AND horizon = 1 AND actual_points IS NULL',
        [points, gameweek, playerId]
      );
      updated++;
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
  saveDatabase();
  return updated;
}

export async function getForecastAccuracy(gameweek?: number): Promise<{
  samples: number;
  meanAbsoluteError: number;
  bias: number;
  rootMeanSquaredError: number;
}> {
  const db = await initDatabase();
  const where = gameweek === undefined ? '' : 'AND forecast.gameweek = ?';
  const params = gameweek === undefined ? [] : [gameweek];
  const result = db.exec(`
    SELECT forecast.predicted_points, forecast.actual_points
    FROM player_forecasts forecast
    INNER JOIN (
      SELECT gameweek, player_id, MAX(captured_at) AS latest_capture
      FROM player_forecasts
      WHERE horizon = 1
      GROUP BY gameweek, player_id
    ) latest
      ON forecast.gameweek = latest.gameweek
      AND forecast.player_id = latest.player_id
      AND forecast.captured_at = latest.latest_capture
    WHERE forecast.horizon = 1 AND forecast.actual_points IS NOT NULL ${where}
  `, params);
  const rows = result[0]?.values ?? [];
  if (rows.length === 0) return { samples: 0, meanAbsoluteError: 0, bias: 0, rootMeanSquaredError: 0 };
  const errors = rows.map(row => Number(row[0]) - Number(row[1]));
  return {
    samples: errors.length,
    meanAbsoluteError: errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length,
    bias: errors.reduce((sum, error) => sum + error, 0) / errors.length,
    rootMeanSquaredError: Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / errors.length),
  };
}

export type MlShadowCoverage = 'predicted' | 'no-fixture';

export interface MlShadowPlayerForecastInput {
  playerId: number;
  fixtureCount: number;
  coverage: MlShadowCoverage;
  heuristicPoints: number;
  heuristicMinutesPerFixture: number;
  heuristicMinutesGameweek: number;
  heuristicConfidence: number;
  mlPoints: number | null;
  mlExpectedMinutes: number | null;
  mlAppearanceProbability: number | null;
  mlStartProbability: number | null;
  mlDirectPoints: number | null;
  mlConditionalPoints: number | null;
  mlExpectedAppearances: number | null;
  mlExpectedStarts: number | null;
  featurePayloadJson: string | null;
}

export interface MlShadowForecastRunInput {
  season: string;
  gameweek: number;
  deadlineAt: Date;
  capturedAt: Date;
  completedAt: Date;
  horizon: 1;
  status: 'completed' | 'failed';
  heuristicVersion: string;
  modelVersion: string | null;
  dataVersion: string | null;
  schemaVersion: string | null;
  artifactSha256: string | null;
  featureSidecarSha256: string | null;
  featureSidecarPath: string | null;
  featureCutoffGameweek: number | null;
  error: string | null;
  forecasts: MlShadowPlayerForecastInput[];
}

export interface MlShadowForecastRunRecord {
  id: number;
  season: string;
  gameweek: number;
  deadlineAt: Date;
  capturedAt: Date;
  completedAt: Date | null;
  status: 'completed' | 'failed';
  modelVersion: string | null;
  schemaVersion: string | null;
  error: string | null;
  playerCount: number;
}

export async function saveMlShadowForecastRun(input: MlShadowForecastRunInput): Promise<number> {
  validateMlShadowForecastRun(input);
  const db = await initDatabase();
  let runId = 0;
  db.run('BEGIN TRANSACTION');
  try {
    db.run(
      `INSERT INTO ml_shadow_forecast_runs (
        season, gameweek, deadline_at, captured_at, completed_at, horizon, status, heuristic_version,
        model_version, data_version, schema_version, artifact_sha256, feature_sidecar_sha256,
        feature_sidecar_path, feature_cutoff_gameweek, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.season,
        input.gameweek,
        input.deadlineAt.getTime(),
        input.capturedAt.getTime(),
        input.completedAt.getTime(),
        input.horizon,
        input.status,
        input.heuristicVersion,
        input.modelVersion,
        input.dataVersion,
        input.schemaVersion,
        input.artifactSha256,
        input.featureSidecarSha256,
        input.featureSidecarPath,
        input.featureCutoffGameweek,
        input.error,
      ]
    );
    runId = Number(db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0]);
    if (!Number.isInteger(runId) || runId <= 0) throw new Error('Failed to obtain ML shadow run id');
    const statement = db.prepare(`
      INSERT INTO ml_shadow_player_forecasts (
        run_id, player_id, fixture_count, coverage, heuristic_points,
        heuristic_minutes_per_fixture, heuristic_minutes_gameweek, heuristic_confidence,
        ml_points, ml_expected_minutes, ml_appearance_probability, ml_start_probability,
        ml_direct_points, ml_conditional_points, feature_payload_json
        , ml_expected_appearances, ml_expected_starts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    try {
      for (const forecast of input.forecasts) {
        statement.run([
          runId,
          forecast.playerId,
          forecast.fixtureCount,
          forecast.coverage,
          forecast.heuristicPoints,
          forecast.heuristicMinutesPerFixture,
          forecast.heuristicMinutesGameweek,
          forecast.heuristicConfidence,
          forecast.mlPoints,
          forecast.mlExpectedMinutes,
          forecast.mlAppearanceProbability,
          forecast.mlStartProbability,
          forecast.mlDirectPoints,
          forecast.mlConditionalPoints,
          forecast.featurePayloadJson,
          forecast.mlExpectedAppearances,
          forecast.mlExpectedStarts,
        ]);
      }
    } finally {
      statement.free();
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
  saveDatabase();
  return runId;
}

export async function getMlShadowForecastRuns(
  season?: string,
  gameweek?: number
): Promise<MlShadowForecastRunRecord[]> {
  const db = await initDatabase();
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (season !== undefined) {
    clauses.push('run.season = ?');
    params.push(season);
  }
  if (gameweek !== undefined) {
    clauses.push('run.gameweek = ?');
    params.push(gameweek);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = db.exec(`
    SELECT run.id, run.season, run.gameweek, run.deadline_at, run.captured_at, run.completed_at,
      run.status, run.model_version, run.schema_version, run.error,
      COUNT(forecast.player_id) AS player_count
    FROM ml_shadow_forecast_runs run
    LEFT JOIN ml_shadow_player_forecasts forecast ON forecast.run_id = run.id
    ${where}
    GROUP BY run.id
    ORDER BY run.captured_at DESC, run.id DESC
  `, params);
  return (result[0]?.values ?? []).map(row => ({
    id: Number(row[0]),
    season: String(row[1]),
    gameweek: Number(row[2]),
    deadlineAt: new Date(Number(row[3])),
    capturedAt: new Date(Number(row[4])),
    completedAt: row[5] === null ? null : new Date(Number(row[5])),
    status: String(row[6]) as MlShadowForecastRunRecord['status'],
    modelVersion: row[7] === null ? null : String(row[7]),
    schemaVersion: row[8] === null ? null : String(row[8]),
    error: row[9] === null ? null : String(row[9]),
    playerCount: Number(row[10]),
  }));
}

export async function reconcileMlShadowForecastOutcomes(
  season: string,
  gameweek: number,
  actuals: Map<number, { points: number; minutes: number; starts: number }>
): Promise<number> {
  const db = await initDatabase();
  const runRows = db.exec(
    `SELECT id FROM ml_shadow_forecast_runs
     WHERE season = ? AND gameweek = ? AND status = 'completed' AND completed_at <= deadline_at`,
    [season, gameweek]
  )[0]?.values ?? [];
  if (runRows.length === 0 || actuals.size === 0) return 0;
  let updated = 0;
  db.run('BEGIN TRANSACTION');
  try {
    const statement = db.prepare(`
      UPDATE ml_shadow_player_forecasts
      SET actual_points = ?, actual_minutes = ?, actual_starts = ?
      WHERE run_id = ? AND player_id = ?
    `);
    try {
      for (const row of runRows) {
        const runId = Number(row[0]);
        for (const [playerId, actual] of actuals) {
          statement.run([actual.points, actual.minutes, actual.starts, runId, playerId]);
          updated += db.getRowsModified();
        }
      }
    } finally {
      statement.free();
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
  if (updated > 0) saveDatabase();
  return updated;
}

export async function getMlShadowForecastAccuracy(
  season?: string,
  gameweek?: number
): Promise<{
  samples: number;
  heuristicMeanAbsoluteError: number;
  mlMeanAbsoluteError: number;
  mlBias: number;
  mlRootMeanSquaredError: number;
  mlWins: number;
  ties: number;
  heuristicWins: number;
}> {
  const db = await initDatabase();
  const clauses = [
    `run.status = 'completed'`,
    'run.completed_at <= run.deadline_at',
    `forecast.coverage = 'predicted'`,
    'forecast.ml_points IS NOT NULL',
    'forecast.actual_points IS NOT NULL',
    `run.id = (
      SELECT candidate.id FROM ml_shadow_forecast_runs candidate
      WHERE candidate.season = run.season
        AND candidate.gameweek = run.gameweek
        AND candidate.status = 'completed'
        AND candidate.completed_at <= candidate.deadline_at
      ORDER BY candidate.completed_at DESC, candidate.id DESC
      LIMIT 1
    )`,
  ];
  const params: (string | number)[] = [];
  if (season !== undefined) {
    clauses.push('run.season = ?');
    params.push(season);
  }
  if (gameweek !== undefined) {
    clauses.push('run.gameweek = ?');
    params.push(gameweek);
  }
  const result = db.exec(`
    SELECT forecast.heuristic_points, forecast.ml_points, forecast.actual_points
    FROM ml_shadow_player_forecasts forecast
    INNER JOIN ml_shadow_forecast_runs run ON run.id = forecast.run_id
    WHERE ${clauses.join(' AND ')}
  `, params);
  const rows = result[0]?.values ?? [];
  if (rows.length === 0) {
    return {
      samples: 0,
      heuristicMeanAbsoluteError: 0,
      mlMeanAbsoluteError: 0,
      mlBias: 0,
      mlRootMeanSquaredError: 0,
      mlWins: 0,
      ties: 0,
      heuristicWins: 0,
    };
  }
  const errors = rows.map(row => {
    const actual = Number(row[2]);
    return {
      heuristic: Number(row[0]) - actual,
      ml: Number(row[1]) - actual,
    };
  });
  let mlWins = 0;
  let ties = 0;
  let heuristicWins = 0;
  for (const error of errors) {
    const heuristicAbsolute = Math.abs(error.heuristic);
    const mlAbsolute = Math.abs(error.ml);
    if (mlAbsolute < heuristicAbsolute) mlWins += 1;
    else if (mlAbsolute > heuristicAbsolute) heuristicWins += 1;
    else ties += 1;
  }
  return {
    samples: errors.length,
    heuristicMeanAbsoluteError: errors.reduce((total, error) => total + Math.abs(error.heuristic), 0) / errors.length,
    mlMeanAbsoluteError: errors.reduce((total, error) => total + Math.abs(error.ml), 0) / errors.length,
    mlBias: errors.reduce((total, error) => total + error.ml, 0) / errors.length,
    mlRootMeanSquaredError: Math.sqrt(errors.reduce((total, error) => total + error.ml * error.ml, 0) / errors.length),
    mlWins,
    ties,
    heuristicWins,
  };
}

function validateMlShadowForecastRun(input: MlShadowForecastRunInput): void {
  if (!/^\d{4}-\d{4}$/.test(input.season)) throw new Error(`Invalid ML shadow season ${input.season}`);
  if (!Number.isInteger(input.gameweek) || input.gameweek < 1 || input.gameweek > 38) {
    throw new Error(`Invalid ML shadow gameweek ${input.gameweek}`);
  }
  if (
    Number.isNaN(input.deadlineAt.getTime())
    || Number.isNaN(input.capturedAt.getTime())
    || Number.isNaN(input.completedAt.getTime())
  ) {
    throw new Error('Invalid ML shadow timestamps');
  }
  if (input.capturedAt > input.deadlineAt) throw new Error('ML shadow capture is after the deadline');
  if (input.completedAt < input.capturedAt) throw new Error('ML shadow completion predates capture');
  if (input.status === 'completed') {
    if (input.completedAt > input.deadlineAt) throw new Error('Completed ML shadow run finished after the deadline');
    if (
      !input.modelVersion
      || !input.schemaVersion
      || !input.artifactSha256
      || !input.featureSidecarSha256
      || !input.featureSidecarPath
    ) {
      throw new Error('Completed ML shadow run is missing artifact provenance');
    }
    if (input.featureCutoffGameweek !== input.gameweek - 1) {
      throw new Error('Completed ML shadow run has an invalid feature cutoff');
    }
    if (input.forecasts.length === 0) throw new Error('Completed ML shadow run has no forecasts');
  } else if (!input.error || input.forecasts.length > 0) {
    throw new Error('Failed ML shadow run must contain an error and no forecasts');
  }
  const players = new Set<number>();
  for (const forecast of input.forecasts) {
    if (!Number.isInteger(forecast.playerId) || forecast.playerId <= 0 || players.has(forecast.playerId)) {
      throw new Error(`Invalid or duplicate ML shadow player ${forecast.playerId}`);
    }
    players.add(forecast.playerId);
    if (!Number.isInteger(forecast.fixtureCount) || forecast.fixtureCount < 0) {
      throw new Error(`Invalid ML shadow fixture count for player ${forecast.playerId}`);
    }
    if (forecast.coverage === 'predicted' && forecast.fixtureCount === 0) {
      throw new Error(`Predicted ML shadow player ${forecast.playerId} has no fixtures`);
    }
    if (forecast.coverage === 'no-fixture' && (forecast.fixtureCount !== 0 || forecast.mlPoints !== null)) {
      throw new Error(`No-fixture ML shadow player ${forecast.playerId} contains a prediction`);
    }
    const numbers = [
      forecast.heuristicPoints,
      forecast.heuristicMinutesPerFixture,
      forecast.heuristicMinutesGameweek,
      forecast.heuristicConfidence,
      forecast.mlPoints,
      forecast.mlExpectedMinutes,
      forecast.mlAppearanceProbability,
      forecast.mlStartProbability,
      forecast.mlDirectPoints,
      forecast.mlConditionalPoints,
      forecast.mlExpectedAppearances,
      forecast.mlExpectedStarts,
    ].filter((value): value is number => value !== null);
    if (!numbers.every(Number.isFinite)) throw new Error(`ML shadow player ${forecast.playerId} has non-finite values`);
  }
}

function latestStates(db: SqlJsDatabase, table: string, idColumn: string): Map<number, string> {
  const result = db.exec(`
    SELECT current.${idColumn}, current.state_json
    FROM ${table} current
    INNER JOIN (SELECT ${idColumn}, MAX(id) AS max_id FROM ${table} GROUP BY ${idColumn}) latest
      ON current.id = latest.max_id
  `);
  if (!result[0]) return new Map();
  return new Map(result[0].values.map(row => [Number(row[0]), String(row[1])]));
}

export interface RollingPlayerProfile {
  playerId: number;
  events: number;
  minutes: number;
  starts: number;
  minutesPerEvent: number;
  startRate: number;
  expectedGoalsPer90: number;
  expectedAssistsPer90: number;
  expectedGoalsConcededPer90: number;
  reliability: number;
}

export async function getRollingPlayerProfiles(
  targetGameweek: number,
  window: number = 6
): Promise<Map<number, RollingPlayerProfile>> {
  const db = await initDatabase();
  const result = db.exec(`
    SELECT observation.player_id, observation.gameweek, observation.state_json
    FROM player_observations observation
    INNER JOIN (
      SELECT player_id, gameweek, MAX(id) AS max_id
      FROM player_observations
      WHERE gameweek <= ?
      GROUP BY player_id, gameweek
    ) latest ON observation.id = latest.max_id
    ORDER BY observation.player_id, observation.gameweek DESC
  `, [targetGameweek]);
  const rows = result[0]?.values ?? [];
  const histories = new Map<number, { gameweek: number; state: Record<string, unknown> }[]>();
  for (const row of rows) {
    const playerId = Number(row[0]);
    const history = histories.get(playerId) ?? [];
    if (history.length <= window) {
      history.push({ gameweek: Number(row[1]), state: JSON.parse(String(row[2])) as Record<string, unknown> });
      histories.set(playerId, history);
    }
  }

  const profiles = new Map<number, RollingPlayerProfile>();
  for (const [playerId, history] of histories) {
    if (history.length < 2) continue;
    const current = history[0]!;
    const oldest = history[Math.min(window, history.length - 1)]!;
    const events = current.gameweek - oldest.gameweek;
    const minutes = Number(current.state.minutes) - Number(oldest.state.minutes);
    const starts = Number(current.state.starts) - Number(oldest.state.starts);
    const expectedGoals = Number(current.state.expectedGoals) - Number(oldest.state.expectedGoals);
    const expectedAssists = Number(current.state.expectedAssists) - Number(oldest.state.expectedAssists);
    const expectedGoalsConceded = Number(current.state.expectedGoalsConceded) - Number(oldest.state.expectedGoalsConceded);
    if (events <= 0 || minutes < 0 || starts < 0 || expectedGoals < 0 || expectedAssists < 0 || expectedGoalsConceded < 0) continue;
    const nineties = Math.max(0.1, minutes / 90);
    profiles.set(playerId, {
      playerId,
      events,
      minutes,
      starts,
      minutesPerEvent: minutes / events,
      startRate: starts / events,
      expectedGoalsPer90: expectedGoals / nineties,
      expectedAssistsPer90: expectedAssists / nineties,
      expectedGoalsConcededPer90: expectedGoalsConceded / nineties,
      reliability: Math.min(1, minutes / 450),
    });
  }
  return profiles;
}

// Performance Analytics
export interface PerformanceStats {
  totalDecisions: number;
  successfulDecisions: number;
  totalHitsTaken: number;
  averagePointsGain: number;
  rankChange: number;
  transferROI: number;
  captainSuccessRate: number;
}

export async function getPerformanceStats(fromGW?: number, toGW?: number): Promise<PerformanceStats> {
  let decisions: Decision[] = [];
  
  if (fromGW && toGW) {
    const db = await initDatabase();
    const result = db.exec(
      `SELECT * FROM decisions WHERE gameweek >= ${fromGW} AND gameweek <= ${toGW}`
    );
    if (result[0]) {
      decisions = result[0].values.map((row: unknown[]) =>
        fromDbRow(result[0].columns, row, decisionColumns) as unknown as Decision
      );
    }
  } else {
    decisions = await getDecisions();
  }
  
  const snapshots = await getRecentSnapshots(38);
  
  const totalDecisions = decisions.length;
  const successfulDecisions = decisions.filter(d => 
    d.actualPoints !== null && d.expectedPoints !== null && d.actualPoints > d.expectedPoints
  ).length;
  const totalHitsTaken = decisions.reduce((sum, d) => sum + (d.hitsTaken || 0), 0);
  
  const pointsGains = decisions
    .filter(d => d.actualPoints !== null && d.expectedPoints !== null)
    .map(d => (d.actualPoints || 0) - (d.expectedPoints || 0));
  const averagePointsGain = pointsGains.length > 0 
    ? pointsGains.reduce((a, b) => a + b, 0) / pointsGains.length 
    : 0;
  
  const sortedSnapshots = [...snapshots].sort((a, b) => a.gameweek - b.gameweek);
  const rankChange = sortedSnapshots.length >= 2
    ? (sortedSnapshots[0].overallRank || 0) - (sortedSnapshots[sortedSnapshots.length - 1].overallRank || 0)
    : 0;
  
  const transferDecisions = decisions.filter(d => d.decisionType === 'transfer');
  const transferPoints = transferDecisions.reduce((sum, d) => sum + (d.actualPoints || 0), 0);
  const transferHits = transferDecisions.reduce((sum, d) => sum + (d.hitsTaken || 0), 0);
  const transferROI = transferHits > 0 ? transferPoints / (transferHits * 4) : transferPoints > 0 ? Infinity : 0;
  
  const captainDecisions = decisions.filter(d => d.decisionType === 'captain');
  const captainSuccesses = captainDecisions.filter(d => 
    d.actualPoints !== null && d.expectedPoints !== null && d.actualPoints >= d.expectedPoints
  ).length;
  const captainSuccessRate = captainDecisions.length > 0 
    ? captainSuccesses / captainDecisions.length 
    : 0;
  
  return {
    totalDecisions,
    successfulDecisions,
    totalHitsTaken,
    averagePointsGain,
    rankChange,
    transferROI,
    captainSuccessRate,
  };
}
