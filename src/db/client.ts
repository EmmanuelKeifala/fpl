// Database Client using sql.js (pure JavaScript SQLite - works on Android/Termux)
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import type { Decision, NewDecision, GameweekSnapshot, NewGameweekSnapshot } from './schema.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

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
  
  dbReady = true;
  saveDatabase();
  
  return sqlDb;
}

function saveDatabase(): void {
  if (sqlDb) {
    const data = sqlDb.export();
    const buffer = Buffer.from(data);
    writeFileSync(DB_PATH, buffer);
  }
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
