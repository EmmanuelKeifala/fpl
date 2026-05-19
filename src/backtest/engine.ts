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

    for (const gameweek of this.options.gameweeks) {
      const snapshot = await this.options.getSnapshot(gameweek);
      const decisionSnapshot = {
        season: snapshot.season,
        gameweek: snapshot.gameweek,
        deadline: snapshot.deadline,
        knownBeforeDeadline: snapshot.knownBeforeDeadline,
        provenance: snapshot.provenance,
      };
      const decision = await this.options.strategy({ state, snapshot: decisionSnapshot });
      state = applyGameweekDecision(state, decision, snapshot);
    }

    return state;
  }
}
