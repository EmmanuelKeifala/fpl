import type { CsvRow } from './csv.js';

export interface LaggedObservation {
  gameweek: number;
  minutes: number;
  totalPoints: number;
  starts: number;
  expectedGoals: number;
  expectedAssists: number;
}

export interface LaggedForecast {
  expectedPoints: number;
  sourceGameweek: number | null;
}

export function observationFromRows(gameweek: number, rows: CsvRow[]): LaggedObservation {
  return rows.reduce<LaggedObservation>((observation, row) => ({
    gameweek,
    minutes: observation.minutes + numberOrZero(row.minutes),
    totalPoints: observation.totalPoints + numberOrZero(row.total_points),
    starts: observation.starts + numberOrZero(row.starts),
    expectedGoals: observation.expectedGoals + numberOrZero(row.expected_goals),
    expectedAssists: observation.expectedAssists + numberOrZero(row.expected_assists),
  }), { gameweek, minutes: 0, totalPoints: 0, starts: 0, expectedGoals: 0, expectedAssists: 0 });
}

export function forecastFromHistory(elementType: number, price: number, history: LaggedObservation[]): LaggedForecast {
  const prior = pricePrior(elementType, price);
  if (history.length === 0) return { expectedPoints: prior, sourceGameweek: null };

  const recent = history.slice(-6);
  const totalMinutes = recent.reduce((sum, row) => sum + row.minutes, 0);
  const totalPoints = recent.reduce((sum, row) => sum + row.totalPoints, 0);
  const expectedGoals = recent.reduce((sum, row) => sum + row.expectedGoals, 0);
  const expectedAssists = recent.reduce((sum, row) => sum + row.expectedAssists, 0);
  const matches = recent.length;
  const expectedMinutes = Math.max(0, Math.min(90, totalMinutes / matches));
  const pointsPer90 = totalMinutes > 0 ? totalPoints * 90 / totalMinutes : prior;
  const attackingPointsPer90 = totalMinutes > 0
    ? (expectedGoals * goalPoints(elementType) + expectedAssists * 3) * 90 / totalMinutes
    : 0;
  const reliability = Math.min(1, totalMinutes / 900);
  const observed = Math.max(0, pointsPer90 * 0.8 + attackingPointsPer90 * 0.2) * expectedMinutes / 90;
  const expectedPoints = prior * (1 - reliability) + observed * reliability;

  return {
    expectedPoints: Math.round(Math.max(0, Math.min(15, expectedPoints)) * 10) / 10,
    sourceGameweek: recent[recent.length - 1]!.gameweek,
  };
}

function pricePrior(elementType: number, price: number): number {
  const minimumPrice = elementType === 1 || elementType === 2 ? 40 : 45;
  const base = elementType === 1 ? 3 : elementType === 2 ? 2.8 : elementType === 3 ? 2.8 : 3;
  const cap = elementType === 1 ? 5.5 : elementType === 2 ? 7 : 9.5;
  return Math.min(cap, base + Math.max(0, price - minimumPrice) * (elementType === 1 ? 0.05 : 0.075));
}

function goalPoints(elementType: number): number {
  return elementType === 1 ? 10 : elementType === 2 ? 6 : elementType === 3 ? 5 : 4;
}

function numberOrZero(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
