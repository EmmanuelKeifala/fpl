import { applyGameweekDecision, createInitialState } from './state.js';
import type { BacktestStrategy, GameweekSnapshot, ManagerState } from './types.js';

export interface BacktestEngineOptions {
  season: string;
  gameweeks: number[];
  getSnapshot: (gameweek: number) => Promise<GameweekSnapshot>;
  strategy: BacktestStrategy;
}

export class BacktestEngine {
  constructor(private readonly options: BacktestEngineOptions) {}

  async run(): Promise<ManagerState> {
    let state = createInitialState(this.options.season);
    const revealedResults: { gameweek: number; playerResults: GameweekSnapshot['actualResults']['playerResults'] }[] = [];

    for (const gameweek of this.options.gameweeks) {
      const snapshot = await this.options.getSnapshot(gameweek);
      const decisionSnapshot = {
        season: snapshot.season,
        gameweek: snapshot.gameweek,
        deadline: snapshot.deadline,
        knownBeforeDeadline: structuredClone(snapshot.knownBeforeDeadline),
        provenance: structuredClone(snapshot.provenance),
      };
      const decision = await this.options.strategy({
        state: structuredClone(state),
        snapshot: decisionSnapshot,
        revealedResults: structuredClone(revealedResults),
      });
      try {
        state = applyGameweekDecision(state, decision, snapshot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to apply GW${gameweek} decision (${decision.transfers.length} transfers, chip ${decision.chip ?? 'none'}): ${message}`, { cause: error });
      }
      revealedResults.push({ gameweek, playerResults: structuredClone(snapshot.actualResults.playerResults) });
    }

    return state;
  }
}
