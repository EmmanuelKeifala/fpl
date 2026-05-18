import { FPL_RULES, POSITION_BY_ELEMENT_TYPE, type PositionKey } from './rules.js';

export interface SquadPlayer {
  id: number;
  elementType: number;
  team: number;
  price: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function countByPosition(elementTypes: number[]): Record<PositionKey, number> {
  const counts: Record<PositionKey, number> = {
    goalkeeper: 0,
    defender: 0,
    midfielder: 0,
    forward: 0,
  };

  for (const elementType of elementTypes) {
    const position = POSITION_BY_ELEMENT_TYPE[elementType];
    if (position) counts[position]++;
  }

  return counts;
}

export function validateFormation(elementTypes: number[]): ValidationResult {
  const errors: string[] = [];
  const counts = countByPosition(elementTypes);

  if (elementTypes.length !== FPL_RULES.startingSize) {
    errors.push(`Starting XI must contain exactly ${FPL_RULES.startingSize} players`);
  }

  for (const [position, limits] of Object.entries(FPL_RULES.formation)) {
    const count = counts[position as PositionKey];
    if (count < limits.min || count > limits.max) {
      errors.push(`${position} count ${count} is outside allowed range ${limits.min}-${limits.max}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateSquad(players: SquadPlayer[], budget: number): ValidationResult {
  const errors: string[] = [];

  if (players.length !== FPL_RULES.squadSize) {
    errors.push(`Squad must contain exactly ${FPL_RULES.squadSize} players`);
  }

  const counts = countByPosition(players.map(p => p.elementType));
  for (const [position, expected] of Object.entries(FPL_RULES.squadComposition)) {
    const actual = counts[position as PositionKey];
    if (actual !== expected) {
      errors.push(`${position} count ${actual} must equal ${expected}`);
    }
  }

  const cost = players.reduce((sum, p) => sum + p.price, 0);
  if (cost > budget) {
    errors.push(`Squad cost ${cost} exceeds budget ${budget}`);
  }

  const teamCounts = new Map<number, number>();
  for (const player of players) {
    teamCounts.set(player.team, (teamCounts.get(player.team) || 0) + 1);
  }
  for (const [team, count] of teamCounts) {
    if (count > FPL_RULES.maxPlayersPerClub) {
      errors.push(`Team ${team} has ${count} players; maximum is ${FPL_RULES.maxPlayersPerClub}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
