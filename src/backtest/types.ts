import type { ChipName } from '../strategy/rules.js';

export interface BacktestPlayer {
  id: number;
  webName: string;
  elementType: number;
  team: number;
  price: number;
  status: string;
  selectedByPercent: number;
  expectedPoints: number;
}

export interface BacktestFixture {
  id: number;
  event: number;
  kickoffTime: string;
  teamHome: number;
  teamAway: number;
  teamHomeDifficulty: number;
  teamAwayDifficulty: number;
}

export interface PlayerGameweekResult {
  playerId: number;
  minutes: number;
  totalPoints: number;
}

export interface SnapshotProvenance {
  sourceUrls: string[];
  downloadedAt: string;
  snapshotVersion: string;
  knownLimitations: string[];
}

export interface GameweekSnapshot {
  season: string;
  gameweek: number;
  deadline: string;
  knownBeforeDeadline: {
    players: BacktestPlayer[];
    fixtures: BacktestFixture[];
    unavailableFields: string[];
  };
  actualResults: {
    playerResults: PlayerGameweekResult[];
    averageEntryScore: number;
    highestScore: number;
  };
  provenance: SnapshotProvenance;
}

export type DecisionSnapshotInput = Omit<GameweekSnapshot, 'actualResults'>;

export interface SquadPick {
  playerId: number;
  purchasePrice: number;
  sellingPrice: number;
}

export interface TransferMove {
  out: number;
  in: number;
}

export interface BacktestDecision {
  gameweek: number;
  squad?: number[];
  transfers: TransferMove[];
  startingXi: number[];
  bench: number[];
  captain: number;
  viceCaptain: number;
  chip?: ChipName;
  expectedUtility?: number;
  notes: string[];
}

export interface WeeklyResult {
  gameweek: number;
  points: number;
  transferCost: number;
  grossPoints: number;
  captainPoints: number;
  benchPoints: number;
  chip?: ChipName;
  squadValue: number;
  bank: number;
}

export interface ManagerState {
  season: string;
  squad: SquadPick[];
  bank: number;
  freeTransfers: number;
  chipsAvailable: ChipName[];
  totalPoints: number;
  weeklyResults: WeeklyResult[];
  decisions: BacktestDecision[];
}

export interface StrategyContext {
  state: ManagerState;
  snapshot: DecisionSnapshotInput;
}

export type BacktestStrategy = (context: StrategyContext) => BacktestDecision | Promise<BacktestDecision>;
