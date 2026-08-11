// Live season configuration derived from the game's own bootstrap payload.
// Season-specific values (budget, chip windows, saved transfer cap) change between
// seasons, so read them from the API instead of hardcoding last season's numbers.
import type { BootstrapStatic, Gameweek } from '../api/types.js';
import { FPL_RULES, type ChipName } from './rules.js';

const CHIP_NAMES: readonly ChipName[] = ['wildcard', 'freehit', 'bboost', '3xc'];

export interface ChipWindow {
  name: ChipName;
  number: number;
  startEvent: number;
  stopEvent: number;
  chipType: string;
}

export interface LiveSeasonConfig {
  season: string;
  squadSize: number;
  startingSize: number;
  budget: number;
  maxPlayersPerClub: number;
  maxTransfersPerGameweek: number;
  maxSavedFreeTransfers: number;
  sellOnFeeRatio: number;
  chipWindows: ChipWindow[];
  chipHalfBoundaryGameweek: number | null;
  transferTopUps: Record<number, number>;
}

function isChipName(name: string): name is ChipName {
  return (CHIP_NAMES as readonly string[]).includes(name);
}

export function deriveSeasonLabel(events: Gameweek[]): string {
  const firstDeadline = events
    .map(event => new Date(event.deadline_time))
    .filter(date => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime())[0];

  if (!firstDeadline) throw new Error('Cannot derive season label without gameweek deadlines');

  // Seasons open in July/August, so the first deadline's year is the starting year.
  const startYear = firstDeadline.getUTCFullYear();
  return `${startYear}-${startYear + 1}`;
}

// Extra free transfer grants (AFCON top-ups) are announced in-season and are not
// published in bootstrap, so they are supplied by configuration when they happen.
export function parseTransferTopUps(raw: string | undefined): Record<number, number> {
  if (!raw) return {};
  const topUps: Record<number, number> = {};

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [gameweekPart, amountPart] = trimmed.split(':');
    const gameweek = Number(gameweekPart);
    const amount = Number(amountPart);
    if (!Number.isInteger(gameweek) || gameweek < 1 || gameweek > 38 || !Number.isFinite(amount) || amount < 0) {
      throw new Error(`Invalid transfer top-up "${trimmed}"; expected <gameweek>:<freeTransfers>`);
    }
    topUps[gameweek] = amount;
  }

  return topUps;
}

export function deriveSeasonConfig(bootstrap: BootstrapStatic): LiveSeasonConfig {
  const settings = bootstrap.game_settings;

  const chipWindows: ChipWindow[] = (bootstrap.chips ?? [])
    .filter(chip => isChipName(chip.name))
    .map(chip => ({
      name: chip.name as ChipName,
      number: chip.number,
      startEvent: chip.start_event,
      stopEvent: chip.stop_event,
      chipType: chip.chip_type,
    }));

  if (chipWindows.length === 0) {
    throw new Error('Bootstrap returned no recognizable chip windows');
  }

  const finalGameweek = Math.max(...bootstrap.events.map(event => event.id));
  const intermediateStops = chipWindows.map(window => window.stopEvent).filter(stop => stop < finalGameweek);
  const chipHalfBoundaryGameweek = intermediateStops.length > 0 ? Math.min(...intermediateStops) : null;

  return {
    season: deriveSeasonLabel(bootstrap.events),
    squadSize: settings.squad_squadsize ?? FPL_RULES.squadSize,
    startingSize: settings.squad_squadplay ?? FPL_RULES.startingSize,
    budget: settings.squad_total_spend ?? FPL_RULES.initialBudget,
    maxPlayersPerClub: settings.squad_team_limit ?? FPL_RULES.maxPlayersPerClub,
    maxTransfersPerGameweek: settings.transfers_cap ?? FPL_RULES.maxTransfersPerGameweek,
    maxSavedFreeTransfers: 1 + (settings.max_extra_free_transfers ?? FPL_RULES.maxFreeTransfers - 1),
    sellOnFeeRatio: settings.transfers_sell_on_fee ?? 0.5,
    chipWindows,
    chipHalfBoundaryGameweek,
    transferTopUps: parseTransferTopUps(process.env.FPL_TRANSFER_TOP_UPS),
  };
}

export function isChipLegalInGameweek(config: LiveSeasonConfig, chip: ChipName, gameweek: number): boolean {
  return config.chipWindows.some(
    window => window.name === chip && gameweek >= window.startEvent && gameweek <= window.stopEvent
  );
}

export function getFreeTransfersAfterGameweekForSeason(
  config: LiveSeasonConfig,
  input: { previousFreeTransfers: number; transfersMade: number; nextGameweek: number }
): number {
  const topUp = config.transferTopUps[input.nextGameweek];
  if (topUp !== undefined) return topUp;

  const remaining = Math.max(0, input.previousFreeTransfers - input.transfersMade);
  return Math.max(1, Math.min(config.maxSavedFreeTransfers, remaining + 1));
}

// Surfaces rule drift between the live game and the static assumptions the strategy
// code still carries, so a mid-season rule change is visible instead of silent.
export function getSeasonConfigWarnings(config: LiveSeasonConfig): string[] {
  const warnings: string[] = [];

  if (config.squadSize !== FPL_RULES.squadSize) {
    warnings.push(`Squad size is ${config.squadSize}; strategy rules assume ${FPL_RULES.squadSize}`);
  }
  if (config.startingSize !== FPL_RULES.startingSize) {
    warnings.push(`Starting XI size is ${config.startingSize}; strategy rules assume ${FPL_RULES.startingSize}`);
  }
  if (config.budget !== FPL_RULES.initialBudget) {
    warnings.push(`Budget is ${config.budget}; strategy rules assume ${FPL_RULES.initialBudget}`);
  }
  if (config.maxPlayersPerClub !== FPL_RULES.maxPlayersPerClub) {
    warnings.push(`Club limit is ${config.maxPlayersPerClub}; strategy rules assume ${FPL_RULES.maxPlayersPerClub}`);
  }
  if (config.maxSavedFreeTransfers !== FPL_RULES.maxFreeTransfers) {
    warnings.push(`Saved free transfer cap is ${config.maxSavedFreeTransfers}; strategy rules assume ${FPL_RULES.maxFreeTransfers}`);
  }
  if (config.maxTransfersPerGameweek !== FPL_RULES.maxTransfersPerGameweek) {
    warnings.push(`Transfer cap is ${config.maxTransfersPerGameweek}; strategy rules assume ${FPL_RULES.maxTransfersPerGameweek}`);
  }

  return warnings;
}

export function describeSeasonConfig(config: LiveSeasonConfig): string[] {
  const chips = config.chipWindows
    .map(window => `${window.name} GW${window.startEvent}-${window.stopEvent}`)
    .join(', ');

  return [
    `Season: ${config.season}`,
    `Squad: ${config.squadSize} players, XI ${config.startingSize}, budget £${(config.budget / 10).toFixed(1)}m, max ${config.maxPlayersPerClub}/club`,
    `Transfers: up to ${config.maxSavedFreeTransfers} saved, ${config.maxTransfersPerGameweek} per gameweek, sell-on fee ${config.sellOnFeeRatio}`,
    `Chips: ${chips}`,
    `Chip half boundary: ${config.chipHalfBoundaryGameweek ? `GW${config.chipHalfBoundaryGameweek}` : 'none'}`,
    `Transfer top-ups: ${Object.keys(config.transferTopUps).length > 0 ? JSON.stringify(config.transferTopUps) : 'none configured'}`,
  ];
}
