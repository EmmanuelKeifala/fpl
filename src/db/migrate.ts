// Database Migration Script
// Note: Tables are auto-created in client.ts via raw SQL.
// This script runs Drizzle Kit migrations for schema changes.
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from './client.js';

console.log('Running database migrations...');

try {
  migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations completed successfully.');
} catch (error) {
  console.error('Migration failed:', error);
  process.exit(1);
}
