import type { ChipName } from '../strategy/rules.js';
import type { ManagerState, SnapshotProvenance, WeeklyResult } from './types.js';

export type BacktestStrategyName = 'baseline' | 'fair' | 'oracle';

export interface TransferReportRow {
  gameweek: number;
  out: number;
  in: number;
}

export interface ChipReportRow {
  gameweek: number;
  chip: ChipName;
  points: number;
}

export interface BacktestReport {
  strategy: BacktestStrategyName;
  season: string;
  totalPoints: number;
  captainPointsTotal: number;
  benchPointsTotal: number;
  estimatedRankPercentile: number | null;
  weekly: WeeklyResult[];
  transfers: TransferReportRow[];
  chips: ChipReportRow[];
  finalSquad: number[];
  finalBank: number;
  finalSquadValue: number;
  provenance: SnapshotProvenance;
}

export function buildBacktestReport(
  state: ManagerState,
  provenance: SnapshotProvenance,
  strategy: BacktestStrategyName = 'baseline',
): BacktestReport {
  const transfers = state.decisions.flatMap(decision => decision.transfers.map(transfer => ({
    gameweek: decision.gameweek,
    out: transfer.out,
    in: transfer.in,
  })));
  const chips = state.weeklyResults
    .filter(result => result.chip)
    .map(result => ({ gameweek: result.gameweek, chip: result.chip as ChipName, points: result.points }));
  const lastWeek = state.weeklyResults[state.weeklyResults.length - 1];
  const finalSquadValue = lastWeek?.chip === 'freehit'
    ? state.squad.reduce((total, pick) => total + pick.sellingPrice, state.bank)
    : lastWeek?.squadValue ?? state.bank;

  return {
    strategy,
    season: state.season,
    totalPoints: state.totalPoints,
    captainPointsTotal: state.weeklyResults.reduce((total, result) => total + result.captainPoints, 0),
    benchPointsTotal: state.weeklyResults.reduce((total, result) => total + result.benchPoints, 0),
    estimatedRankPercentile: null,
    weekly: state.weeklyResults,
    transfers,
    chips,
    finalSquad: state.squad.map(pick => pick.playerId),
    finalBank: state.bank,
    finalSquadValue,
    provenance,
  };
}

export function formatBacktestSummary(report: BacktestReport): string {
  const squadValue = (report.finalSquadValue / 10).toFixed(1);
  const rank = report.estimatedRankPercentile === null ? 'unavailable' : `${report.estimatedRankPercentile.toFixed(1)}%`;

  return [
    `Season: ${report.season}`,
    `Strategy: ${report.strategy}`,
    `Total points: ${report.totalPoints}`,
    `Estimated rank percentile: ${rank}`,
    `Gameweeks replayed: ${report.weekly.length}`,
    `Transfers made: ${report.transfers.length}`,
    `Chips played: ${report.chips.length}`,
    `Squad value: ${squadValue}m`,
    `Snapshot version: ${report.provenance.snapshotVersion}`,
  ].join('\n');
}
