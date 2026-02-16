// Database Schema - Drizzle ORM with SQLite
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

// Track every decision and outcome for learning
export const decisions = sqliteTable('decisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  gameweek: integer('gameweek').notNull(),
  decisionType: text('decision_type').notNull(), // 'transfer', 'chip', 'captain', 'hold'
  action: text('action').notNull(), // JSON of what was done
  reasoning: text('reasoning'), // Agent's reasoning
  expectedPoints: real('expected_points'), // Predicted outcome
  actualPoints: real('actual_points'), // What actually happened (updated later)
  rankBefore: integer('rank_before'),
  rankAfter: integer('rank_after'),
  hitsTaken: integer('hits_taken').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

// Gameweek snapshots for tracking performance over time
export const gameweekSnapshots = sqliteTable('gameweek_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  gameweek: integer('gameweek').notNull().unique(),
  totalPoints: integer('total_points'),
  overallRank: integer('overall_rank'),
  gameweekPoints: integer('gameweek_points'),
  gameweekRank: integer('gameweek_rank'),
  teamValue: real('team_value'), // In millions
  bank: real('bank'), // In millions
  chipsUsed: text('chips_used'), // JSON array of chips used this GW
  transfersMade: integer('transfers_made'),
  transfersCost: integer('transfers_cost'),
  pointsOnBench: integer('points_on_bench'),
  captainId: integer('captain_id'),
  captainPoints: integer('captain_points'),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

// Type exports for queries
export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;
export type GameweekSnapshot = typeof gameweekSnapshots.$inferSelect;
export type NewGameweekSnapshot = typeof gameweekSnapshots.$inferInsert;
