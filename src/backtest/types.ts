import type { ChipName } from '../strategy/rules.js';

export type ReplayDataMode = 'legacy' | 'reconstructed' | 'strict';
export type FieldAvailability = 'exact' | 'lagged' | 'reconstructed' | 'unavailable';

export interface ForecastProvenance {
  sourceGameweek: number | null;
  availability: FieldAvailability;
  source: string;
}

export interface BacktestPlayer {
  id: number;
  webName: string;
  elementType: number;
  team: number;
  price: number;
  status: string;
  selectedByPercent: number;
  expectedPoints: number;
  mlPrediction?: {
    modelVersion: string;
    appearanceProbability: number;
    startProbability: number;
    expectedMinutes: number;
    fixtureCount: number;
  };
  forecastProvenance: ForecastProvenance;
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
  dataMode: ReplayDataMode;
  rulesVersion: string;
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
  execution?: {
    phase: 'execute';
    freeTransfersBefore: number;
    bankBefore: number;
    projectedHitCost: number;
  };
  notes: string[];
}

export interface ReplayExecutionProfile {
  name: string;
  decisionTiming: 'final-pre-deadline';
  planningHorizonGameweeks: number;
  maxTransfersPerGameweek: number;
  minXPGainForHit: number;
  transfersEnabled: boolean;
  lineupEnabled: boolean;
  chipsEnabled: boolean;
  liveAccountMutations: false;
  historicalNews: 'unavailable';
  historicalLearning: 'revealed-results-only';
  limitations: string[];
}

export interface WeeklyResult {
  gameweek: number;
  points: number;
  transferCost: number;
  grossPoints: number;
  captainPoints: number;
  benchPoints: number;
  chip?: ChipName;
  chipGain?: number;
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
  revealedResults?: { gameweek: number; playerResults: PlayerGameweekResult[] }[];
}

export type BacktestStrategy = (context: StrategyContext) => BacktestDecision | Promise<BacktestDecision>;
