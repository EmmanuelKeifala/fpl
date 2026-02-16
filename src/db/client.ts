// Database Client
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, desc, and, gte, lte } from 'drizzle-orm';
import * as schema from './schema.js';
import type { Decision, NewDecision, GameweekSnapshot, NewGameweekSnapshot } from './schema.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize database
const DB_PATH = join(__dirname, '../../data/fpl.db');

// Ensure data directory exists
import { mkdirSync } from 'fs';
try {
  mkdirSync(join(__dirname, '../../data'), { recursive: true });
} catch {
  // Directory exists
}

const sqlite = new Database(DB_PATH);
export const db = drizzle(sqlite, { schema });

// Create tables if they don't exist
sqlite.exec(`
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
  );

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
  );

  CREATE INDEX IF NOT EXISTS idx_decisions_gameweek ON decisions(gameweek);
  CREATE INDEX IF NOT EXISTS idx_decisions_type ON decisions(decision_type);
`);

// Decision CRUD operations
export async function logDecision(decision: NewDecision): Promise<Decision> {
  const result = await db.insert(schema.decisions).values(decision).returning();
  return result[0];
}

export async function updateDecisionOutcome(
  id: number,
  actualPoints: number,
  rankAfter: number
): Promise<void> {
  await db.update(schema.decisions)
    .set({ actualPoints, rankAfter })
    .where(eq(schema.decisions.id, id));
}

export async function getDecisions(gameweek?: number): Promise<Decision[]> {
  if (gameweek) {
    return db.select().from(schema.decisions)
      .where(eq(schema.decisions.gameweek, gameweek))
      .orderBy(desc(schema.decisions.createdAt));
  }
  return db.select().from(schema.decisions)
    .orderBy(desc(schema.decisions.createdAt))
    .limit(50);
}

export async function getDecisionsByType(type: string): Promise<Decision[]> {
  return db.select().from(schema.decisions)
    .where(eq(schema.decisions.decisionType, type))
    .orderBy(desc(schema.decisions.createdAt))
    .limit(50);
}

// Gameweek Snapshot CRUD
export async function saveGameweekSnapshot(snapshot: NewGameweekSnapshot): Promise<GameweekSnapshot> {
  const result = await db.insert(schema.gameweekSnapshots)
    .values(snapshot)
    .onConflictDoUpdate({
      target: schema.gameweekSnapshots.gameweek,
      set: snapshot,
    })
    .returning();
  return result[0];
}

export async function getGameweekSnapshot(gameweek: number): Promise<GameweekSnapshot | undefined> {
  const result = await db.select().from(schema.gameweekSnapshots)
    .where(eq(schema.gameweekSnapshots.gameweek, gameweek))
    .limit(1);
  return result[0];
}

export async function getRecentSnapshots(limit = 10): Promise<GameweekSnapshot[]> {
  return db.select().from(schema.gameweekSnapshots)
    .orderBy(desc(schema.gameweekSnapshots.gameweek))
    .limit(limit);
}

// Performance Analytics
export interface PerformanceStats {
  totalDecisions: number;
  successfulDecisions: number; // Where actual > expected
  totalHitsTaken: number;
  averagePointsGain: number;
  rankChange: number;
  transferROI: number;
  captainSuccessRate: number;
}

export async function getPerformanceStats(fromGW?: number, toGW?: number): Promise<PerformanceStats> {
  let decisionsQuery = db.select().from(schema.decisions);
  
  if (fromGW && toGW) {
    decisionsQuery = db.select().from(schema.decisions)
      .where(and(
        gte(schema.decisions.gameweek, fromGW),
        lte(schema.decisions.gameweek, toGW)
      )) as typeof decisionsQuery;
  }
  
  const decisions = await decisionsQuery;
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
  
  // Calculate rank change from snapshots
  const sortedSnapshots = [...snapshots].sort((a, b) => a.gameweek - b.gameweek);
  const rankChange = sortedSnapshots.length >= 2
    ? (sortedSnapshots[0].overallRank || 0) - (sortedSnapshots[sortedSnapshots.length - 1].overallRank || 0)
    : 0;
  
  // Transfer ROI: points gained / hits taken
  const transferDecisions = decisions.filter(d => d.decisionType === 'transfer');
  const transferPoints = transferDecisions.reduce((sum, d) => sum + (d.actualPoints || 0), 0);
  const transferHits = transferDecisions.reduce((sum, d) => sum + (d.hitsTaken || 0), 0);
  const transferROI = transferHits > 0 ? transferPoints / (transferHits * 4) : transferPoints > 0 ? Infinity : 0;
  
  // Captain success rate
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
