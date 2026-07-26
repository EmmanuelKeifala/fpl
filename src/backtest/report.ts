import type { ChipName } from '../strategy/rules.js';
import type { GameweekSnapshot, ManagerState, ReplayDataMode, SnapshotProvenance, WeeklyResult } from './types.js';

export type BacktestStrategyName = 'baseline' | 'fair' | 'autonomous' | 'oracle';

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
  dataMode: ReplayDataMode;
  rulesVersion: string;
  integrityWarning: string | null;
  totalPoints: number;
  captainPointsTotal: number;
  benchPointsTotal: number;
  estimatedRankPercentile: number | null;
  top10kCutoff: number | null;
  pointsVsTop10k: number | null;
  metTop10kBenchmark: boolean | null;
  weekly: WeeklyResult[];
  weeklyBenchmark: WeeklyBenchmarkRow[];
  averageTotal: number;
  pointsAboveAverage: number;
  gameweeksAboveAverage: number;
  gameweeksLevelWithAverage: number;
  gameweeksBelowAverage: number;
  transfers: TransferReportRow[];
  chips: ChipReportRow[];
  finalSquad: number[];
  finalBank: number;
  finalSquadValue: number;
  provenance: SnapshotProvenance;
}

export interface WeeklyBenchmarkRow {
  gameweek: number;
  points: number;
  averageEntryScore: number;
  difference: number;
  cumulativePoints: number;
  cumulativeAverage: number;
  cumulativeDifference: number;
}

export function buildBacktestReport(
  state: ManagerState,
  provenance: SnapshotProvenance,
  strategy: BacktestStrategyName = 'baseline',
  snapshots: GameweekSnapshot[] = [],
  top10kCutoff?: number,
): BacktestReport {
  const integrityWarning = getIntegrityWarning(provenance.dataMode);
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
  const snapshotsByGameweek = new Map(snapshots.map(snapshot => [snapshot.gameweek, snapshot]));
  let cumulativePoints = 0;
  let cumulativeAverage = 0;
  const weeklyBenchmark = state.weeklyResults.map(result => {
    const averageEntryScore = snapshotsByGameweek.get(result.gameweek)?.actualResults.averageEntryScore ?? 0;
    cumulativePoints += result.points;
    cumulativeAverage += averageEntryScore;
    return {
      gameweek: result.gameweek,
      points: result.points,
      averageEntryScore,
      difference: result.points - averageEntryScore,
      cumulativePoints,
      cumulativeAverage,
      cumulativeDifference: cumulativePoints - cumulativeAverage,
    };
  });

  return {
    strategy,
    season: state.season,
    dataMode: provenance.dataMode,
    rulesVersion: provenance.rulesVersion,
    integrityWarning,
    totalPoints: state.totalPoints,
    captainPointsTotal: state.weeklyResults.reduce((total, result) => total + result.captainPoints, 0),
    benchPointsTotal: state.weeklyResults.reduce((total, result) => total + result.benchPoints, 0),
    estimatedRankPercentile: null,
    top10kCutoff: top10kCutoff ?? null,
    pointsVsTop10k: top10kCutoff === undefined ? null : state.totalPoints - top10kCutoff,
    metTop10kBenchmark: top10kCutoff === undefined || provenance.dataMode !== 'strict'
      ? null
      : state.totalPoints >= top10kCutoff,
    weekly: state.weeklyResults,
    weeklyBenchmark,
    averageTotal: cumulativeAverage,
    pointsAboveAverage: cumulativePoints - cumulativeAverage,
    gameweeksAboveAverage: weeklyBenchmark.filter(row => row.difference > 0).length,
    gameweeksLevelWithAverage: weeklyBenchmark.filter(row => row.difference === 0).length,
    gameweeksBelowAverage: weeklyBenchmark.filter(row => row.difference < 0).length,
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
    `Data mode: ${report.dataMode}`,
    `Rules version: ${report.rulesVersion}`,
    ...(report.integrityWarning ? [`Integrity warning: ${report.integrityWarning}`] : []),
    `Total points: ${report.totalPoints}`,
    `FPL average total: ${report.averageTotal}`,
    `Points vs average: ${report.pointsAboveAverage >= 0 ? '+' : ''}${report.pointsAboveAverage}`,
    `GW record vs average: ${report.gameweeksAboveAverage}W-${report.gameweeksLevelWithAverage}D-${report.gameweeksBelowAverage}L`,
    `Estimated rank percentile: ${rank}`,
    `Top-10k cutoff: ${report.top10kCutoff ?? 'unavailable'}`,
    `Points vs top 10k: ${report.pointsVsTop10k === null ? 'unavailable' : `${report.pointsVsTop10k >= 0 ? '+' : ''}${report.pointsVsTop10k}`}`,
    `Gameweeks replayed: ${report.weekly.length}`,
    `Transfers made: ${report.transfers.length}`,
    `Chips played: ${report.chips.length}`,
    `Squad value: ${squadValue}m`,
    `Snapshot version: ${report.provenance.snapshotVersion}`,
  ].join('\n');
}

function getIntegrityWarning(dataMode: ReplayDataMode): string | null {
  if (dataMode === 'legacy') {
    return 'Legacy replay data is diagnostic only and cannot support verified performance claims.';
  }
  if (dataMode === 'reconstructed') {
    return 'Reconstructed replay data cannot claim verified top-10k performance.';
  }
  return null;
}
