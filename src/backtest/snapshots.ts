import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DecisionSnapshotInput, GameweekSnapshot } from './types.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateSnapshot(snapshot: GameweekSnapshot): ValidationResult {
  const errors: string[] = [];

  if (!snapshot.season) errors.push('Snapshot season is required');
  if (!Number.isInteger(snapshot.gameweek) || snapshot.gameweek < 1 || snapshot.gameweek > 38) {
    errors.push(`Invalid gameweek ${snapshot.gameweek}`);
  }
  if (Number.isNaN(Date.parse(snapshot.deadline))) errors.push(`Invalid deadline ${snapshot.deadline}`);

  const playerIds = new Set<number>();
  for (const player of snapshot.knownBeforeDeadline.players) {
    if (playerIds.has(player.id)) errors.push(`Duplicate player id ${player.id} in knownBeforeDeadline.players`);
    playerIds.add(player.id);
    if (player.price <= 0) errors.push(`Invalid price ${player.price} for player id ${player.id}`);
  }

  const resultIds = new Set(snapshot.actualResults.playerResults.map(result => result.playerId));
  for (const playerId of playerIds) {
    if (!resultIds.has(playerId)) errors.push(`Missing actual result for player id ${playerId}`);
  }

  const fixtureIds = new Set<number>();
  for (const fixture of snapshot.knownBeforeDeadline.fixtures) {
    if (fixtureIds.has(fixture.id)) errors.push(`Duplicate fixture id ${fixture.id}`);
    fixtureIds.add(fixture.id);
    if (fixture.event !== snapshot.gameweek) errors.push(`Fixture ${fixture.id} has event ${fixture.event}; expected ${snapshot.gameweek}`);
  }

  if (snapshot.provenance.sourceUrls.length === 0) errors.push('At least one provenance source URL is required');
  if (!snapshot.provenance.snapshotVersion) errors.push('Snapshot version is required');

  return { valid: errors.length === 0, errors };
}

export class FileSnapshotStore {
  constructor(private readonly directory: string) {}

  async getSnapshot(gameweek: number): Promise<GameweekSnapshot> {
    const raw = await readFile(join(this.directory, `gw-${gameweek}.json`), 'utf8');
    const snapshot = JSON.parse(raw) as GameweekSnapshot;
    const validation = validateSnapshot(snapshot);

    if (!validation.valid) {
      throw new Error(`Invalid snapshot for GW${gameweek}: ${validation.errors.join('; ')}`);
    }

    return snapshot;
  }

  toDecisionInput(snapshot: GameweekSnapshot): DecisionSnapshotInput {
    return {
      season: snapshot.season,
      gameweek: snapshot.gameweek,
      deadline: snapshot.deadline,
      knownBeforeDeadline: snapshot.knownBeforeDeadline,
      provenance: snapshot.provenance,
    };
  }
}
